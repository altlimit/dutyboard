//go:build !windows

package runner

import (
	"os/exec"
	"strings"
	"testing"
)

func TestKilledHintExplainsASignal(t *testing.T) {
	err := exec.Command("sh", "-c", "kill -TERM $$").Run()
	if hint := killedHint(err); !strings.Contains(hint, "killed by something on this machine") {
		t.Fatalf("a session killed by a signal should say so: %v → %q", err, hint)
	}
	if hint := killedHint(exec.Command("sh", "-c", "exit 1").Run()); hint != "" {
		t.Fatalf("an ordinary failure is not a kill: %q", hint)
	}
}
