package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Mode is how finished work reaches the project.
type Mode string

const (
	// ModePush rebases onto the base branch, tests, and pushes to it.
	ModePush Mode = "push"
	// ModeSquash is ModePush with the duty's commits made into one, named for the duty, first.
	ModeSquash Mode = "squash"
	// ModePR pushes the duty branch and opens a pull request.
	ModePR Mode = "pr"
	// ModeBranch leaves the work on its duty branch — a repository with no remote to push to.
	ModeBranch Mode = "branch"
)

// Result is what an integration did, or why it could not.
type Result struct {
	OK      bool   `json:"ok"`
	Mode    Mode   `json:"mode"`
	Commit  string `json:"commit,omitempty"`
	Branch  string `json:"branch,omitempty"`
	PR      string `json:"pr,omitempty"`
	NoOp    bool   `json:"no_op,omitempty"`
	Message string `json:"message"`
	// Conflicts are files a rebase could not merge; resolve them, `git add`, `git rebase --continue`,
	// and integrate again.
	Conflicts []string `json:"conflicts,omitempty"`
	// TestOutput is the tail of a failing test run.
	TestOutput string `json:"test_output,omitempty"`
}

// Lock serialises integration on one board: two duties rebasing and pushing to the same branch at
// once is how one of them pushes a merge nobody tested.
//
// It is held across calls by the duty whose rebase stopped on conflicts, so nobody else moves the
// base branch while that duty is resolving them — for at most `hold`, so a session that dies
// mid-rebase does not stop the board.
type Lock struct {
	mu     sync.Mutex
	holder string
	until  time.Time
}

const hold = 20 * time.Minute

// Acquire waits until duty may integrate, or ctx ends.
func (l *Lock) Acquire(ctx context.Context, duty string) error {
	for {
		l.mu.Lock()
		if l.holder == "" || l.holder == duty || time.Now().After(l.until) {
			l.holder, l.until = duty, time.Now().Add(hold)
			l.mu.Unlock()
			return nil
		}
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// Release lets the next duty integrate.
func (l *Lock) Release(duty string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == duty {
		l.holder = ""
	}
}

// IntegrateOptions are the board's settings for one integration.
type IntegrateOptions struct {
	Mode        Mode
	TestCommand string
	Title       string // a pull request's title, or a squashed commit's subject
	Body        string // a pull request's body, or a line at the end of a squashed commit's message
}

// Integrate lands a duty's committed work: on the base branch (push), in a pull request (pr), or on
// its own branch when there is nowhere to push (branch). The worktree must be clean — uncommitted
// work is refused, not swept in, because what lands should be exactly what the session meant to
// commit.
func (m *Manager) Integrate(ctx context.Context, s Spec, lock *Lock, o IntegrateOptions) (*Result, error) {
	path := m.Path(s.Board, s.DutyID)
	if !m.Exists(s) {
		return nil, fmt.Errorf("duty %s has no worktree", s.DutyID)
	}
	if rebasing(ctx, path) {
		conflicts := unmerged(ctx, path)
		if len(conflicts) > 0 {
			return &Result{Mode: o.Mode, Conflicts: conflicts, Message: "a rebase is still stopped on conflicts: resolve them, `git add` them, `git rebase --continue`, then integrate again"}, nil
		}
		return &Result{Mode: o.Mode, Message: "a rebase is in progress with nothing left to resolve: run `git rebase --continue`, then integrate again"}, nil
	}
	if dirty, _ := git(ctx, path, "status", "--porcelain"); dirty != "" {
		return &Result{Mode: o.Mode, Message: "the worktree has uncommitted changes — commit what belongs to this duty (and discard what does not), then integrate again:\n" + tail(dirty, 1500)}, nil
	}

	remote := Remote(ctx, s.Repo)
	mode := o.Mode
	if mode == "" {
		mode = ModePush
	}
	if remote == "" {
		mode = ModeBranch
	}
	base := s.Base
	if base == "" {
		base = DefaultBranch(ctx, s.Repo, remote)
	}
	head, _ := git(ctx, path, "rev-parse", "HEAD")

	if mode == ModeBranch {
		baseHead, _ := git(ctx, path, "rev-parse", base)
		ahead, _ := git(ctx, path, "rev-list", "--count", base+"..HEAD")
		if ahead == "0" || head == baseHead {
			return &Result{OK: true, Mode: mode, NoOp: true, Message: "nothing to integrate: no commits on this duty"}, nil
		}
		return &Result{OK: true, Mode: mode, Branch: s.Branch(), Commit: head,
			Message: fmt.Sprintf("this repository has no remote, so the work stays on branch %s (at %.12s) for a person to merge into %s", s.Branch(), head, base)}, nil
	}

	if _, err := git(ctx, path, "fetch", "--quiet", remote); err != nil {
		return nil, err
	}
	target := remote + "/" + base
	if ahead, _ := git(ctx, path, "rev-list", "--count", target+"..HEAD"); ahead == "0" {
		return &Result{OK: true, Mode: mode, NoOp: true, Message: "nothing to integrate: no commits on this duty that " + target + " does not already have"}, nil
	}

	if mode == ModePR {
		return m.openPR(ctx, s, path, remote, base, o)
	}

	if err := lock.Acquire(ctx, s.DutyID); err != nil {
		return nil, err
	}
	release := true
	defer func() {
		if release {
			lock.Release(s.DutyID)
		}
	}()

	for attempt := 1; ; attempt++ {
		if _, err := git(ctx, path, "rebase", target); err != nil {
			if conflicts := unmerged(ctx, path); len(conflicts) > 0 {
				release = false // keep the base still while this duty resolves
				return &Result{Mode: mode, Conflicts: conflicts,
					Message: fmt.Sprintf("rebasing onto %s stopped on conflicts: resolve them, `git add` them, `git rebase --continue`, then integrate again", target)}, nil
			}
			return nil, err
		}
		if o.TestCommand != "" {
			out, err := Shell(ctx, path, o.TestCommand, nil)
			if err != nil {
				return &Result{Mode: mode, TestOutput: tail(out, 4000),
					Message: fmt.Sprintf("the test command (%s) failed after rebasing onto %s: fix it, commit, and integrate again", o.TestCommand, target)}, nil
			}
		}
		if mode == ModeSquash {
			// After the tests, so a failure leaves the session's own commits to fix on top of.
			squashed, err := squash(ctx, path, target, o)
			if err != nil {
				return nil, err
			}
			if !squashed {
				return &Result{OK: true, Mode: mode, NoOp: true, Message: "nothing to integrate: " + target + " already has everything this duty changed"}, nil
			}
		}
		_, err := git(ctx, path, "push", "--quiet", remote, "HEAD:refs/heads/"+base)
		if err == nil {
			break
		}
		// Someone pushed between our fetch and our push. Take their work and go round again — a few
		// times, not forever.
		if attempt >= 3 || !strings.Contains(err.Error(), "rejected") && !strings.Contains(err.Error(), "fetch first") {
			return nil, err
		}
		if _, err := git(ctx, path, "fetch", "--quiet", remote); err != nil {
			return nil, err
		}
	}
	commit, _ := git(ctx, path, "rev-parse", "HEAD")
	return &Result{OK: true, Mode: mode, Commit: commit, Message: fmt.Sprintf("pushed %.12s to %s", commit, base)}, nil
}

func (m *Manager) openPR(ctx context.Context, s Spec, path, remote, base string, o IntegrateOptions) (*Result, error) {
	if _, err := git(ctx, path, "push", "--quiet", "--force-with-lease", "-u", remote, "HEAD:refs/heads/"+s.Branch()); err != nil {
		return nil, err
	}
	commit, _ := git(ctx, path, "rev-parse", "HEAD")
	res := &Result{OK: true, Mode: ModePR, Branch: s.Branch(), Commit: commit}

	if gh, err := exec.LookPath("gh"); err == nil {
		title := o.Title
		if title == "" {
			title = s.DutyID
		}
		// An existing pull request for the branch is reused: integrating again after a fix pushes to
		// it rather than opening a second one.
		if url := runGH(ctx, gh, path, "pr", "view", s.Branch(), "--json", "url", "-q", ".url"); url != "" {
			res.PR, res.Message = url, "pull request updated: "+url
			return res, nil
		}
		if url := runGH(ctx, gh, path, "pr", "create", "--base", base, "--head", s.Branch(), "--title", title, "--body", o.Body); url != "" {
			res.PR, res.Message = url, "pull request: "+url
			return res, nil
		}
		m.logf("gh could not open the pull request for %s", s.Branch())
	}
	res.Message = fmt.Sprintf("pushed branch %s; open a pull request into %s", s.Branch(), base)
	if url, _ := git(ctx, s.Repo, "remote", "get-url", remote); url != "" {
		if web := githubWeb(url); web != "" {
			res.PR = fmt.Sprintf("%s/compare/%s...%s?expand=1", web, base, s.Branch())
			res.Message = "pushed; open the pull request at " + res.PR
		}
	}
	return res, nil
}

func rebasing(ctx context.Context, path string) bool {
	for _, p := range []string{"rebase-merge", "rebase-apply"} {
		if dir, err := git(ctx, path, "rev-parse", "--git-path", p); err == nil {
			if !strings.HasPrefix(dir, "/") {
				dir = path + string(os.PathSeparator) + dir
			}
			if _, err := os.Stat(dir); err == nil {
				return true
			}
		}
	}
	return false
}

func unmerged(ctx context.Context, path string) []string {
	out, err := git(ctx, path, "diff", "--name-only", "--diff-filter=U")
	if err != nil || out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

var urlRe = regexp.MustCompile(`https://\S+`)

func lastURL(s string) string {
	all := urlRe.FindAllString(s, -1)
	if len(all) == 0 {
		return ""
	}
	return all[len(all)-1]
}

var ghRemote = regexp.MustCompile(`github\.com[:/]([^/]+)/(.+?)(\.git)?$`)

func githubWeb(remoteURL string) string {
	m := ghRemote.FindStringSubmatch(strings.TrimSpace(remoteURL))
	if m == nil {
		return ""
	}
	return "https://github.com/" + m[1] + "/" + m[2]
}

func runGH(ctx context.Context, gh, dir string, args ...string) string {
	cmd := exec.CommandContext(ctx, gh, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return lastURL(string(out))
}

// ErrNotARepo is a linked folder that is not a git repository.
var ErrNotARepo = errors.New("not a git repository")

// Toplevel is the root of the repository dir is in.
func Toplevel(ctx context.Context, dir string) (string, error) {
	out, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", ErrNotARepo
	}
	return out, nil
}

// squash makes everything on the branch since target one commit: the duty's title as its subject,
// the commits it replaces listed under it, and the body's line last. Answers false when, rebased,
// the branch changes nothing target does not already have.
func squash(ctx context.Context, path, target string, o IntegrateOptions) (bool, error) {
	subjects, _ := git(ctx, path, "log", "--reverse", "--format=%s", target+"..HEAD")
	if _, err := git(ctx, path, "reset", "--soft", target); err != nil {
		return false, err
	}
	if _, err := git(ctx, path, "diff", "--cached", "--quiet"); err == nil {
		return false, nil
	}
	subject := strings.TrimSpace(o.Title)
	if subject == "" {
		subject = "Work from DutyBoard"
	}
	var msg strings.Builder
	msg.WriteString(subject + "\n")
	if lines := strings.Split(strings.TrimSpace(subjects), "\n"); len(lines) > 1 || (len(lines) == 1 && lines[0] != "" && lines[0] != subject) {
		msg.WriteString("\n")
		for _, l := range lines {
			if l = strings.TrimSpace(l); l != "" {
				msg.WriteString("- " + l + "\n")
			}
		}
	}
	if o.Body != "" {
		msg.WriteString("\n" + o.Body + "\n")
	}
	if _, err := gitEnv(ctx, path, nil, "commit", "--quiet", "--no-verify", "-m", msg.String()); err != nil {
		return false, err
	}
	return true, nil
}
