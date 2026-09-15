package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Claude is Claude Code, run headless: `claude -p` with its stream-json output.
type Claude struct{}

func (Claude) Name() string { return DefaultAgent }

// claudeBinary is the Claude Code executable: $DUTYBOARD_CLAUDE, or `claude` on PATH.
func claudeBinary() string {
	if b := os.Getenv("DUTYBOARD_CLAUDE"); b != "" {
		return b
	}
	return "claude"
}

func (Claude) Check(context.Context) error {
	if _, err := exec.LookPath(claudeBinary()); err != nil {
		return fmt.Errorf("Claude Code is not installed on this machine (%v) — install it and sign in, or set DUTYBOARD_CLAUDE", err)
	}
	return nil
}

// claudeTools is what a session may use without asking when the board does not say. Headless, a
// tool that needs permission is a tool that is refused, so the list is what real work needs.
// PowerShell is Claude Code's shell tool on Windows, as Bash is elsewhere: without it every command a
// Windows session runs — node, npm, godot, the project's own scripts — waits for an approval nobody
// is there to give.
var claudeTools = []string{"Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Bash", "PowerShell", "Agent", "TodoWrite", "WebFetch", "WebSearch"}

func (c Claude) Run(ctx context.Context, j Job) Outcome {
	if err := c.Check(ctx); err != nil {
		return Outcome{Err: err}
	}
	if j.SessionDir != "" {
		defer os.RemoveAll(j.SessionDir)
	}
	args, err := claudeArgs(j)
	if err != nil {
		return Outcome{Err: err}
	}
	return runProcess(ctx, j, claudeBinary(), args, nil, &claudeStream{dir: j.Dir, last: time.Now()})
}

// claudeArgs builds the command line for a job, writing the session's MCP config into its SessionDir.
func claudeArgs(j Job) ([]string, error) {
	args := []string{"-p", j.Prompt, "--output-format", "stream-json", "--verbose"}
	// A session another agent started (its id carries that agent's prefix) is not one Claude Code can
	// continue: it starts a new one, and says its id in its first event.
	if id := j.SessionID; id != "" && !strings.Contains(id, ":") {
		if j.Resume {
			args = append(args, "--resume", id)
		} else {
			args = append(args, "--session-id", id)
		}
	}
	if j.Instructions != "" {
		args = append(args, "--append-system-prompt", j.Instructions)
	}
	if len(j.MCPServers) > 0 {
		p, err := writeClaudeMCPConfig(j)
		if err != nil {
			return nil, err
		}
		// Only these servers: whatever else is in this user's own Claude Code setup is theirs, not the
		// board's, and a session should reach nothing a board's owner did not put on it.
		args = append(args, "--mcp-config", p, "--strict-mcp-config")
	}
	mode := j.Access.Mode
	if mode == "" {
		mode = "acceptEdits"
	}
	args = append(args, "--permission-mode", mode)
	args = append(args, "--allowedTools", strings.Join(claudeAllowed(j), ","))
	if j.Model != "" {
		args = append(args, "--model", j.Model)
	}
	if j.Effort != "" {
		args = append(args, "--effort", j.Effort)
	}
	for _, d := range j.AddDirs {
		args = append(args, "--add-dir", d)
	}
	if j.Name != "" {
		args = append(args, "-n", j.Name)
	}
	return args, nil
}

// claudeAllowed is the default tools, the board's own, and each MCP server's: all of a server's
// tools by its prefix, or the ones it lists.
func claudeAllowed(j Job) []string {
	out := append([]string{}, claudeTools...)
	seen := map[string]bool{}
	for _, t := range out {
		seen[t] = true
	}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for _, t := range j.Access.Tools {
		add(t)
	}
	for _, s := range j.MCPServers {
		if len(s.Tools) == 0 {
			add("mcp__" + s.Name)
			continue
		}
		for _, t := range s.Tools {
			add("mcp__" + s.Name + "__" + t)
		}
	}
	return out
}

func writeClaudeMCPConfig(j Job) (string, error) {
	if j.SessionDir == "" {
		return "", fmt.Errorf("a session with MCP servers needs a SessionDir for its config")
	}
	servers := map[string]any{}
	for _, s := range j.MCPServers {
		if s.URL != "" {
			entry := map[string]any{"type": "http", "url": s.URL}
			if len(s.Secrets) > 0 {
				entry["headers"] = s.Secrets
			}
			servers[s.Name] = entry
			continue
		}
		entry := map[string]any{"type": "stdio", "command": s.Command, "args": s.Args}
		if s.Args == nil {
			entry["args"] = []string{}
		}
		env := map[string]string{}
		for k, v := range s.Env {
			env[k] = v
		}
		for k, v := range s.Secrets {
			env[k] = v
		}
		if len(env) > 0 {
			entry["env"] = env
		}
		servers[s.Name] = entry
	}
	b, err := json.MarshalIndent(map[string]any{"mcpServers": servers}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(j.SessionDir, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(j.SessionDir, "mcp.json")
	// 0600: the servers' environment carries the session's own credentials.
	return p, os.WriteFile(p, b, 0o600)
}

// limitText is how a plan limit reads when it arrives as the result rather than as an event.
var limitText = regexp.MustCompile(`(?i)usage limit reached(?:\|(\d{9,}))?`)

type claudeStream struct {
	dir  string
	last time.Time // when an activity was last said, for "Thinking"
}

func (s *claudeStream) Read(line []byte, out *Outcome) string {
	readClaudeEvent(line, out)
	if a := claudeActivity(line, s.dir); a != "" {
		s.last = time.Now()
		return a
	}
	if claudeThinking(line) && time.Since(s.last) > 20*time.Second {
		// Long thinking between tool calls otherwise leaves the last file it read on the board as if
		// that were still happening.
		s.last = time.Now()
		return "Thinking"
	}
	return ""
}

func readClaudeEvent(line []byte, out *Outcome) {
	var ev struct {
		Type         string  `json:"type"`
		SessionID    string  `json:"session_id"`
		Result       string  `json:"result"`
		IsError      bool    `json:"is_error"`
		TotalCostUSD float64 `json:"total_cost_usd"`
		Denials      []struct {
			ToolName  string         `json:"tool_name"`
			ToolInput map[string]any `json:"tool_input"`
		} `json:"permission_denials"`
		RateLimitInfo *struct {
			Status   string `json:"status"`
			ResetsAt int64  `json:"resetsAt"`
		} `json:"rate_limit_info"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return
	}
	if ev.SessionID != "" {
		out.Session = ev.SessionID
	}
	switch ev.Type {
	case "rate_limit_event":
		if ev.RateLimitInfo != nil && ev.RateLimitInfo.Status == "rejected" {
			out.Limited = true
			if ev.RateLimitInfo.ResetsAt > 0 {
				out.ResetsAt = time.Unix(ev.RateLimitInfo.ResetsAt, 0)
			}
		}
	case "result":
		out.Result, out.IsError, out.Cost = ev.Result, ev.IsError, ev.TotalCostUSD
		for _, dn := range ev.Denials {
			what := dn.ToolName
			if c, ok := dn.ToolInput["command"].(string); ok {
				what += ": " + c
			}
			out.Denied = append(out.Denied, what)
		}
		if m := limitText.FindStringSubmatch(ev.Result); m != nil && ev.IsError {
			out.Limited = true
			if n, err := strconv.ParseInt(m[1], 10, 64); err == nil {
				out.ResetsAt = time.Unix(n, 0)
			}
		}
	}
}

func claudeThinking(line []byte) bool {
	return len(line) < 400 && strings.Contains(string(line), `"thinking_tokens"`)
}

// claudeActivity is the line a person reads for one stream event: what the agent just started
// doing, or "" for an event that is not the start of something. Paths are shown relative to dir.
func claudeActivity(line []byte, dir string) string {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			Content []struct {
				Type  string         `json:"type"`
				Name  string         `json:"name"`
				Input map[string]any `json:"input"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &ev) != nil || ev.Type != "assistant" {
		return ""
	}
	last := ""
	for _, c := range ev.Message.Content {
		if c.Type == "tool_use" {
			last = describeClaudeTool(c.Name, c.Input, dir)
		}
	}
	return last
}

func describeClaudeTool(name string, in map[string]any, dir string) string {
	str := func(k string) string { s, _ := in[k].(string); return strings.TrimSpace(s) }
	rel := func(p string) string {
		if p == "" {
			return ""
		}
		if r, err := filepath.Rel(dir, p); err == nil && !strings.HasPrefix(r, "..") {
			return filepath.ToSlash(r)
		}
		return p
	}
	switch name {
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		return "Editing " + rel(str("file_path")+str("notebook_path"))
	case "Read":
		return "Reading " + rel(str("file_path"))
	case "Bash", "PowerShell":
		if d := str("description"); d != "" {
			return oneLine(d, 100)
		}
		return "Running `" + oneLine(str("command"), 90) + "`"
	case "Grep", "Glob":
		return "Searching for " + oneLine(str("pattern"), 80)
	case "Agent", "Task":
		return "Delegating: " + oneLine(str("description"), 90)
	case "WebFetch":
		return "Reading " + oneLine(str("url"), 90)
	case "WebSearch":
		return "Searching the web for " + oneLine(str("query"), 80)
	case "TodoWrite":
		return "Planning"
	}
	if server, tool, ok := strings.Cut(strings.TrimPrefix(name, "mcp__"), "__"); ok && strings.HasPrefix(name, "mcp__") {
		return DescribeMCPTool(server, tool)
	}
	return "Using " + name
}

// DescribeMCPTool is the activity line for a call to an MCP server's tool, which reads the same
// whichever agent made it.
func DescribeMCPTool(server, tool string) string {
	if server == "dutyboard" {
		switch tool {
		case "duty_integrate":
			return "Integrating its work"
		case "duty_checkpoint":
			return "Writing on the duty's thread"
		case "duty_complete":
			return "Completing the duty"
		case "board_rules_submit":
			return "Handing in the rules"
		case "board_profile_propose":
			return "Recording the project's setup"
		case "tools_register":
			return "Registering a tool"
		}
		return "Using " + tool
	}
	return "Using " + server + ": " + tool
}

func oneLine(s string, n int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i] + " …"
	}
	if len(s) > n {
		s = s[:n] + "…"
	}
	return s
}
