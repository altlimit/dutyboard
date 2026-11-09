//go:build !windows

package worktree

import (
	"os/exec"
	"syscall"
)

// stopTogether makes a cancelled command take everything it started with it, by giving it a process
// group of its own to kill.
func stopTogether(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
}
