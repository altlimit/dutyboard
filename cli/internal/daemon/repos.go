package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/prompt"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// A board can have repositories besides its main one. A duty always has a worktree of the main
// repository — where its session runs — and opens a worktree of any other one it needs, beside it,
// on the same duty branch: when a person or an agent asks (duty_repo_open), or all of them for a
// setup duty. Integrating lands every opened repository in the board's order.

func boardRepos(v board.BoardView) []board.Repo {
	if v.Profile == nil {
		return nil
	}
	return v.Profile.Repos
}

func findRepo(v board.BoardView, name string) (board.Repo, bool) {
	for _, r := range boardRepos(v) {
		if r.Name == name {
			return r, true
		}
	}
	return board.Repo{}, false
}

// repoSpec is a duty's worktree of one of the board's other repositories.
func (d *Daemon) repoSpec(ctx context.Context, boardID, duty string, r board.Repo) worktree.Spec {
	s := worktree.Spec{Board: boardID, DutyID: duty, Name: r.Name, CopyFrom: filepath.Join(d.localDir(boardID), r.Name)}
	if repo := d.wt.RepoOfSpec(ctx, s); repo != "" {
		s.Repo = repo // a duty already under way stays on the clone it started in
	} else {
		s.Repo = d.folder(workspaceKey(boardID, r.Name))
	}
	s.Base = r.DefaultBranch
	s.Prep, s.PrepInputs, s.Cache, s.Copy = r.Worktree.Prep, r.Worktree.PrepInputs, r.Worktree.Cache, r.Worktree.Copy
	return s
}

func (r *Run) openRepos() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.opened...)
}

func (r *Run) isOpen(name string) bool {
	for _, n := range r.openRepos() {
		if n == name {
			return true
		}
	}
	return false
}

func (r *Run) markOpen(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, n := range r.opened {
		if n == name {
			return
		}
	}
	r.opened = append(r.opened, name)
}

// openRepo makes the duty's worktree of one of the board's other repositories, if it has none, and
// remembers it for the duty, so a resumed session has it again. A failed prep leaves the worktree
// usable and says what failed.
func (d *Daemon) openRepo(ctx context.Context, run *Run, v board.BoardView, name string) (path, prepFailed string, err error) {
	r, ok := findRepo(v, name)
	if !ok {
		names := []string{}
		for _, x := range boardRepos(v) {
			names = append(names, x.Name)
		}
		return "", "", fmt.Errorf("this board has no repository named %q (it has: %v)", name, names)
	}
	spec := d.repoSpec(ctx, run.Board, run.DutyID, r)
	if spec.Repo == "" {
		return "", "", fmt.Errorf("repository %q is not cloned on this machine yet", name)
	}
	path, _, err = d.wt.Ensure(ctx, spec)
	var prepErr *worktree.PrepError
	switch {
	case errors.As(err, &prepErr) && path != "":
		prepFailed = fmt.Sprintf("Command: %s\nError: %v\nOutput (tail):\n%s", prepErr.Command, prepErr.Err, prepErr.Output)
	case err != nil:
		return "", "", err
	}
	run.markOpen(name)
	records, _ := state.RunRecords()
	if rec, ok := records[run.DutyID]; ok {
		rec.Repos = run.openRepos()
		_ = state.SaveRunRecord(run.DutyID, &rec)
	}
	return path, prepFailed, nil
}

// repoPlaceholders makes the folders every other repository's worktree will be in, so a session can
// be told it may work there before any is opened — an agent's allowed folders are fixed when it
// starts. Answers them in the board's order.
func (d *Daemon) repoPlaceholders(ctx context.Context, run *Run, v board.BoardView) []string {
	var dirs []string
	for _, r := range boardRepos(v) {
		dir := d.wt.PathOf(d.repoSpec(ctx, run.Board, run.DutyID, r))
		if err := os.MkdirAll(dir, 0o755); err == nil {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// promptRepos describes the board's other repositories to a session.
func (d *Daemon) promptRepos(ctx context.Context, run *Run, v board.BoardView) []prompt.Repo {
	var out []prompt.Repo
	for _, r := range boardRepos(v) {
		out = append(out, prompt.Repo{
			Name: r.Name, URL: r.RepoURL, Path: d.wt.PathOf(d.repoSpec(ctx, run.Board, run.DutyID, r)),
			Open: run.isOpen(r.Name), TestCommand: r.TestCommand,
		})
	}
	return out
}

// repoWritable are the other repositories' git folders, which a sandboxed agent must be able to write
// to commit in their worktrees.
func (d *Daemon) repoWritable(v board.BoardView) []string {
	var out []string
	for _, r := range boardRepos(v) {
		if dir := d.folder(workspaceKey(v.ProjectID, r.Name)); dir != "" {
			out = append(out, filepath.Join(dir, ".git"))
		}
	}
	return out
}

// removeRepos removes the duty's worktrees of the board's other repositories, and the folders left
// for ones it never opened.
func (d *Daemon) removeRepos(ctx context.Context, run *Run, v board.BoardView, keepBranch bool) {
	for _, r := range boardRepos(v) {
		spec := d.repoSpec(ctx, run.Board, run.DutyID, r)
		if run.isOpen(r.Name) || d.wt.Exists(spec) {
			_ = d.wt.Remove(ctx, spec, keepBranch)
		}
		_ = os.Remove(d.wt.PathOf(spec)) // an unopened placeholder, empty
	}
}

// snapshotRepos snapshots the duty's opened repositories, as the main one is when it parks.
func (d *Daemon) snapshotRepos(ctx context.Context, run *Run, v board.BoardView) {
	for _, name := range run.openRepos() {
		if r, ok := findRepo(v, name); ok {
			spec := d.repoSpec(ctx, run.Board, run.DutyID, r)
			if d.wt.Exists(spec) {
				if err := d.wt.Snapshot(ctx, spec); err != nil {
					d.log.Printf("snapshotting %s (%s) for another machine: %v", run.DutyID, name, err)
				}
			}
		}
	}
}

// RepoResult is one repository's integration, in duty_integrate's answer for a board with several.
type RepoResult struct {
	Repo string `json:"repo"`
	*worktree.Result
}

// integrateAll lands the main repository, then each opened one in the board's order, stopping at the
// first that does not land. Repositories already landed come back as nothing to integrate, so calling
// it again after fixing one carries on where it stopped. Answers the main repository's result and
// every repository's.
func (d *Daemon) integrateAll(ctx context.Context, run *Run, v board.BoardView) (*worktree.Result, []RepoResult, error) {
	opts := worktree.IntegrateOptions{Mode: modeFor(ctx, v, run.Spec), Title: run.Title, Body: "DutyBoard duty " + run.DutyID}
	if v.Profile != nil {
		opts.TestCommand = v.Profile.TestCommand
	}
	main, err := d.wt.Integrate(ctx, run.Spec, d.lock(run.Board), opts)
	if err != nil {
		return nil, nil, err
	}
	results := []RepoResult{{Repo: "", Result: main}}
	if !main.OK {
		return main, results, nil
	}
	for _, r := range boardRepos(v) {
		if !run.isOpen(r.Name) {
			continue
		}
		spec := d.repoSpec(ctx, run.Board, run.DutyID, r)
		o := opts
		o.Mode, o.TestCommand = modeFor(ctx, v, spec), r.TestCommand
		res, err := d.wt.Integrate(ctx, spec, d.lock(workspaceKey(run.Board, r.Name)), o)
		if err != nil {
			return main, results, fmt.Errorf("repository %q: %w", r.Name, err)
		}
		results = append(results, RepoResult{Repo: r.Name, Result: res})
		if !res.OK {
			return main, results, nil
		}
	}
	return main, results, nil
}
