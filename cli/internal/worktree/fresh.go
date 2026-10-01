package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// A repository can start empty — made for a board that is building its project from nothing. Every
// worktree branches from the remote's default branch, which an empty repository does not have, so the
// first clone of one puts a commit there: a README saying what the project is.

// Seed gives the clone in dir its first commit, on branch, and pushes it — when neither the clone nor
// its remote has any commit yet. Answers whether it did. A remote that got its first commit from
// another machine meanwhile is left as it is.
func Seed(ctx context.Context, dir, branch, title, about string) (bool, error) {
	if _, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		return false, nil
	}
	remote := Remote(ctx, dir)
	if remote == "" {
		return false, errors.New("the clone has no remote to push its first commit to")
	}
	if heads, err := git(ctx, dir, "ls-remote", "--heads", remote); err != nil {
		return false, err
	} else if heads != "" {
		return false, nil
	}
	if branch == "" {
		branch = "main"
	}
	if _, err := git(ctx, dir, "symbolic-ref", "HEAD", "refs/heads/"+branch); err != nil {
		return false, err
	}
	readme := "# " + title + "\n"
	if about = strings.TrimSpace(about); about != "" {
		readme += "\n" + about + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o644); err != nil {
		return false, err
	}
	for _, args := range [][]string{
		{"add", "README.md"},
		{"commit", "--quiet", "-m", "Start " + title},
		{"push", "--quiet", "-u", remote, branch},
		{"remote", "set-head", remote, branch},
	} {
		if _, err := git(ctx, dir, args...); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Fresh reports whether ref holds nothing but what a new repository starts with — a README, a licence,
// git's own files — so a setup duty there builds the project's first version rather than reading one.
func Fresh(ctx context.Context, repo, ref string) bool {
	out, err := git(ctx, repo, "ls-tree", "-r", "--name-only", ref)
	if err != nil {
		return false
	}
	for _, f := range strings.Split(out, "\n") {
		if f == "" {
			continue
		}
		name := strings.ToLower(f)
		if strings.Contains(name, "/") {
			return false
		}
		if !(strings.HasPrefix(name, "readme") || strings.HasPrefix(name, "license") || strings.HasPrefix(name, "licence") ||
			name == ".gitignore" || name == ".gitattributes") {
			return false
		}
	}
	return true
}
