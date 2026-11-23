package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestActivity(t *testing.T) {
	dir := "/home/me/.dutyboard/worktrees/game/duty_1"
	cases := map[string]string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/home/me/.dutyboard/worktrees/game/duty_1/src/ui/pause.gd"}}]}}`: "Editing src/ui/pause.gd",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"tools/run_tests.sh --all\necho done"}}]}}`:                         "Running `tools/run_tests.sh --all …`",
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"x","description":"Run the unit tests"}}]}}`:                        "Run the unit tests",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"},{"type":"tool_use","name":"mcp__dutyboard__duty_integrate","input":{}}]}}`:            "Integrating its work",
		`{"type":"assistant","message":{"content":[{"type":"text","text":"just talking"}]}}`:                                                                               "",
		`{"type":"result","result":"done"}`: "",
	}
	for line, want := range cases {
		if got := claudeActivity([]byte(line), dir); got != want {
			t.Errorf("Activity(%s) = %q, want %q", line, got, want)
		}
	}
}

func TestLimitIsRead(t *testing.T) {
	var o Outcome
	readClaudeEvent([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789410000}}`), &o)
	if !o.Limited || o.ResetsAt.Unix() != 1789410000 {
		t.Fatalf("a rejected rate limit event should mark the session limited: %+v", o)
	}
	o = Outcome{}
	readClaudeEvent([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789410000}}`), &o)
	if o.Limited {
		t.Fatal("an allowed rate limit event is not a limit")
	}
}

func TestRefusedToolsAreRead(t *testing.T) {
	var o Outcome
	readClaudeEvent([]byte(`{"type":"result","result":"stopped","permission_denials":[{"tool_name":"PowerShell","tool_use_id":"t1","tool_input":{"command":"npm ci"}},{"tool_name":"WebFetch","tool_input":{"url":"https://x"}}]}`), &o)
	if len(o.Denied) != 2 || o.Denied[0] != "PowerShell: npm ci" || o.Denied[1] != "WebFetch" {
		t.Fatalf("denials: %q", o.Denied)
	}
}

func TestClaudeArgs(t *testing.T) {
	dir := t.TempDir()
	j := Job{
		Dir: dir, Prompt: "do it", Instructions: "how", SessionID: "s1", SessionDir: filepath.Join(dir, "session"),
		Access: Access{Tools: []string{"Bash(git log:*)"}},
		MCPServers: []MCPServer{
			{Name: "dutyboard", Command: "/bin/dutyboard", Args: []string{"mcp"}, Secrets: map[string]string{"DUTYBOARD_RUN_TOKEN": "t"}},
			{Name: "playwright", Command: "npx", Args: []string{"@playwright/mcp"}, Tools: []string{"browser_take_screenshot"}},
			{Name: "docs", URL: "https://docs.example/mcp", Secrets: map[string]string{"Authorization": "Bearer x"}},
		},
	}
	args, err := claudeArgs(j)
	if err != nil {
		t.Fatal(err)
	}
	flag := func(name string) string {
		for i, a := range args {
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if flag("--session-id") != "s1" || flag("--append-system-prompt") != "how" || flag("--permission-mode") != "acceptEdits" {
		t.Errorf("args: %q", args)
	}
	allowed := flag("--allowedTools")
	for _, want := range []string{"Bash", "Edit", "Bash(git log:*)", "mcp__dutyboard", "mcp__playwright__browser_take_screenshot", "mcp__docs"} {
		if !strings.Contains(","+allowed+",", ","+want+",") {
			t.Errorf("--allowedTools %q lacks %q", allowed, want)
		}
	}
	if strings.Contains(allowed, "mcp__playwright,") {
		t.Errorf("a server that lists its tools should not be allowed whole: %q", allowed)
	}

	b, err := os.ReadFile(flag("--mcp-config"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Servers["dutyboard"]["command"] != "/bin/dutyboard" || cfg.Servers["docs"]["type"] != "http" || cfg.Servers["docs"]["url"] != "https://docs.example/mcp" {
		t.Errorf("mcp config: %s", b)
	}

	j.Resume, j.Access.Mode = true, "bypassPermissions"
	args, _ = claudeArgs(j)
	if flag("--resume") != "s1" || flag("--session-id") != "" || flag("--permission-mode") != "bypassPermissions" {
		t.Errorf("resuming args: %q", args)
	}
}

func TestAgents(t *testing.T) {
	if a, err := For(""); err != nil || a.Name() != "claude-code" {
		t.Fatalf("the default agent: %v %v", a, err)
	}
	if _, err := For("nobody"); err == nil || !strings.Contains(err.Error(), "claude-code") {
		t.Fatalf("an unknown agent should say which are known: %v", err)
	}
}

func TestClaudeHookSettings(t *testing.T) {
	dir := t.TempDir()
	j := Job{Dir: dir, Prompt: "do it", SessionDir: filepath.Join(dir, "session"), Hook: []string{"/opt/my tools/dutyboard", "hook"}}
	args, err := claudeArgs(j)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	p := filepath.Join(j.SessionDir, "settings.json")
	if !strings.Contains(joined, "--settings "+p) {
		t.Fatalf("no --settings in %q", joined)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Type, Command string
				Timeout       int
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	for _, event := range []string{"PostToolUse", "Stop"} {
		h := s.Hooks[event]
		if len(h) != 1 || len(h[0].Hooks) != 1 || h[0].Hooks[0].Type != "command" || h[0].Hooks[0].Command != `"/opt/my tools/dutyboard" "hook"` {
			t.Fatalf("%s hook: %s", event, b)
		}
	}
	if s.Hooks["PostToolUse"][0].Matcher != "*" {
		t.Fatalf("PostToolUse must run after every tool: %s", b)
	}

	j.Hook = nil
	if args, _ := claudeArgs(j); strings.Contains(strings.Join(args, " "), "--settings") {
		t.Fatal("no hook, no settings")
	}
}

func TestShellCommandQuotes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows paths are passed with forward slashes and hold no quotes")
	}
	if got := shellCommand([]string{`/a/$HOME/"x"`, "hook"}); got != `"/a/\$HOME/\"x\"" "hook"` {
		t.Fatalf("shellCommand = %s", got)
	}
}

func TestHookReply(t *testing.T) {
	if HookReply("PostToolUse", "") != nil {
		t.Fatal("nothing to say prints nothing")
	}
	var after struct {
		Out struct{ HookEventName, AdditionalContext string } `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(HookReply("PostToolUse", "A person wrote"), &after); err != nil || after.Out.HookEventName != "PostToolUse" || after.Out.AdditionalContext != "A person wrote" {
		t.Fatalf("after a tool: %+v %v", after, err)
	}
	var stop struct{ Decision, Reason string }
	if err := json.Unmarshal(HookReply("Stop", "A person wrote"), &stop); err != nil || stop.Decision != "block" || stop.Reason != "A person wrote" {
		t.Fatalf("at a stop: %+v %v", stop, err)
	}
}
