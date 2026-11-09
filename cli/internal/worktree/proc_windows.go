//go:build windows

package worktree

import (
	"os/exec"
	"strconv"
)

// stopTogether makes a cancelled command take everything it started with it, with taskkill: Windows
// has no process-group signal.
func stopTogether(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	}
}
