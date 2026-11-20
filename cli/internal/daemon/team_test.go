package daemon

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

func softwareTeam(as string) *board.Team {
	roles := []board.Role{
		{ID: "duty-officer", Name: "Duty Officer", Summary: "Reads every new duty first.", Intake: true},
		{ID: "engineer", Name: "Engineer", Summary: "Builds changes.", Reviewed: true},
		{ID: "qa", Name: "QA", Summary: "Verifies the work.", Reviews: true},
	}
	t := &board.Team{}
	t.Settings.MaxBounces = 3
	for _, r := range roles {
		if r.ID == as {
			t.Role = r
		} else {
			t.Others = append(t.Others, r)
		}
	}
	return t
}

// A role whose work is reviewed cannot land, deploy or complete it — and is told who to hand it to.
func TestBuilderCannotLandItsOwnWork(t *testing.T) {
	builder := &session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("engineer")}}
	for _, name := range []string{"duty_integrate", "duty_complete", "altengine_deploy_static", "altengine_deploy_function"} {
		got := guard(builder, name, map[string]any{"duty_id": "d1"})
		if !strings.Contains(got, "QA (`qa`)") || !strings.Contains(got, "duty_handoff") {
			t.Errorf("%s as Engineer: %q", name, got)
		}
	}
	for _, name := range []string{"duty_handoff", "duty_checkpoint", "duty_fail", "board_memory_write"} {
		if got := guard(builder, name, map[string]any{"duty_id": "d1"}); got != "" {
			t.Errorf("%s as Engineer was refused: %s", name, got)
		}
	}
	if got := guard(builder, "duty_handoff", map[string]any{"duty_id": "other"}); got == "" {
		t.Error("a session handed on a duty that is not its own")
	}

	// The reviewer lands it, by the usual rule: integrate first.
	reviewer := &session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("qa")}}
	if got := guard(reviewer, "duty_integrate", nil); got != "" {
		t.Errorf("QA could not land: %s", got)
	}
	if got := guard(reviewer, "duty_complete", map[string]any{"duty_id": "d1"}); !strings.Contains(got, "duty_integrate first") {
		t.Errorf("QA completing before landing: %q", got)
	}
	// The role that reads duties first may finish the trivial ones itself.
	officer := &session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("duty-officer")}}
	if got := guard(officer, "duty_integrate", nil); got != "" {
		t.Errorf("the Duty Officer could not land a trivial change: %s", got)
	}

	// No team: nothing to hand on to, and nothing else changes.
	alone := &session{board: "b", run: &Run{DutyID: "d1", Kind: "work"}}
	if got := guard(alone, "duty_handoff", map[string]any{"duty_id": "d1"}); !strings.Contains(got, "not being worked by a team") {
		t.Errorf("handoff with no team: %q", got)
	}
	if got := guard(alone, "duty_integrate", nil); got != "" {
		t.Errorf("a duty with no team could not land: %s", got)
	}
	if got := guard(alone, "board_roster_submit", map[string]any{"duty_id": "d1"}); got == "" {
		t.Error("ordinary work handed in a team")
	}
	drafting := &session{board: "b", run: &Run{DutyID: "d1", Kind: "roster"}}
	if got := guard(drafting, "board_roster_submit", map[string]any{"duty_id": "d1"}); got != "" {
		t.Errorf("a roster duty could not hand its team in: %s", got)
	}
}

// What a session is offered matches what it may do, and duty_handoff names exactly who it can go to.
func TestToolsOfferedFollowTheRole(t *testing.T) {
	d := &Daemon{views: map[string]board.BoardView{}}
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"tools":[
 {"name":"duty_complete"},{"name":"duty_fail"},{"name":"duty_checkpoint"},{"name":"board_roster_submit"},
 {"name":"board_memory"},{"name":"board_memory_write"},{"name":"board_roster"},
 {"name":"duty_handoff","description":"generic","inputSchema":{"properties":{"to_role":{"type":"string"}}}}
 ]}}`)
	offered := func(s *session) (map[string]string, []string) {
		t.Helper()
		out, err := d.filterTools(raw, s)
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			Result struct {
				Tools []struct {
					Name, Description string
					InputSchema       struct {
						Properties struct {
							ToRole struct{ Enum []string } `json:"to_role"`
						}
					}
				}
			}
		}
		if err := json.Unmarshal(out, &env); err != nil {
			t.Fatal(err)
		}
		found := map[string]string{}
		var to []string
		for _, tool := range env.Result.Tools {
			found[tool.Name] = tool.Description
			if tool.Name == "duty_handoff" {
				to = tool.InputSchema.Properties.ToRole.Enum
			}
		}
		return found, to
	}
	has := func(m map[string]string, name string) bool { _, ok := m[name]; return ok }

	builder, to := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("engineer")}})
	if has(builder, "duty_complete") || has(builder, "duty_integrate") || has(builder, "board_roster_submit") {
		t.Errorf("the Engineer was offered what it may not call: %v", builder)
	}
	if strings.Join(to, ",") != "duty-officer,qa" {
		t.Errorf("the Engineer can hand to %v", to)
	}
	for _, want := range []string{"working it as Engineer", "cannot land or complete it yourself", "QA (`qa`)", "`qa` (QA): Verifies the work."} {
		if !strings.Contains(builder["duty_handoff"], want) {
			t.Errorf("duty_handoff for the Engineer does not say %q:\n%s", want, builder["duty_handoff"])
		}
	}
	for _, name := range []string{"duty_fail", "duty_checkpoint", "board_memory", "board_memory_write", "board_roster", "tools_list"} {
		if !has(builder, name) {
			t.Errorf("the Engineer is missing %s", name)
		}
	}

	reviewer, _ := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("qa")}})
	if !has(reviewer, "duty_complete") || !has(reviewer, "duty_integrate") || !strings.Contains(reviewer["duty_handoff"], "hand it back") {
		t.Errorf("QA's tools: %v", reviewer)
	}
	officer, _ := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("duty-officer")}})
	if !strings.Contains(officer["duty_handoff"], "You read this duty first") {
		t.Errorf("the Duty Officer's handoff: %s", officer["duty_handoff"])
	}

	alone, _ := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work"}})
	if has(alone, "duty_handoff") || has(alone, "board_roster_submit") || !has(alone, "duty_complete") || !has(alone, "board_memory_write") {
		t.Errorf("a duty with no team: %v", alone)
	}
	drafting, _ := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "roster"}})
	if !has(drafting, "board_roster_submit") || has(drafting, "duty_handoff") {
		t.Errorf("a roster duty: %v", drafting)
	}
	review, _ := offered(&session{board: "b", run: &Run{DutyID: "d1", Kind: "note_review"}})
	if has(review, "board_memory_write") || has(review, "duty_handoff") || has(review, "board_roster_submit") || !has(review, "board_memory") {
		t.Errorf("a note review: %v", review)
	}
}

// The instructions a session's MCP connection opens with say who it is and what to write down.
func TestSessionInstructionsNameTheRole(t *testing.T) {
	reply := json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"instructions":"generic"}}`)
	said := func(s *session) string {
		t.Helper()
		out, err := sessionInstructions(reply, s)
		if err != nil {
			t.Fatal(err)
		}
		var env struct{ Result struct{ Instructions string } }
		if err := json.Unmarshal(out, &env); err != nil {
			t.Fatal(err)
		}
		return env.Result.Instructions
	}
	builder := said(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("engineer")}})
	for _, want := range []string{"you are its Engineer", "You do not land, deploy or complete this duty", "QA (`qa`)", "board_memory_write"} {
		if !strings.Contains(builder, want) {
			t.Errorf("the Engineer's instructions do not say %q", want)
		}
	}
	if got := said(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work", team: softwareTeam("qa")}}); !strings.Contains(got, "You are the check before this counts") {
		t.Error("QA is not told it is the check")
	}
	alone := said(&session{board: "b", run: &Run{DutyID: "d1", Kind: "work"}})
	if strings.Contains(alone, "worked by a team") || !strings.Contains(alone, "board_memory_write") {
		t.Errorf("a duty with no team: %s", alone)
	}
	if got := said(&session{board: "b", run: &Run{DutyID: "d1", Kind: "note_review"}}); strings.Contains(got, "board_memory_write") {
		t.Error("a note review is told to write the memory it may not write")
	}
}

// One role's conversation is never resumed by another; the same role's is.
func TestAnotherRoleStartsItsOwnSession(t *testing.T) {
	rec := state.RunRecord{}
	if prepareRole(&rec, "duty-officer", false) || rec.Role != "duty-officer" {
		t.Fatalf("a first session: %#v", rec)
	}
	rec.Session, rec.Attempts = "officer-session", 2
	if !prepareRole(&rec, "duty-officer", true) || rec.Session != "officer-session" || rec.Attempts != 2 {
		t.Fatalf("the same role did not resume its own session: %#v", rec)
	}
	if prepareRole(&rec, "engineer", true) || rec.Session == "officer-session" || rec.Attempts != 0 || rec.Role != "engineer" {
		t.Fatalf("the Engineer resumed the Duty Officer's session: %#v", rec)
	}
	built := rec.Session
	if prepareRole(&rec, "qa", false) || rec.Session == built {
		t.Fatalf("QA was given the Engineer's session id: %#v", rec)
	}
	// A board with no team, before and after: nothing is disturbed.
	plain := state.RunRecord{Session: "s", Attempts: 1}
	if !prepareRole(&plain, "", true) || plain.Session != "s" || plain.Attempts != 1 {
		t.Fatalf("a duty with no team lost its session: %#v", plain)
	}
}
