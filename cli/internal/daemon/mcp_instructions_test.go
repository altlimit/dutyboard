package daemon

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMCPInitializationMatchesSessionMode(t *testing.T) {
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":9,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"dutyboard"},"capabilities":{"tools":{}},"instructions":"Poll and claim work."}}`)
	for _, kind := range []string{"work", "note_review"} {
		s := &session{board: "source", run: &Run{DutyID: "assigned", Kind: kind}}
		out, err := sessionInstructions(raw, s)
		if err != nil {
			t.Fatal(err)
		}
		var got struct {
			ID     int
			Result struct {
				ProtocolVersion string
				Instructions    string
				ServerInfo      map[string]any
				Capabilities    map[string]any
			}
		}
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		if got.ID != 9 || got.Result.ProtocolVersion != "2025-06-18" || got.Result.ServerInfo["name"] != "dutyboard" || got.Result.Capabilities["tools"] == nil {
			t.Fatalf("initialization metadata changed: %s", out)
		}
		for _, want := range []string{"assigned", "source", "do not poll", "board_call", "runner.options", "Retry now", "suggestions_cursor"} {
			if !strings.Contains(got.Result.Instructions, want) {
				t.Errorf("%s instructions missing %q", kind, want)
			}
		}
		if strings.Contains(got.Result.Instructions, "NOTE REVIEW ONLY") != (kind == "note_review") {
			t.Fatal("wrong review mode")
		}
	}
	out, err := sessionInstructions(raw, &session{})
	if err != nil || string(out) != string(raw) {
		t.Fatal("interactive loop changed")
	}
	failure := json.RawMessage(`{"jsonrpc":"2.0","id":9,"error":{"code":-1,"message":"offline"}}`)
	out, err = sessionInstructions(failure, &session{run: &Run{DutyID: "assigned"}})
	if err != nil || string(out) != string(failure) {
		t.Fatal("upstream error changed")
	}
}

func TestMCPReviewDiscoveryMatchesGuards(t *testing.T) {
	d := &Daemon{}
	s := &session{board: "source", run: &Run{DutyID: "review", Kind: "note_review"}}
	raw := json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"tools":[
 {"name":"duty_suggest"},{"name":"duty_claim"},{"name":"duty_schedule_create"},
 {"name":"duty_schedule_list"},{"name":"duty_attachment_delete"},{"name":"duty_cancel"},
 {"name":"board_profile_propose"},{"name":"board_rules_submit"},
 {"name":"duty_poll"},{"name":"duty_enqueue"},{"name":"duty_checkpoint"},
 {"name":"board_call","inputSchema":{"properties":{"operation":{"enum":["board_rules","duty_list","duty_enqueue","duty_complete","unknown"]}}}}
 ]}}`)
	out, err := d.filterTools(raw, s)
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Result struct {
			Tools []struct {
				Name        string
				Description string
				InputSchema struct {
					Properties struct{ Operation struct{ Enum []string } }
				}
			}
		}
	}
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, tool := range env.Result.Tools {
		found[tool.Name] = true
		if tool.Name == "duty_enqueue" && !strings.Contains(tool.Description, "until a person approves") {
			t.Fatal("review enqueue instructions omitted the approval gate")
		}
		if tool.Name == "duty_checkpoint" && !strings.Contains(tool.Description, "stop this session") {
			t.Fatal("checkpoint still instructs a daemon session to claim more work")
		}
		if reviewForbiddenTool(tool.Name) || tool.Name == "duty_claim" {
			t.Errorf("review advertised forbidden tool %s", tool.Name)
		}
		if tool.Name == "board_call" {
			if len(tool.InputSchema.Properties.Operation.Enum) != 2 {
				t.Fatal("gateway did not filter writes")
			}
			for _, op := range tool.InputSchema.Properties.Operation.Enum {
				if got := guard(s, "board_call", map[string]any{"operation": op}); got != "" {
					t.Errorf("advertised operation refused: %s", got)
				}
			}
		}
	}
	for _, name := range []string{"duty_suggest", "duty_schedule_list", "board_call", "tools_list"} {
		if !found[name] {
			t.Errorf("review missing %s", name)
		}
	}
	for _, name := range []string{"duty_cancel", "duty_attachment_delete", "tools_register", "duty_integrate"} {
		if guard(s, name, nil) == "" {
			t.Errorf("unadvertised write still accepted: %s", name)
		}
	}
	s.run.Kind = "work"
	out, err = d.filterTools(raw, s)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"name":"duty_suggest"`) {
		t.Fatal("ordinary work advertised review-only tool")
	}
	if !strings.Contains(string(out), `"name":"duty_integrate"`) {
		t.Fatal("work lost integration")
	}
	if !strings.Contains(string(out), "the daemon will schedule the blocker") {
		t.Fatal("work enqueue omitted the daemon handoff")
	}
}
