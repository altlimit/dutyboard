//go:build !windows

package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

type quietStream struct{}

func (quietStream) Read([]byte, *Outcome) string { return "" }

// A command that gave itself a session of its own has left the agent's process group, ignores being
// asked to stop, and holds the agent's output open: stopping the session must still end it, and must
// not wait on it for ever.
func TestStoppingASessionEndsWhatLeftItsGroup(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid on this system")
	}
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "stray.pid")
	mark := "DUTYBOARD_RUN_TOKEN=stop-test-" + strconv.Itoa(os.Getpid())
	script := `setsid sh -c 'trap "" TERM; echo $$ > "$PID_FILE"; while :; do sleep 1; done' & sleep 300`

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan Outcome, 1)
	go func() {
		done <- runProcess(ctx, Job{Dir: dir, Env: []string{mark, "PID_FILE=" + pidFile}, Mark: mark}, "sh", []string{"-c", script}, nil, quietStream{})
	}()

	var pid int
	for deadline := time.Now().Add(10 * time.Second); pid == 0; {
		if time.Now().After(deadline) {
			t.Fatal("the stray never started")
		}
		b, _ := os.ReadFile(pidFile)
		pid, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		time.Sleep(50 * time.Millisecond)
	}
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		t.Fatalf("the stray should lead its own group: pgid %d, %v", pgid, err)
	}

	cancel()
	select {
	case out := <-done:
		if !out.Canceled {
			t.Errorf("a stopped session should say it was cancelled: %+v", out)
		}
	case <-time.After(outputGrace + 5*time.Second):
		t.Fatal("stopping the session hung on what it left behind")
	}
	if err := syscall.Kill(pid, 0); err == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("process %d outlived its session", pid)
	}
	if left := markedPIDs(mark); len(left) > 0 {
		t.Fatalf("processes still carry the session's mark: %v", left)
	}
}
