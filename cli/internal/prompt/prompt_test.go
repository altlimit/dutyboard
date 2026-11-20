package prompt

import (
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/hints"
)

func TestCodexGitApprovalInstructions(t *testing.T) {
	for _, tc := range []struct {
		agent, mode string
		want        bool
	}{
		{"codex", "acceptEdits", true},
		{"codex", "", true},
		{"codex", "bypassPermissions", false},
		{"claude-code", "acceptEdits", false},
		{"cursor", "acceptEdits", false},
	} {
		in := Input{Board: board.BoardView{Runner: &board.Runner{Agent: tc.agent, PermissionMode: tc.mode}}}
		out, err := System(in)
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.Contains(out, "Codex approval requests are handled by its automatic reviewer"); got != tc.want {
			t.Errorf("%s/%s: automatic review instructions = %v, want %v", tc.agent, tc.mode, got, tc.want)
		}
		if tc.want && !strings.Contains(out, "respect the denial and do not work around it") {
			t.Error("instructions must distinguish a sandbox error from a review denial")
		}
	}
}

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
	in.Duty.SourceNoteIDs = []string{"note_1", "note_2"}
	task, err = Duty(in)
	if err != nil || !strings.Contains(task, "note_2") || !strings.Contains(task, "source_note_ids") {
		t.Fatal("combined review lost source notes or suggestion provenance instructions")
	}
	in.Duty.Kind = "work"
	task, err = Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(task, "note_1") || !strings.Contains(task, "note_2") || !strings.Contains(task, "approved by a person") {
		t.Fatal("approved work lost its source")
	}
}

func teamAs(id string) *board.Team {
	roles := []board.Role{
		{ID: "duty-officer", Name: "Duty Officer", Summary: "Reads every new duty first.", Intake: true, Charter: "Route it."},
		{ID: "architect", Name: "Architect", Summary: "Designs before code.", Plans: true, Charter: "Plan it."},
		{ID: "engineer", Name: "Engineer", Summary: "Builds changes.", Reviewed: true, Charter: "Validate every external input."},
		{ID: "qa", Name: "QA", Summary: "Verifies the work.", Reviews: true, Charter: "Read the whole diff."},
	}
	t := &board.Team{}
	t.Settings.MaxBounces = 3
	for _, r := range roles {
		if r.ID == id {
			t.Role = r
		} else {
			r.Charter = "" // only a session's own role carries its charter
			t.Others = append(t.Others, r)
		}
	}
	return t
}

// A session on a board with a team is told who it is, the standard it works to, who else is there,
// and — the part that keeps unverified work off the main branch — whether it lands its own work.
func TestRolePrompts(t *testing.T) {
	base := Input{
		Duty:  board.Duty{ID: "duty_1", Title: "Add export", Brief: "CSV of orders.", Kind: "work"},
		Board: board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Rules: "- Keep it small.", RulesAt: 1, Branch: "duty/duty_1", Worktree: "/w", Mode: "push",
	}
	render := func(in Input) (string, string) {
		t.Helper()
		sys, err := System(in)
		if err != nil {
			t.Fatal(err)
		}
		task, err := Duty(in)
		if err != nil {
			t.Fatal(err)
		}
		return sys, task
	}
	mustSay := func(what, text string, wants ...string) {
		t.Helper()
		for _, want := range wants {
			if !strings.Contains(text, want) {
				t.Errorf("%s does not say %q:\n%s", what, want, text)
			}
		}
	}
	mustNotSay := func(what, text string, unwanted ...string) {
		t.Helper()
		for _, u := range unwanted {
			if strings.Contains(text, u) {
				t.Errorf("%s says %q", what, u)
			}
		}
	}

	// No team: nothing about roles, and the duty is finished by whoever holds it, as before.
	sys, task := render(base)
	mustNotSay("a duty with no team", sys+task, "# Your role", "duty_handoff", "The team's memory")
	mustSay("a duty with no team", sys+task, "`duty_integrate`", "`duty_complete`")

	builder := base
	builder.Duty.Team = teamAs("engineer")
	builder.Duty.Team.Handoff = &board.Handoff{From: "duty-officer", FromName: "Duty Officer", Note: "Goal: a download button on /orders."}
	sys, task = render(builder)
	mustSay("the Engineer's system prompt", sys,
		"# Your role: Engineer", "Validate every external input.", "**QA** (`qa`) — Verifies the work. It verifies work, lands it and completes the duty.",
		"**You do not land or complete this duty.**", "hand it to **QA** (`qa`)", "the reviewer's, once they have seen it work in this same worktree",
		"The project's rules", "win where the two disagree")
	mustNotSay("the Engineer's system prompt", sys, "Read the whole diff.", "call `duty_integrate` (it lands your commits")
	mustSay("the Engineer's duty", task, "**Duty Officer handed this to you.**", "a download button on /orders", "do not start over", "then `duty_handoff` to the reviewer")
	mustNotSay("the Engineer's duty", task, "then `duty_complete`")

	sentBack := builder
	sentBack.Duty.Team = teamAs("engineer")
	sentBack.Duty.Team.Handoff = &board.Handoff{From: "qa", FromName: "QA", Note: "1. orders.js:40 has no ownership check.", SentBack: true}
	_, task = render(sentBack)
	mustSay("work that was sent back", task, "**QA reviewed this and sent it back.**", "every one", "no ownership check")

	reviewer := base
	reviewer.Duty.Team = teamAs("qa")
	reviewer.Duty.Team.Bounces = 2
	sys, task = render(reviewer)
	mustSay("QA's prompt", sys+task, "# Your role: QA", "Read the whole diff.", "**You are the check before this counts.**", "land it with `duty_integrate` and complete the duty",
		"already been sent back 2 time(s); at 3 a person is asked", "commit, `duty_integrate`, then `duty_complete`")
	mustNotSay("QA's prompt", sys, "You do not land or complete this duty")

	officer := base
	officer.Duty.Team = teamAs("duty-officer")
	sys, task = render(officer)
	mustSay("the Duty Officer's prompt", sys+task, "**You read this duty first.**", "Hand it to the role that should work it with `duty_handoff`", "only if it is trivial and safe")

	planner := base
	planner.Duty.Team = teamAs("architect")
	planner.Duty.Team.Settings.PlanApproval = true
	sys, _ = render(planner)
	mustSay("the Architect's prompt", sys, "This board's owner approves plans before they are built", "`duty_enqueue` each piece with `role` set")
	planner.Duty.Team.Settings.PlanApproval = false
	if sys, _ = render(planner); strings.Contains(sys, "approves plans") {
		t.Error("a board that does not ask to approve plans says it does")
	}

	// Boards with no repository hand files or account changes on the same way.
	files := builder
	files.Files = &Files{Dir: "/t", In: "/t/in", Out: "/t/out"}
	sys, task = render(files)
	mustSay("a task's builder", sys+task, "put each file it produces in `out/`", "then `duty_handoff` to the reviewer", "this folder go with it")
	mustNotSay("a task's builder", sys+task, "`duty_integrate`", "(`git log`")
	account := builder
	account.Files = &Files{Dir: "/t", Service: true, Keep: "/k"}
	sys, task = render(account)
	mustSay("an account's operator", sys+task, "check it in the account itself", "then `duty_handoff` to the reviewer")
}

// The memory is in every working session's prompt, with the version to write back and its bounds.
func TestMemoryPrompt(t *testing.T) {
	in := Input{
		Duty:   board.Duty{ID: "duty_1", Title: "T", Brief: "B", Kind: "work"},
		Board:  board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Branch: "duty/duty_1", Worktree: "/w", Mode: "push",
		Memory: &board.Memory{Body: "## Decisions\n- Orders export streams.", Version: 4, Chars: 38, MaxChars: 6000},
	}
	sys, err := System(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# The team's memory", "Orders export streams.", "`based_on: 4`", "holds 6000 characters (38 used)", "must be written there before you finish", "Never a secret"} {
		if !strings.Contains(sys, want) {
			t.Errorf("the memory section does not say %q:\n%s", want, sys)
		}
	}
	in.Memory = &board.Memory{MaxChars: 6000}
	if sys, _ = System(in); !strings.Contains(sys, "nothing yet") || !strings.Contains(sys, "`based_on: 0`") {
		t.Errorf("an empty memory:\n%s", sys)
	}
	in.Memory = nil
	if sys, _ = System(in); strings.Contains(sys, "The team's memory") {
		t.Error("a board too old to keep a memory is told to write one")
	}
}

// A roster duty is told how to draft a team that the board will accept.
func TestRosterDutyPrompt(t *testing.T) {
	in := Input{
		Duty:   board.Duty{ID: "duty_r", Title: "Draft this board's team", Brief: "Read what this board is for.", Kind: "roster"},
		Board:  board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Branch: "duty/duty_r", Worktree: "/w", Mode: "push",
	}
	task, err := Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"**draft this board's team.**", "**Exactly one** role with `intake: true`", "`reviewed: true`", "`reviews: true`", "`board_roster_submit`", "`duty_integrate` will report nothing to integrate", "Read what this board is for."} {
		if !strings.Contains(task, want) {
			t.Errorf("the roster duty does not say %q:\n%s", want, task)
		}
	}
}

// What changes from one duty to the next comes last in the system prompt, so the part before it is the
// same for every duty a role works on a board and can be reused between sessions rather than paid
// for again.
func TestSystemPromptPutsWhatChangesLast(t *testing.T) {
	in := func(id, worktree string, memory string) Input {
		team := teamAs("engineer")
		return Input{
			Duty:  board.Duty{ID: id, Title: "T " + id, Brief: "B", Kind: "work", Team: team},
			Board: board.BoardView{Profile: &board.Profile{Type: "webapp", TestCommand: "npm test"}},
			Rules: "- Keep it small.", RulesAt: 3, Branch: "duty/" + id, Worktree: worktree, Mode: "push",
			Tools: "- node 22", Memory: &board.Memory{Body: memory, Version: 2, MaxChars: 6000},
			Repos: []Repo{{Name: "api", URL: "git@example.com:api.git", Path: worktree + "-api"}},
		}
	}
	one, err := System(in("duty_1", "/w/duty_1", "- one thing"))
	if err != nil {
		t.Fatal(err)
	}
	two, _ := System(in("duty_2", "/w/duty_2", "- one thing\n- and another"))
	shared := 0
	for shared < len(one) && shared < len(two) && one[shared] == two[shared] {
		shared++
	}
	for _, stable := range []string{"# The project's rules", "Keep it small.", "# Tools on this machine", "# Your role: Engineer", "## Passing the duty on", "# Linked boards"} {
		if i := strings.Index(one, stable); i < 0 || i >= shared {
			t.Errorf("%q is not in the part two duties share (it ends at %d of %d)", stable, shared, len(one))
		}
	}
	for _, changing := range []string{"/w/duty_1", "duty/duty_1", "- one thing"} {
		if i := strings.Index(one, changing); i+len(changing) <= shared {
			t.Errorf("%q is in the shared part, at %d", changing, i)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(one), "- Branch: `duty/duty_1`") {
		t.Errorf("the prompt does not end with where the session works:\n%s", one[len(one)-300:])
	}
}

// The role that routes duties is given what routing needs, and pointed at the rest.
func TestRoutingPromptIsSlim(t *testing.T) {
	in := Input{
		Duty:  board.Duty{ID: "duty_1", Title: "T", Brief: "B", Kind: "work", Team: teamAs("duty-officer")},
		Board: board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Rules: "- A long rule nobody routing needs.", RulesAt: 5, Branch: "duty/duty_1", Worktree: "/w", Mode: "push",
		Tools: "- node 22", Memory: &board.Memory{Body: "- routing hint", Version: 1, MaxChars: 6000},
	}
	full, _ := System(in)
	in.Slim = true
	slim, _ := System(in)
	for _, gone := range []string{"A long rule nobody routing needs.", "# Linked boards", "# Notes and runner handoffs", "# Tools on this machine"} {
		if !strings.Contains(full, gone) {
			t.Errorf("the full prompt lacks %q", gone)
		}
		if strings.Contains(slim, gone) {
			t.Errorf("the routing prompt still has %q", gone)
		}
	}
	for _, kept := range []string{"Rules (version 5) are in force", "`board_rules`", "**You read this duty first.**", "`risk` on `duty_handoff`", "- routing hint", "# Your role: Duty Officer"} {
		if !strings.Contains(slim, kept) {
			t.Errorf("the routing prompt lacks %q", kept)
		}
	}
	// Here the rules are one line; on a real board they, and the tools, are most of what is saved.
	if len(full)-len(slim) < 1500 {
		t.Errorf("the routing prompt is %d characters, the full one %d", len(slim), len(full))
	}
}

// A reviewer is told how careful to be, and when the machine has already seen the tests pass.
func TestReviewerIsToldRiskAndChecks(t *testing.T) {
	in := Input{
		Duty:   board.Duty{ID: "duty_1", Title: "T", Brief: "B", Kind: "work", Team: teamAs("qa")},
		Board:  board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Branch: "duty/duty_1", Worktree: "/w", Mode: "push",
	}
	in.Duty.Team.Handoff = &board.Handoff{From: "engineer", FromName: "Engineer", Note: "Built.", Checks: &board.Checks{Command: "npm test", Commit: "abc123"}}
	in.Duty.Team.Risk = "high"
	task, _ := Duty(in)
	for _, want := range []string{"**This duty is high risk.**", "line by line", "(`npm test`) on commit `abc123`", "Do not run the whole suite again"} {
		if !strings.Contains(task, want) {
			t.Errorf("the high-risk review does not say %q:\n%s", want, task)
		}
	}
	in.Duty.Team.Risk, in.Duty.Team.Handoff.Checks = "low", nil
	task, _ = Duty(in)
	if !strings.Contains(task, "This duty is low risk") || strings.Contains(task, "Do not run the whole suite") {
		t.Errorf("the low-risk review:\n%s", task)
	}
	// The builder is told nothing about how its work will be reviewed.
	in.Duty.Team = teamAs("engineer")
	in.Duty.Team.Risk = "high"
	if task, _ = Duty(in); strings.Contains(task, "high risk") {
		t.Error("the builder was given the reviewer's instructions")
	}
}

// A retro duty is told where to put what it finds, and that nothing changes until a person accepts.
func TestRetroDutyPrompt(t *testing.T) {
	in := Input{
		Duty:   board.Duty{ID: "duty_x", Title: "Look at what keeps being sent back", Brief: "- “Export” (`d1`): QA sent it back to Engineer — 1. No ownership check.", Kind: "retro"},
		Board:  board.BoardView{Profile: &board.Profile{Type: "webapp"}},
		Branch: "duty/duty_x", Worktree: "/w", Mode: "push",
	}
	task, err := Duty(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"`board_roster_submit`", "`board_rules_submit`", "`board_memory_write`", "`charters: true`", "never weaken a standard", "No ownership check", "nothing repeats"} {
		if !strings.Contains(task, want) {
			t.Errorf("the retro duty does not say %q:\n%s", want, task)
		}
	}
}
