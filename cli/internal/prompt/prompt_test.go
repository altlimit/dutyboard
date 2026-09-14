package prompt

import (
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/hints"
)

func TestEveryKindRenders(t *testing.T) {
	p := &board.Profile{Type: "game", Description: "A game", TestCommand: "tools/test.sh", Stack: []string{"Godot"}}
	p.Deploy.Method = "altengine"
	p.Deploy.AltengineInstances = []string{"cadence"}
	in := Input{
		Duty:  board.Duty{ID: "duty_01ABC", Title: "Add a pause menu", Brief: "Esc opens it.", Kind: "work"},
		Board: board.BoardView{Profile: p, Runner: &board.Runner{Instructions: "Screens fit a 320px phone."}},
		Rules: "- Keep it small.", RulesAt: 3, Branch: "duty/duty_01ABC", Worktree: "/w", Mode: "push",
		Tools: "- godot 4.7.1", Hints: hints.For("game"), Detected: "no workflow that deploys was found",
	}
	sys, err := System(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"duty/duty_01ABC", "version 3", "Keep it small", "tools/test.sh", "altengine_deploy_static", "cadence", "godot 4.7.1", "320px"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system prompt is missing %q:\n%s", want, sys)
		}
	}
	for _, kind := range []string{"work", "setup", "rules"} {
		in.Duty.Kind = kind
		out, err := Duty(in)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if !strings.Contains(out, "`duty_01ABC`") {
			t.Errorf("%s prompt does not name the duty the way the fake agent and a person read it:\n%s", kind, out)
		}
		if kind != "work" && !strings.Contains(out, "Frame time") {
			t.Errorf("%s prompt is missing the game hints", kind)
		}
	}

	in.Duty.Kind, in.Resuming = "work", true
	in.Duty.UnblockedContext = &struct {
		LastQuestion    string `json:"last_question"`
		HumanResolution string `json:"human_resolution"`
	}{"Esc or P?", "Esc."}
	out, _ := Duty(in)
	if !strings.Contains(out, "resuming") || !strings.Contains(out, "Answer: Esc.") {
		t.Errorf("a resumed duty should carry the answer:\n%s", out)
	}
}
