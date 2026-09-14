// Package board is DutyBoard's API as a machine sees it: pairing, its links, the batched poll, and
// the duty calls it makes on a board it is linked to.
package board

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client is one DutyBoard function, reached with this machine's key.
type Client struct {
	Server string // e.g. https://k3x9-fn.altengine.app/board
	Key    string // dbm_…
	HTTP   *http.Client
	// Origin is sent as x-dutyboard-origin, so the daemon can tell its own writes' echoes apart from
	// everyone else's on a board channel.
	Origin string
}

// New is a client for server with key.
func New(server, key string) *Client {
	return &Client{Server: strings.TrimRight(server, "/"), Key: key, HTTP: &http.Client{Timeout: time.Minute}}
}

// Error is DutyBoard's error envelope.
type Error struct {
	Status  int
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details"`
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

// IsStatus reports whether err is a DutyBoard error with this status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// Call POSTs body to path, naming board when it is not empty, and decodes the answer into out.
func (c *Client) Call(ctx context.Context, path, board string, body, out any) error {
	if body == nil {
		body = map[string]any{}
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Server+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if c.Key != "" {
		req.Header.Set("authorization", "Bearer "+c.Key)
	}
	if board != "" {
		req.Header.Set("x-dutyboard-board", board)
	}
	if c.Origin != "" {
		req.Header.Set("x-dutyboard-origin", c.Origin)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var env struct {
			Error Error `json:"error"`
		}
		_ = json.Unmarshal(raw, &env)
		env.Error.Status = res.StatusCode
		if env.Error.Message == "" {
			env.Error.Message = strings.TrimSpace(string(raw))
		}
		return &env.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// RawMCP forwards one JSON-RPC message to the hosted MCP endpoint for board and returns the raw
// answer (nil for a notification, which the server answers 202 with no body).
func (c *Client) RawMCP(ctx context.Context, board string, msg []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Server+"/mcp", bytes.NewReader(msg))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	req.Header.Set("authorization", "Bearer "+c.Key)
	req.Header.Set("x-dutyboard-board", board)
	if c.Origin != "" {
		req.Header.Set("x-dutyboard-origin", c.Origin)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusAccepted {
		return nil, nil
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("mcp: %s: %s", res.Status, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

// --- pairing ------------------------------------------------------------------------------

// Pairing is a started device flow.
type Pairing struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	ExpiresIn  int    `json:"expires_in"`
	Interval   int    `json:"interval"`
	VerifyPath string `json:"verify_path"`
	ConsoleURL string `json:"console_url"`
}

// Paired is what the poll that finds a pairing approved hands over, once.
type Paired struct {
	Status      string `json:"status"`
	MachineKey  string `json:"machine_key"`
	MachineID   string `json:"machine_id"`
	Name        string `json:"name"`
	AgentPrefix string `json:"agent_prefix"`
	OwnerName   string `json:"owner_name"`
}

// StartPairing begins a device flow for a machine called name.
func (c *Client) StartPairing(ctx context.Context, name, os, arch, version string) (*Pairing, error) {
	var p Pairing
	return &p, c.Call(ctx, "/connect/start", "", map[string]any{"name": name, "os": os, "arch": arch, "cli_version": version}, &p)
}

// WaitForApproval polls until the pairing is approved, denied or expires.
func (c *Client) WaitForApproval(ctx context.Context, p *Pairing) (*Paired, error) {
	interval := time.Duration(p.Interval) * time.Second
	if interval <= 0 {
		interval = 3 * time.Second
	}
	for {
		var out Paired
		err := c.Call(ctx, "/connect/poll", "", map[string]any{"device_code": p.DeviceCode}, &out)
		if IsStatus(err, 404) {
			return nil, errors.New("the pairing code expired before anyone approved it — run again for a new one")
		}
		if err != nil {
			return nil, err
		}
		switch out.Status {
		case "approved":
			return &out, nil
		case "denied":
			return nil, errors.New("the pairing was denied in the console")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(interval):
		}
	}
}

// --- the machine's own view ---------------------------------------------------------------

// Profile is a board's profile, as the daemon uses it. Unknown fields are ignored.
type Profile struct {
	Type          string `json:"type"`
	Description   string `json:"description"`
	RepoURL       string `json:"repo_url"`
	DefaultBranch string `json:"default_branch"`
	TestCommand   string `json:"test_command"`
	Stack         []string `json:"stack"`
	Toolchain     []struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Why     string `json:"why"`
	} `json:"toolchain"`
	Deploy struct {
		Method              string   `json:"method"`
		Workflow            string   `json:"workflow"`
		Branch              string   `json:"branch"`
		Command             string   `json:"command"`
		AltengineInstances []string `json:"altengine_instances"`
	} `json:"deploy"`
	Git struct {
		Mode string `json:"mode"`
	} `json:"git"`
	Worktree struct {
		Prep       string   `json:"prep"`
		PrepInputs []string `json:"prep_inputs"`
		Cache      []string `json:"cache"`
		Copy       []string `json:"copy"`
	} `json:"worktree"`
}

// Runner is a board's runner settings.
type Runner struct {
	Agent          string   `json:"agent"`
	Model          string   `json:"model"`
	Effort         string   `json:"effort"`
	Instructions   string   `json:"instructions"`
	PermissionMode string   `json:"permission_mode"`
	AllowedTools   []string `json:"allowed_tools"`
	SessionMinutes int      `json:"session_minutes"`
	Parallel       int      `json:"parallel"`
}

// BoardView is a board with its profile.
type BoardView struct {
	ProjectID    string   `json:"project_id"`
	Name         string   `json:"name"`
	Role         string   `json:"role"`
	Linked       bool     `json:"linked"`
	Profile      *Profile `json:"profile"`
	Runner       *Runner  `json:"runner"`
	RulesVersion int      `json:"rules_version"`
}

// Request is a setup a person asked this machine for.
type Request struct {
	RequestID string `json:"request_id"`
	ProjectID string `json:"project_id"`
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	RepoURL   string `json:"repo_url"`
	Status    string `json:"status"`
}

// Machine is this machine's settings.
type Machine struct {
	MachineID     string `json:"machine_id"`
	Name          string `json:"name"`
	AgentPrefix   string `json:"agent_prefix"`
	Paused        bool   `json:"paused"`
	MaxSessions   int    `json:"max_sessions"`
	RemoteSetup   string `json:"remote_setup"`
	WorkspaceRoot string `json:"workspace_root"`
}

// Me is /machine/me.
type Me struct {
	Machine  Machine     `json:"machine"`
	Links    []BoardView `json:"links"`
	Requests []Request   `json:"requests"`
	Live     bool        `json:"live"`
}

// Me reads this machine's settings and links.
func (c *Client) Me(ctx context.Context) (*Me, error) {
	var m Me
	return &m, c.Call(ctx, "/machine/me", "", nil, &m)
}

// Boards lists the boards this machine may link.
func (c *Client) Boards(ctx context.Context) ([]BoardView, error) {
	var out struct {
		Boards []BoardView `json:"boards"`
	}
	return out.Boards, c.Call(ctx, "/machine/boards", "", nil, &out)
}

// CreateBoard makes a board for this machine's owner.
func (c *Client) CreateBoard(ctx context.Context, body map[string]any) (string, error) {
	var out struct {
		ProjectID string `json:"project_id"`
	}
	return out.ProjectID, c.Call(ctx, "/machine/boards/create", "", body, &out)
}

// Linked is /machine/link's answer.
type Linked struct {
	Created     bool   `json:"created"`
	SetupDutyID string `json:"setup_duty_id"`
	RulesDutyID string `json:"rules_duty_id"`
}

// Link links a board; idempotent.
func (c *Client) Link(ctx context.Context, projectID, pathHint string) (*Linked, error) {
	var l Linked
	return &l, c.Call(ctx, "/machine/link", "", map[string]any{"project_id": projectID, "path_hint": pathHint}, &l)
}

// Unlink takes this machine off a board.
func (c *Client) Unlink(ctx context.Context, projectID string) error {
	return c.Call(ctx, "/machine/unlink", "", map[string]any{"project_id": projectID}, nil)
}

// PollBoard is one board in /machine/poll.
type PollBoard struct {
	ProjectID    string `json:"project_id"`
	Name         string `json:"name"`
	Parallel     int    `json:"parallel"`
	Machines     int    `json:"machines"`
	RulesVersion int    `json:"rules_version"`
	Active       []struct {
		DutyID  string `json:"duty_id"`
		AgentID string `json:"agent_id"`
		Kind    string `json:"kind"`
		Mine    bool   `json:"mine"`
	} `json:"active"`
	Runnable []struct {
		DutyID   string `json:"duty_id"`
		Title    string `json:"title"`
		Priority string `json:"priority"`
		Kind     string `json:"kind"`
		Reserved bool   `json:"reserved"`
		Resumes  bool   `json:"resumes"`
	} `json:"runnable"`
}

// Poll is /machine/poll.
type Poll struct {
	Paused   bool        `json:"paused"`
	Boards   []PollBoard `json:"boards"`
	Requests []Request   `json:"requests"`
}

// Poll reads every linked board at once.
func (c *Client) Poll(ctx context.Context) (*Poll, error) {
	var p Poll
	return &p, c.Call(ctx, "/machine/poll", "", map[string]any{"limit": 5}, &p)
}

// LiveToken is a channel subscribe token.
type LiveToken struct {
	Token     string   `json:"token"`
	WSURL     string   `json:"ws_url"`
	ExpiresAt int64    `json:"expires_at"`
	Channels  []string `json:"channels"`
}

// Live mints this machine's channel token.
func (c *Client) Live(ctx context.Context) (*LiveToken, error) {
	var t LiveToken
	return &t, c.Call(ctx, "/machine/live", "", nil, &t)
}

// Run is one duty in flight, as /machine/state reports it.
type Run struct {
	DutyID string `json:"duty_id"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

// ReportState replaces what this machine says it is doing on a board.
func (c *Client) ReportState(ctx context.Context, projectID string, runs []Run) error {
	if runs == nil {
		runs = []Run{}
	}
	return c.Call(ctx, "/machine/state", "", map[string]any{"project_id": projectID, "runs": runs}, nil)
}

// ReportRequest reports a setup request's progress.
func (c *Client) ReportRequest(ctx context.Context, requestID, status, result string) error {
	return c.Call(ctx, "/machine/request/report", "", map[string]any{"request_id": requestID, "status": status, "result": result}, nil)
}

// --- duties ------------------------------------------------------------------------------

// Duty is a duty as /duty/get and /duty/claim return it.
type Duty struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	Brief            string `json:"brief"`
	Priority         string `json:"priority"`
	Kind             string `json:"kind"`
	Status           string `json:"status"`
	AssignedAgentID  string `json:"assigned_agent_id"`
	OutcomeSummary   string `json:"outcome_summary"`
	LastQuestion     string `json:"last_question"`
	AttachmentCount  int    `json:"attachment_count"`
	UnblockedContext *struct {
		LastQuestion    string `json:"last_question"`
		HumanResolution string `json:"human_resolution"`
	} `json:"unblocked_context"`
	Reopened *struct {
		Note            string `json:"note"`
		PreviousOutcome string `json:"previous_outcome"`
		Times           int    `json:"times"`
	} `json:"reopened"`
	Affinity *struct {
		MachineID string `json:"machine_id"`
	} `json:"affinity"`
}

// Claimed is /duty/claim's answer.
type Claimed struct {
	Duty         Duty `json:"duty"`
	RulesVersion int  `json:"rules_version"`
}

// Claim claims dutyID on board as agentID.
func (c *Client) Claim(ctx context.Context, board, dutyID, agentID string) (*Claimed, error) {
	var out Claimed
	return &out, c.Call(ctx, "/duty/claim", board, map[string]any{"duty_id": dutyID, "agent_id": agentID}, &out)
}

// Get reads a duty.
func (c *Client) Get(ctx context.Context, board, dutyID string) (*Duty, error) {
	var out struct {
		Duty Duty `json:"duty"`
	}
	return &out.Duty, c.Call(ctx, "/duty/get", board, map[string]any{"duty_id": dutyID}, &out)
}

// Checkpoint posts to a duty's thread; setStatus may be empty. affinity keeps a parked duty for
// this machine.
func (c *Client) Checkpoint(ctx context.Context, board, dutyID, agentID, kind, message, setStatus string, affinity bool) error {
	body := map[string]any{"duty_id": dutyID, "agent_id": agentID, "kind": kind, "message": message}
	if setStatus != "" {
		body["set_status"] = setStatus
	}
	if affinity {
		body["affinity"] = true
	}
	return c.Call(ctx, "/duty/checkpoint", board, body, nil)
}

// Enqueue files a duty on board.
func (c *Client) Enqueue(ctx context.Context, board string, body map[string]any) (string, error) {
	var out struct {
		DutyID string `json:"duty_id"`
	}
	return out.DutyID, c.Call(ctx, "/duty/enqueue", board, body, &out)
}

// Attach stores a small file on a duty, inline.
func (c *Client) Attach(ctx context.Context, board, dutyID, agentID, name, contentType string, data []byte) error {
	return c.Call(ctx, "/duty/attach", board, map[string]any{
		"duty_id": dutyID, "agent_id": agentID, "name": name, "content_type": contentType,
		"content_base64": encodeBase64(data),
	}, nil)
}

// Rules reads a board's rules in force.
func (c *Client) Rules(ctx context.Context, board string) (version int, body string, err error) {
	var out struct {
		Version int    `json:"version"`
		Body    string `json:"body"`
	}
	err = c.Call(ctx, "/board/rules", board, nil, &out)
	return out.Version, out.Body, err
}
