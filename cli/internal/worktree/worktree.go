// Package worktree gives every duty its own git worktree, on its own branch, in a folder named
// after the duty — and never touches the folder the project was linked from, which stays the
// person's to work in.
//
//	~/.dutyboard/worktrees/<board>/<duty-id>/     the duty's checkout, on duty/<duty-id>
//	~/.dutyboard/worktrees/<board>/.cache/        expensive ignored folders, handed duty to duty
//	~/.dutyboard/worktrees/<board>/.meta/<duty>   what was prepared, so prep runs only when needed
//
// A duty keeps its folder until it is finished. Parked for a decision, it waits with its edits and
// build output exactly as they were; answered, it resumes in the same place — which is also what
// lets `claude --resume` work, since Claude Code keeps conversations per folder.
package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Spec is everything about one duty's worktree that comes from its board.
type Spec struct {
	Repo   string // the linked folder: a git repository
	Board  string
	DutyID string
	// Base is the branch work starts from and integrates into; empty means the repository's default.
	Base string
	// Prep prepares a fresh checkout; PrepInputs are the files whose change means it must run again.
	Prep       string
	PrepInputs []string
	// Cache folders move from one finished duty's checkout to the next new one.
	Cache []string
	// Copy files come from CopyFrom — the board's local folder on this machine: what the project
	// needs that git does not carry, like an .env.
	Copy     []string
	CopyFrom string
}

// Branch is the duty's branch.
func (s Spec) Branch() string { return "duty/" + s.DutyID }

// Manager owns the worktrees folder.
type Manager struct {
	Root string
	// Log receives the output of git and prep commands worth keeping.
	Log io.Writer
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// Path is where a duty's worktree lives.
func (m *Manager) Path(board, duty string) string { return filepath.Join(m.Root, board, duty) }

func (m *Manager) cacheDir(board string) string { return filepath.Join(m.Root, board, ".cache") }
func (m *Manager) metaPath(board, duty string) string {
	return filepath.Join(m.Root, board, ".meta", duty+".json")
}

type meta struct {
	PrepHash string `json:"prep_hash"`
}

func (m *Manager) logf(format string, a ...any) {
	if m.Log != nil {
		fmt.Fprintf(m.Log, format+"\n", a...)
	}
}

// Remote is the repository's first remote ("origin" when there is one), or "" for a repository
// that has none — whose work then stays on its duty branch for a person to merge.
func Remote(ctx context.Context, repo string) string {
	out, err := git(ctx, repo, "remote")
	if err != nil || out == "" {
		return ""
	}
	names := strings.Fields(out)
	for _, n := range names {
		if n == "origin" {
			return n
		}
	}
	return names[0]
}

// DefaultBranch is the branch work integrates into when the profile does not say: the remote's
// HEAD, else the linked folder's current branch.
func DefaultBranch(ctx context.Context, repo, remote string) string {
	if remote != "" {
		if out, err := git(ctx, repo, "symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD"); err == nil {
			return strings.TrimPrefix(out, remote+"/")
		}
	}
	if out, err := git(ctx, repo, "symbolic-ref", "--short", "HEAD"); err == nil {
		return out
	}
	return "main"
}

// RepoOf is the repository a duty's existing worktree belongs to, or "" when it has none. A board
// whose repository changed keeps its duties in progress on the clone they started in.
func (m *Manager) RepoOf(ctx context.Context, board, duty string) string {
	path := m.Path(board, duty)
	if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
		return ""
	}
	common, err := git(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return ""
	}
	return filepath.Dir(common)
}

// Exists reports whether the duty already has a worktree.
func (m *Manager) Exists(s Spec) bool {
	_, err := os.Stat(filepath.Join(m.Path(s.Board, s.DutyID), ".git"))
	return err == nil
}

// Ensure answers the duty's worktree, creating it when it does not exist yet: from the duty's branch
// if there is one (a snapshot left by another machine is restored on top), else a new branch from
// the latest base. A new worktree takes the board's caches, gets the linked folder's untracked files
// the profile names, and runs prep when its inputs differ from what the caches were built from.
func (m *Manager) Ensure(ctx context.Context, s Spec) (path string, created bool, err error) {
	if !safeID.MatchString(s.Board) || !safeID.MatchString(s.DutyID) {
		return "", false, fmt.Errorf("refusing a worktree for board %q duty %q", s.Board, s.DutyID)
	}
	path = m.Path(s.Board, s.DutyID)
	if m.Exists(s) {
		return path, false, m.prepIfNeeded(ctx, s, path, false)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", false, err
	}

	remote := Remote(ctx, s.Repo)
	base := s.Base
	if base == "" {
		base = DefaultBranch(ctx, s.Repo, remote)
	}
	baseRef := base
	if remote != "" {
		if _, err := git(ctx, s.Repo, "fetch", "--quiet", remote); err != nil {
			m.logf("fetch failed, starting from what is here: %v", err)
		} else {
			baseRef = remote + "/" + base
		}
	}

	if _, err := git(ctx, s.Repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+s.Branch()); err == nil {
		if _, err := git(ctx, s.Repo, "worktree", "add", path, s.Branch()); err != nil {
			return "", false, err
		}
	} else {
		// The folder may be left from a worktree git no longer knows about; clear it so add can work.
		_, _ = git(ctx, s.Repo, "worktree", "prune")
		if _, err := git(ctx, s.Repo, "worktree", "add", "-b", s.Branch(), path, baseRef); err != nil {
			return "", false, err
		}
	}
	if remote != "" {
		m.restoreSnapshot(ctx, s, path, remote)
	}
	m.takeCaches(s, path)
	if err := m.copyFiles(s, path); err != nil {
		return path, true, err
	}
	return path, true, m.prepIfNeeded(ctx, s, path, true)
}

func (m *Manager) prepHash(s Spec, path string) string {
	h := sha256.New()
	fmt.Fprintln(h, s.Prep)
	for _, in := range s.PrepInputs {
		b, _ := os.ReadFile(filepath.Join(path, filepath.FromSlash(in)))
		fmt.Fprintf(h, "%s\x00%x\n", in, sha256.Sum256(b))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (m *Manager) prepIfNeeded(ctx context.Context, s Spec, path string, fresh bool) error {
	if s.Prep == "" {
		return nil
	}
	want := m.prepHash(s, path)
	var have meta
	if b, err := os.ReadFile(m.metaPath(s.Board, s.DutyID)); err == nil {
		_ = json.Unmarshal(b, &have)
	}
	if have.PrepHash == "" && fresh {
		// A fresh worktree inherits whatever the caches were last prepared for.
		if b, err := os.ReadFile(filepath.Join(m.cacheDir(s.Board), "meta.json")); err == nil {
			_ = json.Unmarshal(b, &have)
		}
	}
	if have.PrepHash == want {
		return nil
	}
	m.logf("prep: %s", s.Prep)
	out, err := Shell(ctx, path, s.Prep, nil)
	m.logf("%s", out)
	if err != nil {
		return &PrepError{Command: s.Prep, Output: tail(out, 2000), Err: err}
	}
	return m.writeMeta(s, meta{PrepHash: want})
}

// PrepError is a worktree that was made but whose prep command failed. The worktree is usable; what
// prep should have done is not there yet, and prep runs again next time.
type PrepError struct {
	Command, Output string
	Err             error
}

func (e *PrepError) Error() string {
	return fmt.Sprintf("preparing the worktree (%s) failed: %v\n%s", e.Command, e.Err, e.Output)
}

func (e *PrepError) Unwrap() error { return e.Err }

func (m *Manager) writeMeta(s Spec, v meta) error {
	p := m.metaPath(s.Board, s.DutyID)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(v)
	return os.WriteFile(p, b, 0o644)
}

// cacheName flattens a project path into one folder name under .cache.
func cacheName(p string) string { return strings.ReplaceAll(p, "/", "__") }

func (m *Manager) takeCaches(s Spec, path string) {
	for _, c := range s.Cache {
		from := filepath.Join(m.cacheDir(s.Board), cacheName(c))
		if _, err := os.Stat(from); err != nil {
			continue
		}
		to := filepath.Join(path, filepath.FromSlash(c))
		if _, err := os.Stat(to); err == nil {
			continue // the checkout already has one (it is tracked, or a snapshot brought it)
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err == nil {
			if err := os.Rename(from, to); err == nil {
				m.logf("cache: took %s", c)
			}
		}
	}
}

// returnCaches moves a finished duty's caches back for the next one. A cache already waiting there
// came from a duty that finished more recently, and is kept.
func (m *Manager) returnCaches(s Spec, path string) {
	moved := false
	for _, c := range s.Cache {
		from := filepath.Join(path, filepath.FromSlash(c))
		if _, err := os.Stat(from); err != nil {
			continue
		}
		to := filepath.Join(m.cacheDir(s.Board), cacheName(c))
		if _, err := os.Stat(to); err == nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err == nil && os.Rename(from, to) == nil {
			moved = true
		}
	}
	if moved {
		if b, err := os.ReadFile(m.metaPath(s.Board, s.DutyID)); err == nil {
			_ = os.WriteFile(filepath.Join(m.cacheDir(s.Board), "meta.json"), b, 0o644)
		}
	}
}

func (m *Manager) copyFiles(s Spec, path string) error {
	if s.CopyFrom == "" {
		return nil
	}
	for _, c := range s.Copy {
		from := filepath.Join(s.CopyFrom, filepath.FromSlash(c))
		info, err := os.Stat(from)
		if err != nil {
			m.logf("copy: %s is not in %s, skipped", c, s.CopyFrom)
			continue
		}
		to := filepath.Join(path, filepath.FromSlash(c))
		if info.IsDir() {
			if err := os.CopyFS(to, os.DirFS(from)); err != nil && !errors.Is(err, os.ErrExist) {
				return fmt.Errorf("copying %s: %w", c, err)
			}
			continue
		}
		b, err := os.ReadFile(from)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(to, b, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

// Remove deletes a finished duty's worktree and branch, after handing its caches back. keepBranch
// leaves the branch — for a repository with no remote, where that branch is the work.
func (m *Manager) Remove(ctx context.Context, s Spec, keepBranch bool) error {
	path := m.Path(s.Board, s.DutyID)
	if m.Exists(s) {
		m.returnCaches(s, path)
		if _, err := git(ctx, s.Repo, "worktree", "remove", "--force", path); err != nil {
			m.logf("worktree remove: %v", err)
			_ = os.RemoveAll(path)
			_, _ = git(ctx, s.Repo, "worktree", "prune")
		}
	}
	if !keepBranch {
		_, _ = git(ctx, s.Repo, "branch", "-D", s.Branch())
		if remote := Remote(ctx, s.Repo); remote != "" {
			// The snapshot ref, if one was ever pushed. Best-effort: a remote that refuses leaves a
			// ref nothing reads again.
			_, _ = git(ctx, s.Repo, "push", "--quiet", remote, ":refs/dutyboard/wip/"+s.DutyID)
		}
	}
	_ = os.Remove(m.metaPath(s.Board, s.DutyID))
	return nil
}

// Snapshot pushes the worktree's whole state — committed, staged, modified and untracked, minus what
// .gitignore excludes — to refs/dutyboard/wip/<duty> on the remote, without moving the branch. It is
// how another machine resumes a parked duty whose folder is on this one.
func (m *Manager) Snapshot(ctx context.Context, s Spec) error {
	path := m.Path(s.Board, s.DutyID)
	remote := Remote(ctx, s.Repo)
	if remote == "" {
		return nil
	}
	index, err := os.CreateTemp("", "dutyboard-index-*")
	if err != nil {
		return err
	}
	index.Close()
	defer os.Remove(index.Name())
	env := []string{"GIT_INDEX_FILE=" + index.Name()}
	if _, err := gitEnv(ctx, path, env, "read-tree", "HEAD"); err != nil {
		return err
	}
	if _, err := gitEnv(ctx, path, env, "add", "-A"); err != nil {
		return err
	}
	tree, err := gitEnv(ctx, path, env, "write-tree")
	if err != nil {
		return err
	}
	commit, err := gitEnv(ctx, path, []string{
		"GIT_AUTHOR_NAME=dutyboard", "GIT_AUTHOR_EMAIL=dutyboard@localhost",
		"GIT_COMMITTER_NAME=dutyboard", "GIT_COMMITTER_EMAIL=dutyboard@localhost",
	}, "commit-tree", tree, "-p", "HEAD", "-m", "wip: "+s.DutyID)
	if err != nil {
		return err
	}
	_, err = git(ctx, path, "push", "--quiet", "--force", remote, commit+":refs/dutyboard/wip/"+s.DutyID)
	return err
}

func (m *Manager) restoreSnapshot(ctx context.Context, s Spec, path, remote string) {
	ref := "refs/dutyboard/wip/" + s.DutyID
	if _, err := git(ctx, path, "fetch", "--quiet", remote, "+"+ref+":"+ref); err != nil {
		return // no snapshot: the common case
	}
	if _, err := git(ctx, path, "restore", "--source="+ref, "--worktree", "--", "."); err != nil {
		m.logf("restoring the snapshot of %s failed: %v", s.DutyID, err)
		return
	}
	m.logf("restored the snapshot another machine left for %s", s.DutyID)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
