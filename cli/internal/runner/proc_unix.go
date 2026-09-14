//go:build !windows

package runner

import (
	"os/exec"
	"syscall"
	"time"
)

// isolate puts the agent in its own process group, so it and everything it starts can be stopped
// together.
func isolate(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killTree asks the whole group to stop, then insists.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid := -cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	time.AfterFunc(10*time.Second, func() { _ = syscall.Kill(pgid, syscall.SIGKILL) })
}
