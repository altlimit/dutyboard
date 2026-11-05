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
// in System32 or WindowsApps: those run the command inside WSL, on another machine's files.
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
	// Scoop's git: the git on PATH is a shim in <scoop>\shims, nowhere near Git's own folders.
	var scoops []string
	if s := os.Getenv("SCOOP"); s != "" {
		scoops = append(scoops, s)
	} else if home, err := os.UserHomeDir(); err == nil {
		scoops = append(scoops, filepath.Join(home, "scoop"))
	}
	if s := os.Getenv("SCOOP_GLOBAL"); s != "" {
		scoops = append(scoops, s)
	} else if s := os.Getenv("ProgramData"); s != "" {
		scoops = append(scoops, filepath.Join(s, "scoop"))
	}
	for _, s := range scoops {
		git := filepath.Join(s, "apps", "git", "current")
		candidates = append(candidates, filepath.Join(git, "bin", "bash.exe"), filepath.Join(git, "usr", "bin", "bash.exe"))
	}
	// Last, whatever bash is on PATH — which is how anything else that installs it (MSYS2, a shim) is
	// found, and why the WSL launchers are refused below.
	if b, err := exec.LookPath("bash"); err == nil {
		candidates = append(candidates, b)
	}
	for _, c := range candidates {
		c = filepath.Clean(c)
		if lower := strings.ToLower(c); strings.Contains(lower, `\windows\system32\`) || strings.Contains(lower, `\microsoft\windowsapps\`) {
			continue // both run bash inside WSL
		}
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}
