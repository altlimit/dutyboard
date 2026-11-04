package readiness

import (
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/runner"
)

func TestAgentItem(t *testing.T) {
	yes, no := true, false
	for _, c := range []struct {
		name    string
		s       runner.Status
		state   string
		actions []string
	}{
		{"missing", runner.Status{Agent: "codex"}, Todo, []string{ActionInstall}},
		{"signed out", runner.Status{Agent: "codex", Installed: true, SignedIn: &no}, Todo, []string{ActionSignIn}},
		{"cannot say", runner.Status{Agent: "claude-code", Installed: true}, Unknown, nil},
		{"ready", runner.Status{Agent: "cursor", Installed: true, SignedIn: &yes}, OK, nil},
	} {
		it := agentItem(c.s)
		if it.State != c.state || len(it.Actions) != len(c.actions) || (len(c.actions) > 0 && it.Actions[0] != c.actions[0]) {
			t.Errorf("%s: got %s %v, want %s %v", c.name, it.State, it.Actions, c.state, c.actions)
		}
	}
}

func TestTodoAndRank(t *testing.T) {
	r := Report{Items: []Item{
		{Key: "a", State: OK, Needed: true},
		{Key: "b", State: Todo, Needed: false},
		{Key: "c", State: Todo, Needed: true},
	}}
	todo := r.Todo()
	if len(todo) != 1 || todo[0].Key != "c" {
		t.Fatalf("Todo() = %v, want just c", todo)
	}
	if !(rank(r.Items[2]) < rank(r.Items[0]) && rank(r.Items[0]) < rank(r.Items[1])) {
		t.Fatal("a needed todo should rank before a needed ok, before anything not needed")
	}
}
