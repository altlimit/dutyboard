package runner

import (
	"strings"
	"testing"
)

func TestCodexArgs(t *testing.T) {
	j := Job{
		Dir: "/w", Prompt: "do it\nnow", Instructions: "how\n\"quoted\"", SessionID: "0000-uuid-from-the-daemon", Effort: "max",
		Writable: []string{"/clone/.git", "/tools"},
		MCPServers: []MCPServer{
			{Name: "dutyboard", Command: "/bin/dutyboard", Args: []string{"mcp"}, Env: map[string]string{"DUTYBOARD_HOME": "/h"}, Secrets: map[string]string{"DUTYBOARD_RUN_TOKEN": "t"}},
			{Name: "docs", URL: "https://docs.example/mcp", Secrets: map[string]string{"Authorization": "Bearer x"}, Tools: []string{"search"}},
		},
	}
	args, env := codexArgs(j)
	line := strings.Join(args, " ")
	for _, want := range []string{
		`exec --json --skip-git-repo-check`,
		`-c approval_policy="never"`,
		`-c sandbox_mode="workspace-write"`,
		`-c sandbox_workspace_write.network_access=true`,
		`-c sandbox_workspace_write.writable_roots=["/clone/.git", "/tools"]`,
		`-c model_reasoning_effort="xhigh"`,
		`-c developer_instructions="how\n\"quoted\""`,
		`-c mcp_servers.dutyboard.command="/bin/dutyboard"`,
		`-c mcp_servers.dutyboard.args=["mcp"]`,
		`-c mcp_servers.dutyboard.env={"DUTYBOARD_HOME" = "/h"}`,
		`-c mcp_servers.dutyboard.env_vars=["DUTYBOARD_RUN_TOKEN"]`,
		`-c mcp_servers.docs.url="https://docs.example/mcp"`,
		`-c mcp_servers.docs.env_http_headers={"Authorization" = "DUTYBOARD_MCP_DOCS_AUTHORIZATION"}`,
		`-c mcp_servers.docs.enabled_tools=["search"]`,
	} {
		if !strings.Contains(line, want) {
			t.Errorf("args lack %s:\n%s", want, line)
		}
	}
	if args[len(args)-1] != j.Prompt || strings.Contains(line, "resume") {
		t.Errorf("a new session ends with the prompt and resumes nothing: %q", args)
	}
	if strings.Contains(line, "Bearer x") || strings.Contains(line, `"t"`) {
		t.Errorf("a secret is on the command line: %s", line)
	}
	if !contains(env, "DUTYBOARD_RUN_TOKEN=t") || !contains(env, "DUTYBOARD_MCP_DOCS_AUTHORIZATION=Bearer x") {
		t.Errorf("secrets should travel in the environment: %q", env)
	}

	j.Resume = true
	if args, _ := codexArgs(j); strings.Contains(strings.Join(args, " "), "resume") {
		t.Error("a session id Codex did not give cannot be resumed")
	}
	j.SessionID = "codex:01a0a59f"
	args, _ = codexArgs(j)
	if args[1] != "resume" || args[len(args)-2] != "01a0a59f" {
		t.Errorf("resuming a Codex session: %q", args)
	}

	j.Access.Mode = "bypassPermissions"
	if args, _ := codexArgs(j); !strings.Contains(strings.Join(args, " "), "--dangerously-bypass-approvals-and-sandbox") {
		t.Error("a board that bypasses permissions runs Codex without its sandbox")
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestCodexStream(t *testing.T) {
	s := &codexStream{dir: "/w"}
	var o Outcome
	read := func(line string) string { return s.Read([]byte(line), &o) }

	read(`{"type":"thread.started","thread_id":"01a0a59f-6133"}`)
	if o.Session != "codex:01a0a59f-6133" {
		t.Fatalf("session: %q", o.Session)
	}
	for line, want := range map[string]string{
		`{"type":"item.started","item":{"type":"command_execution","command":"bash -lc 'npm test'","status":"in_progress"}}`: "Running `npm test`",
		`{"type":"item.started","item":{"type":"file_change","changes":[{"path":"/w/src/app.ts","kind":"update"}]}}`:         "Editing src/app.ts",
		`{"type":"item.started","item":{"type":"mcp_tool_call","server":"dutyboard","tool":"duty_integrate"}}`:               "Integrating its work",
		`{"type":"item.started","item":{"type":"mcpToolCall","server":"docs","tool":"search"}}`:                              "Using docs: search",
		`{"type":"item.started","item":{"type":"reasoning"}}`:                                                                "",
	} {
		if got := read(line); got != want {
			t.Errorf("%s → %q, want %q", line, got, want)
		}
	}

	read(`{"type":"error","message":"Reconnecting... 2/5 (usage limit)"}`)
	if o.Limited {
		t.Error("a reconnect notice is not a plan limit")
	}
	read(`{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again at 3:00 PM."}}`)
	if !o.Limited || !o.IsError {
		t.Errorf("a turn failed on the usage limit: %+v", o)
	}
}
