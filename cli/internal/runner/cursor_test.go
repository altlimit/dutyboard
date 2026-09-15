package runner

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCursorArgs(t *testing.T) {
	j := Job{Dir: "/w", Prompt: "the duty", Instructions: "the rules", SessionID: "0000-daemon-uuid", Model: "gpt-5", Effort: "high", AddDirs: []string{"/local"}}
	args := cursorArgs(j)
	line := strings.Join(args, " ")
	for _, want := range []string{"-p --output-format stream-json --trust --approve-mcps --workspace /w", "--force", "--model gpt-5[effort=high]", "--add-dir /local"} {
		if !strings.Contains(line, want) {
			t.Errorf("args lack %q: %q", want, args)
		}
	}
	if last := args[len(args)-1]; !strings.HasPrefix(last, "the rules") || !strings.HasSuffix(last, "the duty") {
		t.Errorf("the prompt should carry the instructions first: %q", last)
	}
	if strings.Contains(line, "--resume") || strings.Contains(line, "--sandbox") {
		t.Errorf("a new session with default access: %q", args)
	}
	j.Resume, j.SessionID, j.Access.Mode = true, "cursor:abc-123", "bypassPermissions"
	line = strings.Join(cursorArgs(j), " ")
	if !strings.Contains(line, "--resume abc-123") || !strings.Contains(line, "--sandbox disabled") {
		t.Errorf("resuming with permissions bypassed: %s", line)
	}
}

func TestCursorStream(t *testing.T) {
	s := &cursorStream{dir: "/w"}
	var o Outcome
	read := func(l string) string { return s.Read([]byte(l), &o) }
	read(`{"type":"system","subtype":"init","session_id":"s-1","cwd":"/w"}`)
	if o.Session != "cursor:s-1" {
		t.Fatalf("session: %q", o.Session)
	}
	for line, want := range map[string]string{
		`{"type":"tool_call","subtype":"started","call_id":"1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}`:                                       "Running `npm test`",
		`{"type":"tool_call","subtype":"started","call_id":"2","tool_call":{"editToolCall":{"args":{"path":"/w/src/a.ts"}}}}`:                                        "Editing src/a.ts",
		`{"type":"tool_call","subtype":"started","call_id":"3","tool_call":{"mcpToolCall":{"args":{"providerIdentifier":"dutyboard","toolName":"duty_integrate"}}}}`: "Integrating its work",
		`{"type":"tool_call","subtype":"completed","call_id":"1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}`:                                     "",
	} {
		if got := read(line); got != want {
			t.Errorf("%s → %q, want %q", line, got, want)
		}
	}
	read(`{"type":"result","subtype":"error","is_error":true,"result":"You've hit your usage limit"}`)
	if !o.Limited || !o.IsError {
		t.Errorf("a usage limit: %+v", o)
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestCursorMCPFileStaysOutOfTheWork(t *testing.T) {
	ctx := context.Background()
	servers := []MCPServer{
		{Name: "dutyboard", Command: "/bin/dutyboard", Args: []string{"mcp"}, Secrets: map[string]string{"DUTYBOARD_RUN_TOKEN": "tok"}},
		{Name: "docs", URL: "https://docs.example/mcp", Tools: []string{"search"}},
		{Name: "private", URL: "https://private.example/mcp", Secrets: map[string]string{"Authorization": "Bearer x"}},
	}
	for _, tracked := range []bool{false, true} {
		dir := t.TempDir()
		gitIn(t, dir, "init", "-q")
		original := `{"mcpServers":{"theirs":{"command":"their-server"}}}`
		if tracked {
			os.MkdirAll(filepath.Join(dir, ".cursor"), 0o755)
			os.WriteFile(filepath.Join(dir, ".cursor", "mcp.json"), []byte(original), 0o644)
		} else {
			os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
		}
		gitIn(t, dir, "add", "-A")
		gitIn(t, dir, "commit", "-q", "-m", "start")

		j := Job{Dir: dir, SessionDir: filepath.Join(t.TempDir(), "session"), MCPServers: servers}
		restore, err := writeCursorMCP(ctx, j)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(filepath.Join(dir, ".cursor", "mcp.json"))
		var cfg struct {
			Servers map[string]map[string]any `json:"mcpServers"`
		}
		json.Unmarshal(b, &cfg)
		if cfg.Servers["dutyboard"]["envFile"] == nil || strings.Contains(string(b), "tok") || strings.Contains(string(b), "Bearer x") {
			t.Errorf("secrets must go by envFile, never into the worktree:\n%s", b)
		}
		if _, ok := cfg.Servers["private"]; ok {
			t.Error("a URL server with a secret was given to Cursor")
		}
		if cfg.Servers["docs"]["url"] != "https://docs.example/mcp" {
			t.Errorf("docs server: %v", cfg.Servers["docs"])
		}
		if tracked && cfg.Servers["theirs"] == nil {
			t.Error("the repository's own servers were dropped")
		}
		env, _ := os.ReadFile(cfg.Servers["dutyboard"]["envFile"].(string))
		if strings.TrimSpace(string(env)) != "DUTYBOARD_RUN_TOKEN=tok" {
			t.Errorf("env file: %q", env)
		}
		if status := gitIn(t, dir, "status", "--porcelain"); status != "" {
			t.Errorf("tracked=%v: the worktree looks changed during the session, which integration refuses: %q", tracked, status)
		}
		restore()
		after, err := os.ReadFile(filepath.Join(dir, ".cursor", "mcp.json"))
		if tracked && string(after) != original || !tracked && err == nil {
			t.Errorf("tracked=%v: not put back: %q %v", tracked, after, err)
		}
		if status := gitIn(t, dir, "status", "--porcelain"); status != "" {
			t.Errorf("tracked=%v: left the worktree changed: %q", tracked, status)
		}
	}
}
