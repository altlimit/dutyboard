//go:build !windows

package service

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in a session of its own, so it outlives the terminal that installed it.
func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
