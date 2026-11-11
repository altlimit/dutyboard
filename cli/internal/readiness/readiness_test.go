package readiness

import (
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
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

func TestAgentAlternativesAreNotRequirements(t *testing.T) {
	yes, no := true, false
	ready := runner.Status{Agent: "codex", Installed: true, SignedIn: &yes}
	missing := runner.Status{Agent: "cursor"}
	signedOut := runner.Status{Agent: "claude-code", Installed: true, SignedIn: &no}
	codex, cursor, claude := board.AgentOption{Agent: "codex"}, board.AgentOption{Agent: "cursor"}, board.AgentOption{Agent: "claude-code"}
	enabled := []board.AgentOption{cursor, claude, codex}
	linked := []board.BoardView{{ProjectID: "inherited", Runner: &board.Runner{UseMachineDefaults: true}}, {ProjectID: "override", Runner: &board.Runner{Options: enabled}}}
	required, anyReady := requiredAgents([]runner.Status{missing, signedOut, ready}, linked, enabled)
	if !anyReady || len(required["cursor"]) != 0 || len(required["claude-code"]) != 0 || len(required["codex"]) != 2 {
		t.Fatalf("optional fallback is blocking: %v", required)
	}
	// Explicit single-agent overrides still need their selected agent.
	linked = []board.BoardView{{ProjectID: "pinned", Runner: &board.Runner{Options: []board.AgentOption{cursor}}}}
	required, _ = requiredAgents([]runner.Status{missing, ready}, linked, enabled)
	if len(required["cursor"]) != 1 {
		t.Fatal("unusable explicit override hidden")
	}
	// A ready CLI not enabled on this machine is not a usable fallback.
	linked[0].Runner.Options = []board.AgentOption{cursor, codex}
	required, _ = requiredAgents([]runner.Status{missing, ready}, linked, []board.AgentOption{cursor})
	if len(required["cursor"]) != 1 || len(required["codex"]) != 0 {
		t.Fatal("disabled agent counted as a fallback")
	}
	// Unknown sign-in status is usable, matching the runner's existing behavior.
	ready.SignedIn = nil
	required, _ = requiredAgents([]runner.Status{missing, ready}, linked, enabled)
	if len(required["cursor"]) != 0 {
		t.Fatal("unknown sign-in status blocked fallback")
	}
	// None ready asks for one agent, not three separate mandatory installs.
	for _, linked := range [][]board.BoardView{nil, linked} {
		required, anyReady = requiredAgents([]runner.Status{{Agent: "codex"}, missing, signedOut}, linked, enabled)
		if anyReady || len(required) != 0 {
			t.Fatal("all unavailable should use the aggregate setup prompt")
		}
	}
}
