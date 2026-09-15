package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Cursor is Cursor's agent CLI, run headless: `cursor-agent -p --output-format stream-json`.
//
// Its CLI takes no MCP config and no extra instructions on the command line, which shapes this file:
//
//   - MCP servers are read from the workspace's `.cursor/mcp.json`. The runner writes one into the
//     worktree for the session — hidden from git, and put back as it was afterwards — naming each
//     server's secrets by an `envFile` kept in the session's own folder, never in the worktree. A URL
//     server's secret would have to be a literal header in that file, so such a server is left out.
//   - The duty's instructions go at the top of the prompt.
//   - Its session ids are its own, announced in its first event, and kept as "cursor:<id>".
//
// It also loads the MCP servers in the user's own ~/.cursor/mcp.json; unlike Claude Code, it has no
// switch to use only the board's.
type Cursor struct{}

func (Cursor) Name() string { return "cursor" }

// cursorBinary is Cursor's agent: $DUTYBOARD_CURSOR, else `cursor-agent`, else `agent` on PATH.
func cursorBinary() string {
	if b := os.Getenv("DUTYBOARD_CURSOR"); b != "" {
		return b
	}
	if _, err := exec.LookPath("cursor-agent"); err == nil {
		return "cursor-agent"
	}
	return "agent"
}

var cursorLogin struct {
	sync.Mutex
	at  time.Time
	err error
}

// Check finds the CLI and asks it whether it is signed in (or has CURSOR_API_KEY), remembering the
// answer for a few minutes.
func (Cursor) Check(ctx context.Context) error {
	bin := cursorBinary()
	if _, err := exec.LookPath(bin); err != nil {
		return fmt.Errorf("Cursor's agent CLI is not installed on this machine (%v) — install it (curl https://cursor.com/install -fsS | bash) and run `cursor-agent login`, or set DUTYBOARD_CURSOR", err)
	}
	if os.Getenv("CURSOR_API_KEY") != "" {
		return nil
	}
	cursorLogin.Lock()
	defer cursorLogin.Unlock()
	if time.Since(cursorLogin.at) < 5*time.Minute {
		return cursorLogin.err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "status", "--format", "json").Output()
	cursorLogin.at, cursorLogin.err = time.Now(), nil
	var st struct {
		IsAuthenticated bool `json:"isAuthenticated"`
	}
	if err != nil || json.Unmarshal(bytes.TrimSpace(out), &st) != nil || !st.IsAuthenticated {
		cursorLogin.err = fmt.Errorf("Cursor's agent CLI is not signed in on this machine — run `cursor-agent login`, or set CURSOR_API_KEY")
	}
	return cursorLogin.err
}

func forgetCursorCheck() {
	cursorLogin.Lock()
	cursorLogin.at = time.Time{}
	cursorLogin.Unlock()
}

func (c Cursor) Run(ctx context.Context, j Job) Outcome {
	if err := c.Check(ctx); err != nil {
		return Outcome{Err: err}
	}
	restore, err := writeCursorMCP(ctx, j)
	if err != nil {
		return Outcome{Err: err}
	}
	defer restore()
	if j.SessionDir != "" {
		defer os.RemoveAll(j.SessionDir)
	}
	return runProcess(ctx, j, cursorBinary(), cursorArgs(j), nil, &cursorStream{dir: j.Dir})
}

const cursorSessionPrefix = "cursor:"

// cursorArgs builds the command line. The prompt is the last argument, with the instructions first.
func cursorArgs(j Job) []string {
	args := []string{"-p", "--output-format", "stream-json", "--trust", "--approve-mcps", "--workspace", j.Dir}
	if j.Resume && strings.HasPrefix(j.SessionID, cursorSessionPrefix) {
		args = append(args, "--resume", strings.TrimPrefix(j.SessionID, cursorSessionPrefix))
	}
	// Nobody is there to approve a command: run them, as the other agents do. A board that bypasses
	// permissions also turns Cursor's sandbox off.
	args = append(args, "--force")
	if j.Access.Mode == "bypassPermissions" {
		args = append(args, "--sandbox", "disabled")
	}
	if model := j.Model; model != "" {
		if j.Effort != "" && !strings.Contains(model, "[") {
			model += "[effort=" + codexEffort(j.Effort) + "]"
		}
		args = append(args, "--model", model)
	}
	for _, d := range j.AddDirs {
		args = append(args, "--add-dir", d)
	}
	prompt := j.Prompt
	if j.Instructions != "" {
		prompt = j.Instructions + "\n\n---\n\n" + j.Prompt
	}
	return append(args, prompt)
}

// cursorServerSkipped says why a server cannot be given to a Cursor session, or "".
func cursorServerSkipped(s MCPServer) string {
	if s.URL != "" && len(s.Secrets) > 0 {
		return "Cursor can only take a URL server's secret as a header written into the worktree"
	}
	return ""
}

// writeCursorMCP puts the session's MCP servers in the worktree's .cursor/mcp.json and answers how to
// put things back. A config the repository already has keeps its own servers, with the session's
// added; git is told to look away from the file for the session, so the work can still be integrated.
func writeCursorMCP(ctx context.Context, j Job) (func(), error) {
	noop := func() {}
	if len(j.MCPServers) == 0 {
		return noop, nil
	}
	if j.SessionDir == "" {
		return noop, fmt.Errorf("a Cursor session with MCP servers needs a SessionDir for their secrets")
	}
	if err := os.MkdirAll(j.SessionDir, 0o700); err != nil {
		return noop, err
	}
	path := filepath.Join(j.Dir, ".cursor", "mcp.json")
	original, readErr := os.ReadFile(path)
	existed := readErr == nil

	config := map[string]any{}
	if existed {
		_ = json.Unmarshal(original, &config)
	}
	servers, _ := config["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	for _, s := range j.MCPServers {
		if cursorServerSkipped(s) != "" {
			continue
		}
		entry := map[string]any{}
		if s.URL != "" {
			entry["url"] = s.URL
		} else {
			entry["command"] = s.Command
			entry["args"] = append([]string{}, s.Args...)
			if len(s.Env) > 0 {
				entry["env"] = s.Env
			}
			if len(s.Secrets) > 0 {
				file := filepath.Join(j.SessionDir, "mcp-"+s.Name+".env")
				var b strings.Builder
				for _, k := range sortedKeys(s.Secrets) {
					fmt.Fprintf(&b, "%s=%s\n", k, strings.ReplaceAll(s.Secrets[k], "\n", ""))
				}
				if err := os.WriteFile(file, []byte(b.String()), 0o600); err != nil {
					return noop, err
				}
				entry["envFile"] = file
			}
		}
		if len(s.Tools) > 0 {
			entry["enabledTools"] = s.Tools
		}
		servers[s.Name] = entry
	}
	config["mcpServers"] = servers
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return noop, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return noop, err
	}

	tracked := exec.CommandContext(ctx, "git", "-C", j.Dir, "ls-files", "--error-unmatch", ".cursor/mcp.json").Run() == nil
	if tracked {
		_ = exec.CommandContext(ctx, "git", "-C", j.Dir, "update-index", "--skip-worktree", ".cursor/mcp.json").Run()
	} else {
		excludeFromGit(ctx, j.Dir, "/.cursor/mcp.json")
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return noop, err
	}
	return func() {
		if existed {
			_ = os.WriteFile(path, original, 0o644)
		} else {
			_ = os.Remove(path)
			_ = os.Remove(filepath.Dir(path)) // only if the session left it empty
		}
		if tracked {
			_ = exec.Command("git", "-C", j.Dir, "update-index", "--no-skip-worktree", ".cursor/mcp.json").Run()
		}
	}, nil
}

// excludeFromGit adds a pattern to the repository's info/exclude, which every worktree shares, once.
func excludeFromGit(ctx context.Context, dir, pattern string) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--git-common-dir").Output()
	if err != nil {
		return
	}
	common := strings.TrimSpace(string(out))
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	file := filepath.Join(common, "info", "exclude")
	have, _ := os.ReadFile(file)
	for _, line := range strings.Split(string(have), "\n") {
		if strings.TrimSpace(line) == pattern {
			return
		}
	}
	_ = os.MkdirAll(filepath.Dir(file), 0o755)
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(have) > 0 && !bytes.HasSuffix(have, []byte("\n")) {
		fmt.Fprintln(f)
	}
	fmt.Fprintf(f, "# written by dutyboard for Cursor sessions\n%s\n", pattern)
}

// cursorLimit is how a plan limit reads in Cursor's errors.
var cursorLimit = regexp.MustCompile(`(?i)usage limit|rate limit|out of (fast )?requests|quota`)

type cursorStream struct {
	dir string
}

// Read handles Cursor's stream-json: system/init (the session id), tool_call started (what it is
// doing), and result. Tool calls are an object with one key naming the tool — `shellToolCall`,
// `readToolCall` — read leniently, so an unknown one costs an activity line and nothing else.
func (s *cursorStream) Read(line []byte, out *Outcome) string {
	var ev struct {
		Type      string                     `json:"type"`
		Subtype   string                     `json:"subtype"`
		SessionID string                     `json:"session_id"`
		IsError   bool                       `json:"is_error"`
		Result    string                     `json:"result"`
		ToolCall  map[string]json.RawMessage `json:"tool_call"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return ""
	}
	if ev.SessionID != "" {
		out.Session = cursorSessionPrefix + ev.SessionID
	}
	switch ev.Type {
	case "result":
		out.Result, out.IsError = ev.Result, ev.IsError
		if ev.IsError && cursorLimit.MatchString(ev.Result) {
			out.Limited = true
		}
	case "tool_call":
		if ev.Subtype == "started" {
			return describeCursorTool(ev.ToolCall, s.dir)
		}
	}
	return ""
}

func describeCursorTool(call map[string]json.RawMessage, dir string) string {
	keys := make([]string, 0, len(call))
	for k := range call {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		var body struct {
			Args map[string]any `json:"args"`
		}
		_ = json.Unmarshal(call[key], &body)
		str := func(names ...string) string {
			for _, n := range names {
				if v, ok := body.Args[n].(string); ok && strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
			return ""
		}
		rel := func(p string) string {
			if r, err := filepath.Rel(dir, p); err == nil && !strings.HasPrefix(r, "..") {
				return filepath.ToSlash(r)
			}
			return p
		}
		switch strings.TrimSuffix(key, "ToolCall") {
		case "shell":
			return "Running `" + oneLine(str("command"), 90) + "`"
		case "read":
			return "Reading " + rel(str("path", "filePath"))
		case "edit", "write", "delete":
			return "Editing " + rel(str("path", "filePath"))
		case "grep", "glob", "semSearch", "codebaseSearch":
			return "Searching for " + oneLine(str("pattern", "globPattern", "query"), 80)
		case "ls":
			return "Looking in " + rel(str("path"))
		case "webSearch":
			return "Searching the web for " + oneLine(str("query", "searchTerm"), 80)
		case "fetch":
			return "Reading " + oneLine(str("url"), 90)
		case "updateTodos", "todos", "createPlan":
			return "Planning"
		case "mcp":
			server := str("providerIdentifier", "serverName", "server")
			tool := str("toolName", "name", "tool")
			return DescribeMCPTool(server, strings.TrimPrefix(tool, server+"-"))
		}
		if key != "" {
			return "Using " + strings.TrimSuffix(key, "ToolCall")
		}
	}
	return ""
}
