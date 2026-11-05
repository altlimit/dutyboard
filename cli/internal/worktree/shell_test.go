package worktree

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The commands setup agents write: bash, with `;`, `&&` and pushd.
func TestShellRunsBashStyleCommands(t *testing.T) {
	if runtime.GOOS == "windows" && GitBash() == "" {
		t.Skip("no Git Bash")
	}
	dir := t.TempDir()
	out, err := Shell(context.Background(), dir, "mkdir -p tests/e2e; pushd tests/e2e >/dev/null && echo inside; popd >/dev/null", nil)
	if err != nil || !strings.Contains(out, "inside") {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

// Scoop's git is a shim on PATH, far from Git's own folders; its bash is found where scoop keeps apps.
func TestGitBashFoundInScoop(t *testing.T) {
	scoop := t.TempDir()
	bash := filepath.Join(scoop, "apps", "git", "current", "bin", "bash.exe")
	if err := os.MkdirAll(filepath.Dir(bash), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bash, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, env := range []string{"PATH", "CLAUDE_CODE_GIT_BASH_PATH", "ProgramFiles", "ProgramW6432", "LocalAppData", "SCOOP_GLOBAL", "ProgramData"} {
		t.Setenv(env, "")
	}
	t.Setenv("SCOOP", scoop)
	if got := findGitBash(); got != bash {
		t.Fatalf("findGitBash() = %q, want %q", got, bash)
	}
}
