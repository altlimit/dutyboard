package worktree

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeedAnEmptyRepository(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	clone := filepath.Join(root, "clone")
	// A bare repository whose HEAD names master, as an older git or a host might make it.
	must(t, ctx, root, "init", "--quiet", "--bare", "-b", "master", remote)
	must(t, ctx, root, "clone", "--quiet", remote, clone)
	configure(t, ctx, clone)

	seeded, err := Seed(ctx, clone, "main", "Todo", "A todo app.")
	if err != nil || !seeded {
		t.Fatalf("an empty repository should be seeded: %v %v", seeded, err)
	}
	if got := must(t, ctx, remote, "log", "--format=%s", "main"); got != "Start Todo" {
		t.Fatalf("the first commit should be on the remote's main: %q", got)
	}
	if got := read(t, filepath.Join(clone, "README.md")); !strings.Contains(got, "# Todo") || !strings.Contains(got, "A todo app.") {
		t.Fatalf("the README should say what the project is: %q", got)
	}
	if got := DefaultBranch(ctx, clone, "origin"); got != "main" {
		t.Fatalf("the clone's remote HEAD should be main, got %q", got)
	}
	if !Fresh(ctx, clone, "origin/main") {
		t.Fatal("a repository holding only its README is fresh")
	}

	if again, err := Seed(ctx, clone, "main", "Todo", ""); err != nil || again {
		t.Fatalf("a repository with a commit is left alone: %v %v", again, err)
	}

	// A second machine's clone, made before the first pushed, finds the remote no longer empty.
	late := filepath.Join(root, "late")
	must(t, ctx, root, "init", "--quiet", "-b", "main", late)
	must(t, ctx, late, "remote", "add", "origin", remote)
	if seeded, err := Seed(ctx, late, "main", "Todo", ""); err != nil || seeded {
		t.Fatalf("a remote that already has a commit is not seeded again: %v %v", seeded, err)
	}

	write(t, filepath.Join(clone, "src", "main.go"), "package main\n")
	must(t, ctx, clone, "add", ".")
	must(t, ctx, clone, "commit", "--quiet", "-m", "code")
	if Fresh(ctx, clone, "HEAD") {
		t.Fatal("a repository with code in it is not fresh")
	}
}
