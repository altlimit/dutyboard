//go:build windows

package runner

import (
	"os/exec"
	"strconv"
	"syscall"
)

// isolate starts the agent in a new process group; Windows has no process-group signal, so the tree
// is stopped by taskkill below.
func isolate(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200} // CREATE_NEW_PROCESS_GROUP
}

// killTree stops the agent and every process it started.
func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
