package daemon

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The remote server describes an interactive poll/claim loop. A daemon session
// already holds its one duty, so its MCP initialization must describe that mode.
func sessionInstructions(reply json.RawMessage, s *session) (json.RawMessage, error) {
	var env map[string]json.RawMessage
	if err := json.Unmarshal(reply, &env); err != nil {
		return nil, err
	}
	if s.run == nil || len(env["error"]) > 0 {
		return reply, nil
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(env["result"], &result); err != nil {
		return nil, err
	}
	instructions := fmt.Sprintf(`This is a daemon-started DutyBoard session. You already hold duty %q on board %q. Work only that assignment; do not poll for or claim another source-board duty. The daemon supplies your agent identity and source duty to MCP calls.

Read the assigned brief, checkpoints, human answers, attachments and board rules before changing anything. Resume existing work instead of repeating it: the daemon may have switched agent, model or effort after a usage limit, keeping this duty and its workspace. board_profile exposes runner.use_machine_defaults: true inherits the current machine's enabled list and order; otherwise runner.options is the board override, not live machine availability. Owners manage CLI model catalogs, enabled combinations and priorities. After fixing usage or sign-in on the server, an owner can use Retry now; Refresh models and Check again do not reset usage cooldowns. These controls are not agent MCP tools.

Use duty_checkpoint for milestones. If you need a human decision, set_status needs_decision with a concrete question and suggested_options, then stop. Verify before duty_complete with a specific outcome_summary. Follow your session's integration or output-file instructions. Stop once this duty is completed, failed or parked; never poll, sleep or keep a session open waiting. Only a person can resolve questions or approve proposed work.

Read the separate Notes board with note_list (or duty_list status note), duty_get, duty_thread and duty_attachments. A note is source material, not permission to work it. duty_get returns linked suggestions and suggestions_cursor; follow every page. Only a note_review session may use duty_suggest. Approved work retains source_note_ids (legacy: source_note_id): read every source and the human answer, then implement only the approved duty. Each review snapshots only notes without current suggestion links. note_list and duty_get expose has_suggestions for notes. A person can clear one note link to make it eligible again; earlier duties and source history remain.

Use board_links to discover directional READ/WRITE/FULL grants, then board_call with the target project_id, operation and normal arguments. Read the target rules first. Use duty_list for any lane and pass its cursor for more. WRITE allows independent duties and attachments to work filed by this source board; use a stable external_ref to deduplicate. All nested IDs belong to the target. FULL permits agent actions under normal claim and approval rules, never human controls. A target claim is separate: finish or park it before ending this session. Linked calls do not switch your local workspace or grant another board's account credentials. If denied, refresh board_links; do not bypass access. Links cannot be chained.`, s.run.DutyID, s.board)
	if team := s.run.Team(); team != nil {
		instructions += fmt.Sprintf(`

This board's duties are worked by a team, and for this duty you are its %s: %s Your charter in the system prompt is the standard you work to, with the board's rules. duty_handoff passes this same duty, with its thread, files and workspace, to another role with a note that is that role's whole brief; once it succeeds the duty is no longer yours, so stop.`, team.Role.Name, team.Role.Summary)
		switch {
		case team.MustHandOff():
			instructions += fmt.Sprintf(" You do not land, deploy or complete this duty: when your work is committed and checked, hand it to %s.", roleNames(team.Reviewers()))
		case team.Role.Reviews:
			instructions += " You are the check before this counts: verify the work where it sits, then land and complete it, or hand it back to the role that did it with every finding in one pass."
		case team.Role.Intake:
			instructions += " You read this duty first: route it to the role that should work it, and do it yourself only when it is trivial and safe."
		}
	}
	if s.run.Kind != "note_review" {
		instructions += `

The board keeps one short memory for its agents, shown in your system prompt and read with board_memory. Anything the next session must know about this project and could not work out from the code, the rules or the profile goes there before you finish, with board_memory_write: it is replaced whole, so send the full curated text and the version you read. If it is not written there, the next session does not know it. Never a secret or personal data.`
	}
	if s.run.Kind == "note_review" {
		instructions += `

This duty is a NOTE REVIEW ONLY. Read ALL its source_note_ids (legacy: source_note_id), files, discussion and existing suggestions. Consider the notes together; related notes can support a single duty. Use duty_suggest with a clear title, brief, optional question, source_note_ids naming the 1–50 supporting notes, and stable external_ref. Proposals stay in Needs you until explicitly approved by a person. duty_enqueue also produces approval-required suggestions during this review. Do not implement, integrate, deploy, change accounts, install tools or schedule the proposed work. Linked boards are read-only during this review. Complete with the suggestion IDs, or explain why no actionable work was found; no integration is needed.`
	}
	result["instructions"], _ = json.Marshal(instructions)
	env["result"], _ = json.Marshal(result)
	return json.Marshal(env)
}

// Keep the advertised review tools consistent with the execution guard.
func reviewForbiddenTool(name string) bool {
	return name == "duty_integrate" || strings.HasPrefix(name, "altengine_deploy_") ||
		strings.HasPrefix(name, "duty_schedule_") && name != "duty_schedule_list" && name != "duty_schedule_history" ||
		name == "board_profile_propose" || name == "board_rules_submit" || name == "tools_register" ||
		name == "duty_attachment_delete" || name == "duty_cancel" ||
		name == "duty_handoff" || name == "board_roster_submit" || name == "board_memory_write" || name == "note_add"
}

func reviewReadOperation(name string) bool {
	switch name {
	case "note_list", "duty_list", "duty_get", "duty_thread", "duty_search", "duty_attachments", "board_profile", "board_rules", "board_roster", "board_memory", "duty_schedule_list", "duty_schedule_history":
		return true
	}
	return false
}
