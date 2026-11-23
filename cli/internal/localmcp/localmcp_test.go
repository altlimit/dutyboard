package localmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type fakeDaemon struct{ notes map[string]string }

func (fakeDaemon) MCP(context.Context, string, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (fakeDaemon) Reload()       {}
func (fakeDaemon) Stop()         {}
func (fakeDaemon) Accept(string) {}
func (f fakeDaemon) Notes(_ context.Context, runToken string) string {
	return f.notes[runToken]
}

func TestHookAsksTheDaemon(t *testing.T) {
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = Serve(ctx, fakeDaemon{notes: map[string]string{"tok": "A person wrote on this duty"}}, "test") }()
	for deadline := time.Now().Add(5 * time.Second); !Running(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the daemon's socket never came up")
		}
	}
	reply := func(event, text string) []byte {
		if text == "" {
			return nil
		}
		return []byte(event + ": " + text)
	}
	hook := func(token string) string {
		t.Setenv("DUTYBOARD_RUN_TOKEN", token)
		var out bytes.Buffer
		Hook(strings.NewReader(`{"hook_event_name":"PostToolUse","tool_name":"Bash"}`), &out, reply)
		return out.String()
	}
	if got := hook("tok"); got != "PostToolUse: A person wrote on this duty\n" {
		t.Fatalf("hook printed %q", got)
	}
	if got := hook("other"); got != "" {
		t.Fatalf("nothing to say prints nothing, got %q", got)
	}
	if got := hook(""); got != "" {
		t.Fatalf("outside a session the hook says nothing, got %q", got)
	}
	cancel()
	for deadline := time.Now().Add(5 * time.Second); Running(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the daemon's socket never went down")
		}
	}
	if got := hook("tok"); got != "" {
		t.Fatalf("with no daemon the hook says nothing, got %q", got)
	}
}
