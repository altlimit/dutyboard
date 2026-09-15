package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/deploy"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// A board's folder on this machine, all of it the daemon's own:
//
//	<projects root>/<board>/<repo>-<hash>/   its clone of the board's repository
//	<projects root>/<board>/local/           files the project needs that git does not carry
//
// The daemon never works in, or adds branches to, a checkout a person uses. The clone is named after
// the repository URL, so pointing a board at another repository makes a new clone next to the old
// one, and duties still in progress on the old one finish there.

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func cloneDirName(url string) string {
	base := strings.TrimSuffix(filepath.Base(strings.TrimRight(strings.ReplaceAll(url, ":", "/"), "/")), ".git")
	base = unsafeName.ReplaceAllString(base, "-")
	if base == "" || base == "." {
		base = "repo"
	}
	sum := sha256.Sum256([]byte(url))
	return base + "-" + hex.EncodeToString(sum[:])[:6]
}

func (d *Daemon) boardDir(boardID string) string {
	return filepath.Join(ProjectsRoot(d.opt.Config), boardID)
}

// LocalDir is where a board's untracked files live on this machine.
func (d *Daemon) localDir(boardID string) string { return filepath.Join(d.boardDir(boardID), "local") }

// ensureWorkspaces makes sure every linked board has its clone, with the board's git settings, and
// records what stops a board being worked. Answers nothing: problems are reported, not returned.
func (d *Daemon) ensureWorkspaces(ctx context.Context) {
	d.mu.Lock()
	views := make([]board.BoardView, 0, len(d.views))
	for _, v := range d.views {
		views = append(views, v)
	}
	d.mu.Unlock()
	for _, v := range views {
		problem := ""
		if err := d.agentReady(ctx, v); err != nil {
			problem = err.Error()
		} else if _, err := d.ensureClone(ctx, v); err != nil {
			problem = err.Error()
		} else if v.Profile != nil && v.Profile.Git.Mode == "pr" && !d.ghReady(ctx, d.folder(v.ProjectID)) {
			problem = "this board opens pull requests, and the GitHub CLI (gh) is not installed or signed in on this machine — run `gh auth login`"
		}
		d.setProblem(ctx, v.ProjectID, problem)
		d.setNotice(ctx, v.ProjectID, d.deployNotice(ctx, v))
	}
}

func (d *Daemon) setNotice(ctx context.Context, boardID, notice string) {
	d.mu.Lock()
	changed := d.notices[boardID] != notice
	d.notices[boardID] = notice
	d.mu.Unlock()
	if changed {
		if notice != "" {
			d.log.Printf("%s: %s", boardID, notice)
		}
		d.report(ctx, boardID)
	}
}

func (d *Daemon) setProblem(ctx context.Context, boardID, problem string) {
	d.mu.Lock()
	changed := d.problems[boardID] != problem
	d.problems[boardID] = problem
	d.mu.Unlock()
	if changed {
		if problem != "" {
			d.log.Printf("%s: %s", boardID, problem)
		}
		d.report(ctx, boardID)
	}
}

func (d *Daemon) problem(boardID string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.problems[boardID]
}

// ensureClone answers the board's clone, making it when it is missing.
func (d *Daemon) ensureClone(ctx context.Context, v board.BoardView) (string, error) {
	if v.Profile == nil || v.Profile.RepoURL == "" {
		return "", fmt.Errorf("the board has no repository URL — set one in its settings")
	}
	url := v.Profile.RepoURL
	dir := filepath.Join(d.boardDir(v.ProjectID), cloneDirName(url))
	if err := os.MkdirAll(d.localDir(v.ProjectID), 0o755); err != nil {
		return "", err
	}
	if top, err := worktree.Toplevel(ctx, dir); err != nil || filepath.Clean(top) != filepath.Clean(dir) {
		if _, statErr := os.Stat(dir); statErr == nil {
			_ = os.RemoveAll(dir) // a clone that failed half way
		}
		d.log.Printf("%s: cloning %s", v.ProjectID, url)
		args := []string{"clone", "--quiet"}
		if v.Profile.Git.SSHCommand != "" {
			args = append([]string{"-c", "core.sshCommand=" + v.Profile.Git.SSHCommand}, args...)
		}
		cctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(cctx, "git", append(args, url, dir)...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("could not clone %s: %s", url, lastLine(string(out), err))
		}
	}
	if err := applyGitSettings(ctx, dir, v); err != nil {
		return "", err
	}

	previous := d.folder(v.ProjectID)
	if filepath.Clean(previous) != filepath.Clean(dir) {
		if err := state.SetWorkspace(v.ProjectID, dir); err != nil {
			return "", err
		}
		d.mu.Lock()
		d.workspaces[v.ProjectID] = dir
		d.mu.Unlock()
		if previous != "" {
			d.retireClone(ctx, previous)
		}
	}
	return dir, nil
}

// applyGitSettings writes the board's commit author and SSH command into the clone's own config, and
// removes them when the board no longer sets them, so the machine user's identity applies again.
func applyGitSettings(ctx context.Context, dir string, v board.BoardView) error {
	set := func(key, value string) error {
		var cmd *exec.Cmd
		if value == "" {
			cmd = exec.CommandContext(ctx, "git", "-C", dir, "config", "--local", "--unset-all", key)
			_ = cmd.Run() // unsetting what is not set fails, and is fine
			return nil
		}
		cmd = exec.CommandContext(ctx, "git", "-C", dir, "config", "--local", key, value)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("setting %s on the clone: %s", key, lastLine(string(out), err))
		}
		return nil
	}
	g := v.Profile.Git
	for _, kv := range [][2]string{{"user.name", g.AuthorName}, {"user.email", g.AuthorEmail}, {"core.sshCommand", g.SSHCommand}} {
		if err := set(kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}

// retireClone removes a clone the board no longer uses, once no duty's worktree still needs it.
func (d *Daemon) retireClone(ctx context.Context, dir string) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return
	}
	if strings.Count(string(out), "worktree ") > 1 {
		d.log.Printf("keeping %s until the duties working in it finish", dir)
		return
	}
	if err := os.RemoveAll(dir); err == nil {
		d.log.Printf("removed %s, which the board no longer uses", dir)
	}
}

// agentReady says why this machine cannot run the agent a board's duties are worked by, if it cannot:
// a board is not worked by a machine that would only fail every duty it claimed.
func (d *Daemon) agentReady(ctx context.Context, v board.BoardView) error {
	agent, err := runner.For(agentName(v))
	if err != nil {
		return err
	}
	return agent.Check(ctx)
}

// ghReady reports whether the GitHub CLI is signed in, remembered for a few minutes.
func (d *Daemon) ghReady(ctx context.Context, repo string) bool {
	d.mu.Lock()
	if time.Since(d.ghCheckedAt) < 5*time.Minute {
		ok := d.ghOK
		d.mu.Unlock()
		return ok
	}
	d.mu.Unlock()
	ok := deploy.Available(ctx, repo)
	d.mu.Lock()
	d.ghOK, d.ghCheckedAt = ok, time.Now()
	d.mu.Unlock()
	return ok
}

func lastLine(out string, err error) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if l := strings.TrimSpace(lines[len(lines)-1]); l != "" {
		return l
	}
	return err.Error()
}
