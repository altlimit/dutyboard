package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/tools"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// session is who an MCP message came from.
type session struct {
	board string
	agent string
	run   *Run // nil for an interactive session in a linked folder
}

// Tools that change a duty. A headless session may only change its own.
var dutyScoped = map[string]bool{
	"duty_checkpoint": true, "duty_complete": true, "duty_fail": true, "duty_attach": true,
	"board_profile_propose": true, "board_rules_submit": true,
}

// Tools that take an agent id, which the bridge fills in so a session cannot sign as anyone else.
var takesAgent = map[string]bool{
	"duty_poll": true, "duty_claim": true, "duty_enqueue": true, "duty_checkpoint": true, "duty_complete": true,
	"duty_fail": true, "duty_attach": true, "board_profile_propose": true, "board_rules_submit": true,
}

var localTools = []map[string]any{
	{
		"name":  "duty_integrate",
		"title": "Land this duty's commits",
		"description": "Integrate the work committed on this duty's branch: rebase it onto the main branch, run the project's tests, and push — or open a pull request, if the board works that way. " +
			"Commit first; uncommitted changes are refused. If it reports conflicts, resolve them, `git add` them, `git rebase --continue`, and call it again. " +
			"If it reports failing tests, fix them, commit, and call it again. duty_complete is refused until this succeeds; a duty with no commits integrates as a no-op.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
	},
	{
		"name":        "tools_list",
		"title":       "Tools installed on this machine",
		"description": "The tools this machine has registered for its projects — name, version, folder, and how to check it works. Use these rather than installing another copy.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
	},
	{
		"name":  "tools_register",
		"title": "Remember an installed tool",
		"description": "Record a tool you installed (or found already installed) so every later session on this machine gets it on PATH and uses it. " +
			"Install new tools under $DUTYBOARD_TOOLS/<name>/<version>/. The verify command is run now, with the tool's folder on PATH, and the tool is only registered if it succeeds.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":    map[string]any{"type": "string", "description": "Lowercase name, e.g. 'godot'."},
				"version": map[string]any{"type": "string", "description": "Exact version, e.g. '4.7.1'."},
				"path":    map[string]any{"type": "string", "description": "Absolute folder holding the executables."},
				"env":     map[string]any{"type": "object", "description": "Variables sessions need, e.g. {\"GODOT_BIN\": \"/…/godot\"}.", "additionalProperties": map[string]any{"type": "string"}},
				"source":  map[string]any{"type": "string", "description": "Where it was downloaded from."},
				"sha256":  map[string]any{"type": "string", "description": "Checksum of what was downloaded, if published."},
				"verify":  map[string]any{"type": "string", "description": "A command that succeeds only if the tool works, e.g. 'godot --version'."},
			},
			"required": []string{"name", "version", "path", "verify"},
		},
	},
}

type rpc struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func rpcResult(id json.RawMessage, result any) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	return b
}

func toolText(id json.RawMessage, text string, isError bool) json.RawMessage {
	return rpcResult(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": isError})
}

func toolJSON(id json.RawMessage, v any, isError bool) json.RawMessage {
	b, _ := json.Marshal(v)
	return rpcResult(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": string(b)}}, "structuredContent": v, "isError": isError})
}

// sessionFor works out who is asking: a session this daemon started, by its token, or an interactive
// session in a linked folder (or one of its worktrees), by where it runs.
func (d *Daemon) sessionFor(runToken, cwd string) (*session, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if runToken != "" {
		run := d.tokens[runToken]
		if run == nil {
			return nil, errors.New("this session is not one the daemon is running — it may have been stopped")
		}
		return &session{board: run.Board, agent: run.Agent, run: run}, nil
	}
	if d.me == nil {
		return nil, errors.New("the daemon is still starting")
	}
	clean := filepath.Clean(cwd)
	for b, folder := range d.workspaces {
		if within(clean, filepath.Clean(folder)) || within(clean, state.Path("worktrees", b)) {
			return &session{board: b, agent: d.me.Machine.AgentPrefix + "/i"}, nil
		}
	}
	return nil, fmt.Errorf("%s is not a folder linked to a DutyBoard on this machine — run `dutyboard` in the repository to link it", cwd)
}

func within(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// MCP answers one message from `dutyboard mcp`.
func (d *Daemon) MCP(ctx context.Context, runToken, cwd string, raw json.RawMessage) (json.RawMessage, error) {
	var msg rpc
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, errors.New("not a JSON-RPC message")
	}
	s, err := d.sessionFor(runToken, cwd)
	if err != nil {
		return nil, err
	}

	switch msg.Method {
	case "tools/list":
		reply, err := d.api.RawMCP(ctx, s.board, raw)
		if err != nil || reply == nil {
			return reply, err
		}
		return d.filterTools(reply, s)
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			return nil, err
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		if reply, handled := d.localTool(ctx, s, msg.ID, p.Name, p.Arguments); handled {
			return reply, nil
		}
		if refusal := guard(s, p.Name, p.Arguments); refusal != "" {
			return toolText(msg.ID, refusal, true), nil
		}
		if takesAgent[p.Name] {
			p.Arguments["agent_id"] = s.agent
		}
		if s.run != nil {
			if p.Name == "duty_enqueue" && p.Arguments["spawned_by"] == nil {
				p.Arguments["spawned_by"] = s.run.DutyID
			}
			// A session parking its duty keeps it for this machine, where its worktree is.
			if p.Name == "duty_checkpoint" {
				if st, _ := p.Arguments["set_status"].(string); st == "needs_decision" || st == "blocked" {
					p.Arguments["affinity"] = true
				}
			}
		}
		params, _ := json.Marshal(p)
		msg.Params = params
		forwarded, _ := json.Marshal(msg)
		return d.api.RawMCP(ctx, s.board, forwarded)
	default:
		return d.api.RawMCP(ctx, s.board, raw)
	}
}

// guard refuses what a headless session may not do. It answers the refusal as the agent will read it.
func guard(s *session, name string, args map[string]any) string {
	if s.run == nil {
		return ""
	}
	if name == "duty_claim" {
		return "claiming is the daemon's job: this session holds exactly one duty, " + s.run.DutyID + ". Finish, park or fail it."
	}
	if dutyScoped[name] {
		if id, _ := args["duty_id"].(string); id != s.run.DutyID {
			return fmt.Sprintf("this session may only change its own duty, %s — not %q", s.run.DutyID, id)
		}
	}
	if name == "duty_complete" && s.run.integration() == nil {
		return "call duty_integrate first: a duty is complete only once its work has landed, and the outcome should name the commit or pull request it gives you"
	}
	return ""
}

func (d *Daemon) filterTools(reply json.RawMessage, s *session) (json.RawMessage, error) {
	var env struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  struct {
			Tools []map[string]any `json:"tools"`
		} `json:"result"`
		Error json.RawMessage `json:"error,omitempty"`
	}
	if err := json.Unmarshal(reply, &env); err != nil || len(env.Error) > 0 {
		return reply, nil
	}
	var out []map[string]any
	for _, t := range env.Result.Tools {
		name, _ := t["name"].(string)
		if s.run != nil && name == "duty_claim" {
			continue
		}
		out = append(out, t)
	}
	for _, t := range localTools {
		if s.run == nil && t["name"] == "duty_integrate" {
			continue
		}
		out = append(out, t)
	}
	if s.run != nil && deploysToAltengine(d.view(s.board)) {
		out = append(out, altengineTools...)
	}
	return rpcResult(env.ID, map[string]any{"tools": out}), nil
}

func (d *Daemon) localTool(ctx context.Context, s *session, id json.RawMessage, name string, args map[string]any) (json.RawMessage, bool) {
	switch name {
	case "duty_integrate":
		if s.run == nil {
			return toolText(id, "duty_integrate is for sessions the daemon started", true), true
		}
		run := s.run
		v := d.view(run.Board)
		opts := worktree.IntegrateOptions{Mode: modeFor(ctx, v, run.Spec), Title: run.Title, Body: "DutyBoard duty " + run.DutyID}
		if v.Profile != nil {
			opts.TestCommand = v.Profile.TestCommand
		}
		run.set("integrating", "")
		d.report(ctx, run.Board)
		res, err := d.wt.Integrate(ctx, run.Spec, d.lock(run.Board), opts)
		run.set("working", "")
		if err != nil {
			return toolText(id, "integration failed: "+err.Error(), true), true
		}
		if res.OK {
			run.setIntegrated(res)
		}
		return toolJSON(id, res, !res.OK), true
	case "altengine_deploy_static", "altengine_deploy_function":
		if s.run == nil {
			return toolText(id, name+" is for sessions the daemon started", true), true
		}
		res, err := d.altengineDeploy(ctx, s, name, args)
		if err != nil {
			return toolText(id, err.Error(), true), true
		}
		return toolJSON(id, res, false), true
	case "tools_list":
		return toolJSON(id, map[string]any{"tools_folder": tools.Dir(), "tools": d.tools.List()}, false), true
	case "tools_register":
		b, _ := json.Marshal(args)
		var t tools.Tool
		if err := json.Unmarshal(b, &t); err != nil {
			return toolText(id, "bad arguments: "+err.Error(), true), true
		}
		out, err := d.tools.Register(ctx, t)
		if err != nil {
			return toolText(id, err.Error()+"\n"+out, true), true
		}
		return toolJSON(id, map[string]any{"registered": t.Name + " " + t.Version, "verify_output": out}, false), true
	}
	return nil, false
}
