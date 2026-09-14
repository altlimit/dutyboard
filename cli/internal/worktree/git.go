package worktree

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// git runs git in dir and answers its trimmed stdout. A failure carries stderr, which is what says
// what went wrong.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	return gitEnv(ctx, dir, nil, args...)
}

func gitEnv(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// Never prompt: a daemon has no one to type a password, and a hung credential prompt is a lane
	// that never frees.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_MERGE_AUTOEDIT=no")
	cmd.Env = append(cmd.Env, env...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return strings.TrimSpace(out.String()), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// Shell runs a project command — a prep or test command from the profile — in dir, answering its
// combined output.
//
// With bash, everywhere it can: the agent that writes these commands writes them for the shell its
// own sessions use, which on Windows is Git Bash — and `a; b`, `pushd`, `&&` all mean something else,
// or nothing, to cmd.exe. Without Git Bash, Windows gets PowerShell, which reads them far more often
// than cmd does.
func Shell(ctx context.Context, dir, command string, env []string) (string, error) {
	var cmd *exec.Cmd
	switch {
	case runtime.GOOS != "windows":
		sh := "sh"
		if p, err := exec.LookPath("bash"); err == nil {
			sh = p
		}
		cmd = exec.CommandContext(ctx, sh, "-c", command)
	case GitBash() != "":
		cmd = exec.CommandContext(ctx, GitBash(), "-c", command)
	default:
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	}
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}
