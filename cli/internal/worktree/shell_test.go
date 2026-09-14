package worktree

import (
	"context"
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
