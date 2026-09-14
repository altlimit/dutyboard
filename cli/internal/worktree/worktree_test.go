package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// repoWithRemote makes a bare "remote" and a clone of it — the linked folder — with one commit on
// main, and answers the linked folder and the remote.
func repoWithRemote(t *testing.T) (linked, remote string) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	remote = filepath.Join(root, "remote.git")
	linked = filepath.Join(root, "linked")
	must(t, ctx, root, "init", "--quiet", "--bare", "-b", "main", remote)
	must(t, ctx, root, "clone", "--quiet", remote, linked)
	configure(t, ctx, linked)
	write(t, filepath.Join(linked, ".gitignore"), "node_modules/\n.prepped\n.env\n")
	write(t, filepath.Join(linked, "app.txt"), "one\ntwo\nthree\n")
	must(t, ctx, linked, "add", ".")
	must(t, ctx, linked, "commit", "--quiet", "-m", "start")
	must(t, ctx, linked, "push", "--quiet", "origin", "HEAD:main")
	must(t, ctx, linked, "remote", "set-head", "origin", "main")
	return linked, remote
}

func configure(t *testing.T, ctx context.Context, dir string) {
	must(t, ctx, dir, "config", "user.email", "test@example.com")
	must(t, ctx, dir, "config", "user.name", "test")
}

func must(t *testing.T, ctx context.Context, dir string, args ...string) string {
	t.Helper()
	out, err := git(ctx, dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func commitIn(t *testing.T, dir, file, content, msg string) {
	t.Helper()
	ctx := context.Background()
	configure(t, ctx, dir)
	write(t, filepath.Join(dir, file), content)
	must(t, ctx, dir, "add", file)
	must(t, ctx, dir, "commit", "--quiet", "-m", msg)
}

func TestEnsurePreparesAndHandsCachesOn(t *testing.T) {
	ctx := context.Background()
	linked, _ := repoWithRemote(t)
	write(t, filepath.Join(linked, ".env"), "SECRET=local\n")
	m := &Manager{Root: t.TempDir()}
	spec := func(duty string) Spec {
		return Spec{
			Repo: linked, Board: "game", DutyID: duty,
			Prep: "mkdir -p node_modules && echo built >> node_modules/count && touch .prepped", PrepInputs: []string{"app.txt"},
			Cache: []string{"node_modules"}, Copy: []string{".env"},
		}
	}

	path, created, err := m.Ensure(ctx, spec("duty_A"))
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	if branch := must(t, ctx, path, "symbolic-ref", "--short", "HEAD"); branch != "duty/duty_A" {
		t.Fatalf("worktree is on %q", branch)
	}
	if read(t, filepath.Join(path, ".env")) != "SECRET=local\n" {
		t.Fatal("the linked folder's untracked file was not copied")
	}
	if strings.Count(read(t, filepath.Join(path, "node_modules", "count")), "built") != 1 {
		t.Fatal("prep did not run exactly once on a fresh worktree")
	}
	if _, again, _ := m.Ensure(ctx, spec("duty_A")); again {
		t.Fatal("an existing worktree was created again")
	}
	if strings.Count(read(t, filepath.Join(path, "node_modules", "count")), "built") != 1 {
		t.Fatal("prep ran again with nothing changed")
	}

	if err := m.Remove(ctx, spec("duty_A"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the finished duty's worktree is still there")
	}
	if _, err := git(ctx, linked, "rev-parse", "--verify", "refs/heads/duty/duty_A"); err == nil {
		t.Fatal("the finished duty's branch is still there")
	}

	next, _, err := m.Ensure(ctx, spec("duty_B"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(read(t, filepath.Join(next, "node_modules", "count")), "built") != 1 {
		t.Fatal("the next duty should inherit the prepared cache without running prep again")
	}
}

func TestIntegratePushesAndRefusesUncommittedWork(t *testing.T) {
	ctx := context.Background()
	linked, remote := repoWithRemote(t)
	m := &Manager{Root: t.TempDir()}
	s := Spec{Repo: linked, Board: "web", DutyID: "duty_P"}
	path, _, err := m.Ensure(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	lock := &Lock{}

	if res, err := m.Integrate(ctx, s, lock, IntegrateOptions{Mode: ModePush}); err != nil || !res.NoOp {
		t.Fatalf("with no commits integration should be a no-op: %+v %v", res, err)
	}
	write(t, filepath.Join(path, "new.txt"), "hello")
	if res, _ := m.Integrate(ctx, s, lock, IntegrateOptions{Mode: ModePush}); res.OK {
		t.Fatal("uncommitted work was integrated")
	}
	commitIn(t, path, "new.txt", "hello", "add new")

	res, err := m.Integrate(ctx, s, lock, IntegrateOptions{Mode: ModePush, TestCommand: "test -f new.txt"})
	if err != nil || !res.OK || res.Commit == "" {
		t.Fatalf("push failed: %+v %v", res, err)
	}
	if got := must(t, ctx, remote, "rev-parse", "main"); got != res.Commit {
		t.Fatalf("remote main is %s, want %s", got, res.Commit)
	}
}

func TestIntegrateStopsOnConflictsAndFailingTests(t *testing.T) {
	ctx := context.Background()
	linked, _ := repoWithRemote(t)
	m := &Manager{Root: t.TempDir()}
	lock := &Lock{}
	a := Spec{Repo: linked, Board: "web", DutyID: "duty_A"}
	b := Spec{Repo: linked, Board: "web", DutyID: "duty_B"}
	pa, _, _ := m.Ensure(ctx, a)
	pb, _, _ := m.Ensure(ctx, b)
	commitIn(t, pa, "app.txt", "one\nTWO FROM A\nthree\n", "a")
	commitIn(t, pb, "app.txt", "one\nTWO FROM B\nthree\n", "b")

	if res, err := m.Integrate(ctx, a, lock, IntegrateOptions{Mode: ModePush}); err != nil || !res.OK {
		t.Fatalf("first duty should land: %+v %v", res, err)
	}
	res, err := m.Integrate(ctx, b, lock, IntegrateOptions{Mode: ModePush})
	if err != nil || res.OK || len(res.Conflicts) != 1 || res.Conflicts[0] != "app.txt" {
		t.Fatalf("expected a conflict on app.txt: %+v %v", res, err)
	}

	// While duty B resolves, nobody else moves the base.
	c := Spec{Repo: linked, Board: "web", DutyID: "duty_C"}
	pc, _, _ := m.Ensure(ctx, c)
	commitIn(t, pc, "other.txt", "c", "c")
	short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := m.Integrate(short, c, lock, IntegrateOptions{Mode: ModePush}); err == nil {
		t.Fatal("another duty integrated while one was resolving conflicts")
	}

	write(t, filepath.Join(pb, "app.txt"), "one\nTWO FROM A AND B\nthree\n")
	must(t, ctx, pb, "add", "app.txt")
	if _, err := gitEnv(ctx, pb, nil, "-c", "core.editor=true", "rebase", "--continue"); err != nil {
		t.Fatal(err)
	}
	if res, err := m.Integrate(ctx, b, lock, IntegrateOptions{Mode: ModePush, TestCommand: "false"}); err != nil || res.OK || res.TestOutput == "" && !strings.Contains(res.Message, "failed") {
		t.Fatalf("a failing test command should stop the push: %+v %v", res, err)
	}
	if res, err := m.Integrate(ctx, b, lock, IntegrateOptions{Mode: ModePush}); err != nil || !res.OK {
		t.Fatalf("the resolved duty should land: %+v %v", res, err)
	}
	if res, err := m.Integrate(ctx, c, lock, IntegrateOptions{Mode: ModePush}); err != nil || !res.OK {
		t.Fatalf("and then the waiting one: %+v %v", res, err)
	}
}

func TestSnapshotResumesOnAnotherMachine(t *testing.T) {
	ctx := context.Background()
	linked, remote := repoWithRemote(t)
	here := &Manager{Root: t.TempDir()}
	s := Spec{Repo: linked, Board: "web", DutyID: "duty_S"}
	path, _, _ := here.Ensure(ctx, s)
	commitIn(t, path, "done.txt", "committed", "half")
	must(t, ctx, path, "push", "--quiet", "origin", "duty/duty_S")
	write(t, filepath.Join(path, "draft.txt"), "not committed yet")
	write(t, filepath.Join(path, "app.txt"), "edited\n")
	if err := here.Snapshot(ctx, s); err != nil {
		t.Fatal(err)
	}
	if must(t, ctx, path, "symbolic-ref", "--short", "HEAD") != "duty/duty_S" || must(t, ctx, path, "status", "--porcelain") == "" {
		t.Fatal("snapshotting moved the branch or cleaned the worktree")
	}

	// Another machine: its own clone and worktrees folder.
	other := filepath.Join(t.TempDir(), "clone")
	must(t, ctx, filepath.Dir(other), "clone", "--quiet", remote, other)
	must(t, ctx, other, "branch", "duty/duty_S", "origin/duty/duty_S")
	there := &Manager{Root: t.TempDir()}
	path2, _, err := there.Ensure(ctx, Spec{Repo: other, Board: "web", DutyID: "duty_S"})
	if err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(path2, "draft.txt")) != "not committed yet" || read(t, filepath.Join(path2, "app.txt")) != "edited\n" {
		t.Fatal("the other machine did not get the uncommitted state back")
	}
	if read(t, filepath.Join(path2, "done.txt")) != "committed" {
		t.Fatal("the other machine did not get the committed work")
	}
}

func TestNoRemoteLeavesTheWorkOnItsBranch(t *testing.T) {
	ctx := context.Background()
	linked := filepath.Join(t.TempDir(), "solo")
	must(t, ctx, filepath.Dir(linked), "init", "--quiet", "-b", "main", linked)
	commitIn(t, linked, "a.txt", "a", "start")
	m := &Manager{Root: t.TempDir()}
	s := Spec{Repo: linked, Board: "solo", DutyID: "duty_N"}
	path, _, err := m.Ensure(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	commitIn(t, path, "b.txt", "b", "work")
	res, err := m.Integrate(ctx, s, &Lock{}, IntegrateOptions{Mode: ModePush})
	if err != nil || !res.OK || res.Mode != ModeBranch || res.Branch != "duty/duty_N" {
		t.Fatalf("expected the work to stay on its branch: %+v %v", res, err)
	}
	if must(t, ctx, linked, "rev-parse", "main") == res.Commit {
		t.Fatal("main was moved in a repository with no remote")
	}
}
