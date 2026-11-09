//go:build !windows

package runner

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// killGrace is how long the agent has to stop when asked before it is made to.
	killGrace = 10 * time.Second
	// finishGrace is how long what the agent started has to stop once the agent itself has gone.
	finishGrace = 3 * time.Second
)

// isolate puts the agent in its own process group, so it and everything it starts can be stopped
// together.
func isolate(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killTree asks the whole group, and anything of the session's that left the group, to stop, then
// insists.
func killTree(cmd *exec.Cmd, mark string) {
	if cmd.Process == nil {
		return
	}
	pgid := -cmd.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	signalMarked(mark, syscall.SIGTERM)
	time.AfterFunc(killGrace, func() {
		_ = syscall.Kill(pgid, syscall.SIGKILL)
		signalMarked(mark, syscall.SIGKILL)
	})
}

// finishOff waits briefly for what the stopped agent started, then kills whatever is left and waits
// for that to go too, so nothing is still running when it returns.
func finishOff(cmd *exec.Cmd, mark string) {
	if cmd.Process == nil {
		return
	}
	pgid := -cmd.Process.Pid
	alive := func() bool {
		return syscall.Kill(pgid, 0) == nil || len(markedPIDs(mark)) > 0
	}
	waitUntilGone := func(d time.Duration) {
		for deadline := time.Now().Add(d); alive() && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
		}
	}
	waitUntilGone(finishGrace)
	_ = syscall.Kill(pgid, syscall.SIGKILL)
	signalMarked(mark, syscall.SIGKILL)
	waitUntilGone(time.Second)
}

func signalMarked(mark string, sig syscall.Signal) {
	for _, pid := range markedPIDs(mark) {
		_ = syscall.Kill(pid, sig)
	}
}

// markedPIDs finds this session's processes by the mark in their environment. A process group only
// holds what stayed in it: a command started with setsid, or by a tool that gives each command a
// session of its own, has left the group but still inherited the environment.
func markedPIDs(mark string) []int {
	if mark == "" {
		return nil
	}
	if _, err := os.Stat("/proc/self/environ"); err == nil {
		return markedInProc(mark)
	}
	return markedInPS(mark)
}

func markedInProc(mark string) []int {
	paths, _ := filepath.Glob("/proc/[0-9]*/environ")
	var pids []int
	for _, p := range paths {
		pid, err := strconv.Atoi(filepath.Base(filepath.Dir(p)))
		if err != nil || pid == os.Getpid() {
			continue
		}
		// Unreadable is someone else's process, or one that has just gone.
		if env, err := os.ReadFile(p); err == nil && bytes.Contains(env, []byte(mark)) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// markedInPS is the same for a system with no /proc, such as macOS, whose ps can show a process's
// environment.
func markedInPS(mark string) []int {
	out, err := exec.Command("ps", "-axwwE", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, mark) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if pid, err := strconv.Atoi(fields[0]); err == nil && pid != os.Getpid() {
			pids = append(pids, pid)
		}
	}
	return pids
}
