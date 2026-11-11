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
	p.Deploy.AltengineInstances = nil
	p.Deploy.AltengineTargets = []board.AltengineTarget{{Kind: "static", Instance: "cadence"}, {Kind: "functions", Instance: "cadence-api"}}
	if sys, _ := System(in); !strings.Contains(sys, "static site `cadence` with `altengine_deploy_static`") || !strings.Contains(sys, "functions instance `cadence-api` with `altengine_deploy_function`") {
		t.Errorf("typed deploy targets are not named with their tools:\n%s", sys)
	}
	in.MCPServers = []MCPServer{{Name: "playwright", Note: "screenshots of UI changes", Tools: []string{"browser_take_screenshot"}}}
	if sys, _ := System(in); !strings.Contains(sys, "**playwright** — screenshots of UI changes (tools you may use: browser_take_screenshot)") {
		t.Errorf("the board's MCP servers are not named to the session:\n%s", sys)
	}
	in.MCPServers = nil
	in.PrepFailed = "Command: npm ci\nError: exit status 1"
	if sys, _ := System(in); !strings.Contains(sys, "not prepared yet") || !strings.Contains(sys, "npm ci") {
		t.Errorf("a failed prep is not handed to the session:\n%s", sys)
	}
	in.PrepFailed = ""
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

	in.Duty.Kind, in.Fresh = "setup", true
	out, err := Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "build its first version") || !strings.Contains(out, "tools_register") || !strings.Contains(out, "`duty_01ABC`") {
		t.Errorf("a setup on a new repository should build the project and then do setup's steps:\n%s", out)
	}
	in.Fresh = false
	if out, _ := Duty(in); strings.Contains(out, "first version") || !strings.Contains(out, "tools_register") || !strings.Contains(out, "\n7. This duty normally") {
		t.Errorf("a setup on an existing repository reads it, and keeps its steps in order:\n%s", out)
	}

	in.Duty.Kind, in.Fresh = "work", false
	in.Files = &Files{Dir: "/w/duty_01ABC", In: "/w/duty_01ABC/in", Out: "/w/duty_01ABC/out", Inputs: []string{"menu.pdf"}, Missing: 1}
	sys, _ = System(in)
	task, _ := Duty(in)
	if !strings.Contains(sys, "there is no repository") || strings.Contains(sys, "duty_integrate") || strings.Contains(sys, "Full test suite") {
		t.Errorf("a task's session works in its folder, and is told nothing about landing commits:\n%s", sys)
	}
	if !strings.Contains(task, "`in/`: menu.pdf") || !strings.Contains(task, "1 more were still being uploaded") || !strings.Contains(task, "put what it produces in `out/`") || strings.Contains(task, "duty_integrate") {
		t.Errorf("a task names its files and where what it makes goes:\n%s", task)
	}

	in.Files = &Files{Dir: "/w/duty_01ABC", In: "/w/duty_01ABC/in", Out: "/w/duty_01ABC/out", Service: true, Keep: "/p/shop/local"}
	in.MCPServers = []MCPServer{{Name: "shop"}}
	sys, _ = System(in)
	task, _ = Duty(in)
	if !strings.Contains(sys, "`/p/shop/local`") || !strings.Contains(sys, "Never attach a screenshot") || !strings.Contains(sys, "not around them") ||
		strings.Contains(sys, "what you make goes in `out/`") || strings.Contains(sys, "duty_integrate") {
		t.Errorf("a session on an account works through its servers, keeps its sources, and attaches only what a person uses:\n%s", sys)
	}
	if strings.Contains(task, "No files came with it") || strings.Contains(task, "put what it produces in `out/`") || !strings.Contains(task, "check it in the account") {
		t.Errorf("a duty on an account is done in the account, not in out/:\n%s", task)
	}
	in.Files, in.MCPServers = nil, nil

	in.Duty.Kind, in.Resuming = "work", true
	in.Duty.UnblockedContext = &struct {
		LastQuestion    string `json:"last_question"`
		HumanResolution string `json:"human_resolution"`
	}{"Esc or P?", "Esc."}
	out, _ = Duty(in)
	if !strings.Contains(out, "resuming") || !strings.Contains(out, "Answer: Esc.") {
		t.Errorf("a resumed duty should carry the answer:\n%s", out)
	}

	in.Duty.Notes = []board.Note{{From: "Sam", Message: "Make P pause too."}}
	if out, _ := Duty(in); !strings.Contains(out, "- Sam: Make P pause too.") {
		t.Errorf("people's notes on the duty are not handed to the session:\n%s", out)
	}

	told, err := System(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Never poll", "`duty_schedule_create`", "fetches what it needs for itself", "do not keep trying it"} {
		if !strings.Contains(told, want) {
			t.Errorf("sessions are not told %q:\n%s", want, told)
		}
	}

	in.Duty.Check, in.Check = "scripts/inbox.sh", "2 new emails from billing@"
	if out, _ := Duty(in); !strings.Contains(out, "`scripts/inbox.sh`") || !strings.Contains(out, "2 new emails from billing@") {
		t.Errorf("what the schedule's check found is not handed to the session:\n%s", out)
	}
}

func TestNoteReviewAndApprovedWorkCarrySource(t *testing.T) {
	in := Input{Duty: board.Duty{ID: "review", Kind: "note_review", Title: "Review note", SourceNoteID: "note_1"}, Rules: "Keep private material private."}
	sys, err := System(in)
	if err != nil {
		t.Fatal(err)
	}
	task, err := Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"duty_suggest", "person approves", "Do not integrate", in.Rules} {
		if !strings.Contains(sys, want) {
			t.Errorf("review instructions missing %q", want)
		}
	}
	if !strings.Contains(task, "note_1") || !strings.Contains(task, "suggestions_cursor") {
		t.Fatal("review is missing source or history pagination")
	}
	in.Duty.Kind = "work"
	task, err = Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(task, "note_1") || !strings.Contains(task, "approved by a person") {
		t.Fatal("approved work lost its source")
	}
}
