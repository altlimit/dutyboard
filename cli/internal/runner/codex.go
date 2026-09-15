package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Codex is OpenAI's Codex CLI, run headless: `codex exec --json`.
//
// Three things about it shape this file. It picks its own session id, announced in its first event,
// so a session id Codex did not give is never resumed — the ids it gives are kept with a "codex:"
// prefix to tell them apart. It sandboxes what its shell commands may write, so the folders outside
// the worktree a duty needs are named writable. And it has no flag for extra instructions, so they
// go in as config (`developer_instructions`), as do the MCP servers.
type Codex struct{}

func (Codex) Name() string { return "codex" }

// codexBinary is the Codex executable: $DUTYBOARD_CODEX, or `codex` on PATH.
//
// On Windows, npm installs Codex behind a `codex.cmd` script, and a batch file cannot carry an
// argument with a line break in it — which a prompt always has. So the native codex.exe that npm
// unpacked next to the script is used when it can be found.
func codexBinary() string {
	if b := os.Getenv("DUTYBOARD_CODEX"); b != "" {
		return b
	}
	p, err := exec.LookPath("codex")
	if err != nil || !isScript(p) {
		return "codex"
	}
	dir := filepath.Dir(p)
	for _, pattern := range []string{
		filepath.Join(dir, "node_modules", "@openai", "codex-win32-*", "vendor", "*", "bin", "codex.exe"),
		filepath.Join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-*", "vendor", "*", "bin", "codex.exe"),
		filepath.Join(dir, "node_modules", "@openai", "codex", "vendor", "*", "codex", "codex.exe"),
	} {
		if found, _ := filepath.Glob(pattern); len(found) > 0 {
			return found[0]
		}
	}
	return p
}

func isScript(p string) bool {
	ext := strings.ToLower(filepath.Ext(p))
	return ext == ".cmd" || ext == ".bat"
}

var codexLogin struct {
	sync.Mutex
	at  time.Time
	err error
}

// ForgetChecks drops remembered answers about the agents on this machine, so the next check asks again.
func ForgetChecks() {
	codexLogin.Lock()
	codexLogin.at = time.Time{}
	codexLogin.Unlock()
}

// Check finds Codex and asks it whether it is signed in, remembering the answer for a few minutes: a
// daemon checks every board on every tick.
func (Codex) Check(ctx context.Context) error {
	bin := codexBinary()
	if _, err := exec.LookPath(bin); err != nil {
		return fmt.Errorf("Codex is not installed on this machine (%v) — install it (npm i -g @openai/codex) and run `codex login`, or set DUTYBOARD_CODEX", err)
	}
	codexLogin.Lock()
	defer codexLogin.Unlock()
	if time.Since(codexLogin.at) < 5*time.Minute {
		return codexLogin.err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, bin, "login", "status").CombinedOutput()
	codexLogin.at, codexLogin.err = time.Now(), nil
	if err != nil {
		codexLogin.err = fmt.Errorf("Codex is not signed in on this machine — run `codex login` (%s)", strings.TrimSpace(lastLine(string(out))))
	}
	return codexLogin.err
}

func (c Codex) Run(ctx context.Context, j Job) Outcome {
	if err := c.Check(ctx); err != nil {
		return Outcome{Err: err}
	}
	bin := codexBinary()
	var stdin io.Reader
	if isScript(bin) {
		// Only a script shim was found: the prompt goes on stdin ("-"), and the instructions with it,
		// since neither survives a batch file's arguments.
		prompt := j.Prompt
		if j.Instructions != "" {
			prompt = j.Instructions + "\n\n---\n\n" + j.Prompt
		}
		j.Prompt, j.Instructions, stdin = "-", "", strings.NewReader(prompt)
	}
	args, env := codexArgs(j)
	j.Env = append(append([]string{}, j.Env...), env...)
	return runProcess(ctx, j, bin, args, stdin, &codexStream{dir: j.Dir})
}

const codexSessionPrefix = "codex:"

// codexArgs builds the command line for a job, and the environment the MCP servers' secrets travel
// in — never the command line, which anyone on the machine can list.
func codexArgs(j Job) (args, env []string) {
	resume := ""
	if j.Resume && strings.HasPrefix(j.SessionID, codexSessionPrefix) {
		resume = strings.TrimPrefix(j.SessionID, codexSessionPrefix)
	}
	args = []string{"exec"}
	if resume != "" {
		args = append(args, "resume")
	}
	args = append(args, "--json", "--skip-git-repo-check")
	config := func(key string, value any) { args = append(args, "-c", key+"="+tomlValue(value)) }

	if j.Access.Mode == "bypassPermissions" {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	} else {
		// Nobody is there to approve anything, so nothing asks; what commands may write is kept to
		// the worktree and the folders a duty needs, and they may reach the network (installs, docs).
		config("approval_policy", "never")
		config("sandbox_mode", "workspace-write")
		config("sandbox_workspace_write.network_access", true)
		if len(j.Writable) > 0 {
			config("sandbox_workspace_write.writable_roots", j.Writable)
		}
	}
	if j.Model != "" {
		args = append(args, "-m", j.Model)
	}
	if effort := codexEffort(j.Effort); effort != "" {
		config("model_reasoning_effort", effort)
	}
	if j.Instructions != "" {
		config("developer_instructions", j.Instructions)
	}
	for _, s := range j.MCPServers {
		key := "mcp_servers." + tomlKey(s.Name)
		if s.URL != "" {
			config(key+".url", s.URL)
			if len(s.Secrets) > 0 {
				headers := map[string]string{}
				for _, h := range sortedKeys(s.Secrets) {
					name := secretEnvName(s.Name, h)
					headers[h] = name
					env = append(env, name+"="+s.Secrets[h])
				}
				config(key+".env_http_headers", headers)
			}
		} else {
			config(key+".command", s.Command)
			config(key+".args", append([]string{}, s.Args...))
			if len(s.Env) > 0 {
				config(key+".env", s.Env)
			}
			if len(s.Secrets) > 0 {
				names := sortedKeys(s.Secrets)
				for _, k := range names {
					env = append(env, k+"="+s.Secrets[k])
				}
				config(key+".env_vars", names)
			}
		}
		if len(s.Tools) > 0 {
			config(key+".enabled_tools", s.Tools)
		}
	}
	if resume != "" {
		args = append(args, resume)
	}
	return append(args, j.Prompt), env
}

// codexEffort maps a board's effort onto Codex's scale, which has no "max".
func codexEffort(e string) string {
	switch e {
	case "low", "medium", "high", "xhigh":
		return e
	case "max":
		return "xhigh"
	}
	return ""
}

var envUnsafe = regexp.MustCompile(`[^A-Z0-9]+`)

// secretEnvName is the environment variable a URL server's header secret travels in.
func secretEnvName(server, header string) string {
	return "DUTYBOARD_MCP_" + envUnsafe.ReplaceAllString(strings.ToUpper(server+"_"+header), "_")
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// tomlValue writes a value as TOML for `-c key=value`. Strings are always quoted: Codex reads an
// unparseable value as a literal string, but a markdown brief that happens to parse as TOML would
// not come through as the text it is.
func tomlValue(v any) string {
	switch x := v.(type) {
	case string:
		return tomlString(x)
	case bool:
		return fmt.Sprint(x)
	case []string:
		parts := make([]string, len(x))
		for i, s := range x {
			parts[i] = tomlString(s)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]string:
		parts := []string{}
		for _, k := range sortedKeys(x) {
			parts = append(parts, tomlString(k)+" = "+tomlString(x[k]))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return tomlString(fmt.Sprint(v))
}

// tomlString is a TOML basic string. JSON's escapes are all valid TOML ones.
func tomlString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// tomlKey quotes a key segment unless it is already a bare key.
func tomlKey(k string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(k) {
		return k
	}
	return tomlString(k)
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

// codexLimit is how a plan limit reads in Codex's errors.
var codexLimit = regexp.MustCompile(`(?i)usage limit|rate limit reached`)

type codexStream struct {
	dir string
}

// Read handles `codex exec --json` events: thread.started (the session id), item.started and
// item.completed (what it is doing), turn.completed, turn.failed and error. Items are read leniently,
// by what they carry, so a renamed type costs an activity line rather than a session.
func (s *codexStream) Read(line []byte, out *Outcome) string {
	var ev struct {
		Type     string `json:"type"`
		ThreadID string `json:"thread_id"`
		Message  string `json:"message"`
		Error    *struct {
			Message string `json:"message"`
		} `json:"error"`
		Item map[string]any `json:"item"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return ""
	}
	switch ev.Type {
	case "thread.started":
		if ev.ThreadID != "" {
			out.Session = codexSessionPrefix + ev.ThreadID
		}
	case "turn.completed":
		out.IsError = false
	case "turn.failed":
		msg := ev.Message
		if ev.Error != nil {
			msg = ev.Error.Message
		}
		out.IsError, out.Result = true, msg
		if codexLimit.MatchString(msg) {
			out.Limited = true
		}
	case "error":
		// Codex reports reconnect attempts as errors too; only a limit matters before the turn ends.
		if codexLimit.MatchString(ev.Message) && !strings.HasPrefix(ev.Message, "Reconnecting") {
			out.Limited = true
		}
	case "item.completed":
		if kind(ev.Item) == "agentmessage" {
			if text, _ := ev.Item["text"].(string); text != "" {
				out.Result = text
			}
		}
	case "item.started":
		return describeCodexItem(ev.Item, s.dir)
	}
	return ""
}

// kind is an item's type with case and underscores taken out: Codex spells them both ways.
func kind(item map[string]any) string {
	t, _ := item["type"].(string)
	return strings.ToLower(strings.ReplaceAll(t, "_", ""))
}

func describeCodexItem(item map[string]any, dir string) string {
	str := func(k string) string { s, _ := item[k].(string); return strings.TrimSpace(s) }
	switch kind(item) {
	case "commandexecution":
		cmd := str("command")
		// Codex runs commands through a shell: show what was asked, not the wrapper.
		for _, wrapper := range []string{"bash -lc ", "/bin/bash -lc ", "sh -c ", "powershell.exe -Command ", "pwsh -Command "} {
			if rest, ok := strings.CutPrefix(cmd, wrapper); ok {
				cmd = strings.Trim(rest, `'"`)
			}
		}
		return "Running `" + oneLine(cmd, 90) + "`"
	case "filechange":
		changes, _ := item["changes"].([]any)
		for _, c := range changes {
			if m, ok := c.(map[string]any); ok {
				if p, _ := m["path"].(string); p != "" {
					if r, err := filepath.Rel(dir, p); err == nil && !strings.HasPrefix(r, "..") {
						p = filepath.ToSlash(r)
					}
					return "Editing " + p
				}
			}
		}
		return "Editing files"
	case "mcptoolcall":
		return DescribeMCPTool(str("server"), str("tool"))
	case "websearch":
		if q := str("query"); q != "" {
			return "Searching the web for " + oneLine(q, 80)
		}
		return "Searching the web"
	case "todolist":
		return "Planning"
	}
	return ""
}
