package daemon

import (
	"context"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/readiness"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

func TestSensitivePaths(t *testing.T) {
	cases := []struct {
		patterns []string
		files    []string
		want     bool
	}{
		{[]string{"auth/**"}, []string{"auth/login.go"}, true},
		{[]string{"auth/**"}, []string{"auth/deep/er/token.go"}, true},
		{[]string{"auth"}, []string{"auth/login.go"}, true},
		{[]string{"auth/**"}, []string{"oauth/login.go", "docs/auth.md"}, false},
		{[]string{"**/payments/*"}, []string{"api/payments/charge.js"}, true},
		{[]string{"**/payments/*"}, []string{"payments/charge.js"}, true},
		{[]string{"**/payments/*"}, []string{"api/payments/sub/charge.js"}, true},
		{[]string{"*.sql"}, []string{"db/migrations/001.sql"}, true},
		{[]string{"src/*.sql"}, []string{"src/db/001.sql"}, false},
		{[]string{"secrets.env"}, []string{"./config/secrets.env"}, true},
		{[]string{"a/b?.go"}, []string{"a/b1.go"}, true},
		{nil, []string{"auth/login.go"}, false},
		{[]string{"auth/**"}, nil, false},
	}
	for _, c := range cases {
		if got := matchesAny(c.patterns, c.files); got != c.want {
			t.Errorf("%v against %v: %v, want %v", c.patterns, c.files, got, c.want)
		}
	}
}

// A long line in the checklist is shortened on whole characters, not sent for the board to refuse.
func TestReadinessFitsTheBoard(t *testing.T) {
	long := strings.Repeat("é", 1000)
	items := fitForBoard([]readiness.Item{{Label: long, Detail: long, Fix: long}, {Label: "ok", Detail: "short"}})
	if n := len([]rune(items[0].Detail)); n != maxItemDetail || !strings.HasSuffix(items[0].Detail, "…") {
		t.Errorf("detail: %d characters", n)
	}
	if len([]rune(items[0].Label)) != maxItemLabel || len([]rune(items[0].Fix)) != maxItemFix {
		t.Error("label or fix not shortened")
	}
	if items[1].Detail != "short" || items[1].Label != "ok" {
		t.Error("a short item changed")
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// What the machine checks when a builder hands its work to a reviewer, and what it says for itself.
func TestHandingWorkToAReviewer(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	ctx := context.Background()
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "init", "--quiet", "-b", "main")
	write := func(dir, name, body string) {
		t.Helper()
		p := filepath.Join(dir, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(repo, "app.txt", "ok\n")
	write(repo, ".gitignore", ".prepped\n") // what prep makes is ignored, as a project's build output is
	gitIn(t, repo, "add", ".")
	gitIn(t, repo, "commit", "--quiet", "-m", "start")

	wt := &worktree.Manager{Root: filepath.Join(root, "worktrees")}
	// The test command passes when app.txt says ok; prep leaves a mark, so we can see whether it ran.
	profile := &board.Profile{TestCommand: "grep -qx ok app.txt"}
	profile.Worktree.Prep = "touch .prepped"
	d := &Daemon{wt: wt, views: map[string]board.BoardView{"b": {Profile: profile}}, log: log.New(io.Discard, "", 0)}
	team := softwareTeam("engineer")
	team.Settings.SensitivePaths = []string{"auth/**"}
	spec := worktree.Spec{Repo: repo, Board: "b", DutyID: "d1", Prep: profile.Worktree.Prep, PrepLater: true}
	path, _, err := wt.Ensure(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(path, ".prepped")); err == nil {
		t.Fatal("prep ran for a session that only routes")
	}
	run := &Run{Board: "b", DutyID: "d1", Kind: "work", Spec: spec, team: team}
	run.setChoice(board.AgentOption{Agent: "claude-code", Model: "claude-opus-5-5", Effort: "high"})
	hand := func(to string) (map[string]any, string) {
		args := map[string]any{"to_role": to}
		return args, d.beforeHandoff(ctx, run, args)
	}

	write(path, "auth/login.go", "package auth\n")
	if _, refusal := hand("qa"); !strings.Contains(refusal, "not committed") || !strings.Contains(refusal, "auth/") {
		t.Fatalf("uncommitted work went to review: %q", refusal)
	}
	gitIn(t, path, "add", ".")
	gitIn(t, path, "commit", "--quiet", "-m", "login")
	write(path, "app.txt", "broken\n")
	gitIn(t, path, "commit", "--quiet", "-am", "break it")
	if _, refusal := hand("qa"); !strings.Contains(refusal, "tests (`grep -qx ok app.txt`) fail") || !strings.Contains(refusal, "QA reviews only work that passes") {
		t.Fatalf("failing work went to review: %q", refusal)
	}
	if _, err := os.Stat(filepath.Join(path, ".prepped")); err != nil {
		t.Fatal("the tests ran in a worktree that was never prepared")
	}
	write(path, "app.txt", "ok\n")
	gitIn(t, path, "commit", "--quiet", "-am", "fix it")
	args, refusal := hand("qa")
	if refusal != "" {
		t.Fatalf("passing work was refused: %s", refusal)
	}
	checks, _ := args["checks"].(map[string]any)
	if checks["passed"] != true || checks["commit"] != gitIn(t, path, "rev-parse", "HEAD") || checks["command"] != profile.TestCommand {
		t.Fatalf("checks: %#v", args)
	}
	if args["sensitive"] != true {
		t.Error("a change under auth/ was not said to be sensitive")
	}
	if w, _ := args["worked_with"].(map[string]any); w["model"] != "claude-opus-5-5" || w["agent"] != "claude-code" {
		t.Errorf("worked_with: %#v", args["worked_with"])
	}

	// Routing, or passing to anyone who does not review, is not tested: only builder to reviewer is.
	run.team = softwareTeam("duty-officer")
	write(path, "scratch.txt", "x")
	args, refusal = hand("engineer")
	if refusal != "" || args["checks"] != nil {
		t.Fatalf("routing was held to the reviewer's bar: %q %#v", refusal, args)
	}
	if args["worked_with"] == nil {
		t.Error("routing did not say which model read the duty")
	}

	// A board with no test command: committed is enough.
	d.views["b"] = board.BoardView{Profile: &board.Profile{}}
	run.team = softwareTeam("engineer")
	_ = os.Remove(filepath.Join(path, "scratch.txt"))
	if args, refusal := hand("qa"); refusal != "" || args["checks"] != nil {
		t.Fatalf("no test command: %q %#v", refusal, args)
	}
}
