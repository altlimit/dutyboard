package daemon

import "testing"

func TestNoteReviewCannotLandOrScheduleWork(t *testing.T) {
	s := &session{board: "board", agent: "agent", run: &Run{DutyID: "review", Kind: "note_review"}}
	for _, name := range []string{"duty_integrate", "altengine_deploy_static", "altengine_deploy_function", "duty_schedule_create", "duty_schedule_update", "duty_schedule_delete", "board_profile_propose", "board_rules_submit", "tools_register"} {
		if got := guard(s, name, map[string]any{"duty_id": "review"}); got == "" {
			t.Errorf("review allowed %s", name)
		}
	}
	for _, name := range []string{"duty_suggest", "duty_enqueue", "duty_get", "duty_attachments", "duty_schedule_list", "duty_complete"} {
		if got := guard(s, name, map[string]any{"duty_id": "review"}); got != "" {
			t.Errorf("review refused %s: %s", name, got)
		}
	}
	if got := guard(s, "duty_complete", map[string]any{"duty_id": "suggested"}); got == "" {
		t.Fatal("review may not complete another duty")
	}
	s.run.Kind = "work"
	if got := guard(s, "duty_complete", map[string]any{"duty_id": "review"}); got == "" {
		t.Fatal("ordinary work still requires integration")
	}
}

func TestLinkedBoardCallsRespectReviewBoundary(t *testing.T) {
	s := &session{board: "source", run: &Run{DutyID: "review", Kind: "note_review"}}
	for _, op := range []string{"duty_enqueue", "duty_complete", "board_rules_submit", "duty_schedule_create", "unknown"} {
		if guard(s, "board_call", map[string]any{"project_id": "target", "operation": op}) == "" {
			t.Errorf("review allowed %s through a board link", op)
		}
	}
	for _, op := range []string{"duty_list", "board_rules", "duty_attachments"} {
		if got := guard(s, "board_call", map[string]any{"project_id": "target", "operation": op}); got != "" {
			t.Errorf("review refused %s: %s", op, got)
		}
	}
	s.run.Kind = "work"
	if got := guard(s, "board_call", map[string]any{"project_id": "target", "operation": "duty_checkpoint"}); got != "" {
		t.Fatal(got)
	}
	if got := guard(s, "duty_checkpoint", map[string]any{"duty_id": "other"}); got == "" {
		t.Fatal("ordinary tools must remain scoped to the source duty")
	}
}
