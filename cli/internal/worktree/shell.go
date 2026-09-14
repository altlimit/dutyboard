package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

var gitBash = sync.OnceValue(findGitBash)

// GitBash is the bash that comes with Git for Windows, or "" when there is none. Never the bash.exe
// in System32: that one runs the command inside WSL, on another machine's files.
func GitBash() string { return gitBash() }

func findGitBash() string {
	var candidates []string
	if p := os.Getenv("CLAUDE_CODE_GIT_BASH_PATH"); p != "" {
		candidates = append(candidates, p) // what Claude Code itself was told to use
	}
	if g, err := exec.LookPath("git"); err == nil {
		// git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
		dir := filepath.Dir(g)
		for _, up := range []string{"..", filepath.Join("..", "..")} {
			root := filepath.Join(dir, up)
			candidates = append(candidates, filepath.Join(root, "bin", "bash.exe"), filepath.Join(root, "usr", "bin", "bash.exe"))
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramW6432", "LocalAppData"} {
		if base := os.Getenv(env); base != "" {
			candidates = append(candidates, filepath.Join(base, "Git", "bin", "bash.exe"), filepath.Join(base, "Programs", "Git", "bin", "bash.exe"))
		}
	}
	for _, c := range candidates {
		c = filepath.Clean(c)
		if strings.Contains(strings.ToLower(c), `\windows\system32\`) {
			continue
		}
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}
