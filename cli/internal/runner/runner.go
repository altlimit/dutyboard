// Package runner starts the agent that does a duty. Claude Code is the only one today; a board's
// `runner.agent` names which, so another is one more implementation of Run, not a rewrite.
package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Job is one session.
type Job struct {
	Dir          string // the duty's worktree
	Prompt       string
	SystemPrompt string // appended to the agent's own
	MCPConfig    string // path to an MCP config naming the local dutyboard server
	SessionID    string // a UUID; with Resume, the conversation to continue
	Resume       bool
	Name         string
	Model        string
	Effort       string
	Permission   string
	AllowedTools []string
	AddDirs      []string
	Env          []string
	Log          io.Writer // the raw event stream
	Timeout      time.Duration
}

// Outcome is how a session ended. Whether the duty was done is not in here: that is asked of the
// board afterwards, because what the agent says about its work is not what the board says.
type Outcome struct {
	Err      error
	TimedOut bool
	Canceled bool
	// Limited is the agent's plan limit, hit; ResetsAt is when it lifts (zero when not said).
	Limited  bool
	ResetsAt time.Time
	Result   string
	IsError  bool
	Cost     float64
	Session  string
}

// Binary is the Claude Code executable: $DUTYBOARD_CLAUDE, or `claude` on PATH.
func Binary() string {
	if b := os.Getenv("DUTYBOARD_CLAUDE"); b != "" {
		return b
	}
	return "claude"
}

// Args builds the command line for a job.
func Args(j Job) []string {
	args := []string{"-p", j.Prompt, "--output-format", "stream-json", "--verbose"}
	if j.Resume && j.SessionID != "" {
		args = append(args, "--resume", j.SessionID)
	} else if j.SessionID != "" {
		args = append(args, "--session-id", j.SessionID)
	}
	if j.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", j.SystemPrompt)
	}
	if j.MCPConfig != "" {
		args = append(args, "--mcp-config", j.MCPConfig)
	}
	if j.Permission != "" {
		args = append(args, "--permission-mode", j.Permission)
	}
	if len(j.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(j.AllowedTools, ","))
	}
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
	return args
}

// limitText is how a plan limit reads when it arrives as the result rather than as an event.
var limitText = regexp.MustCompile(`(?i)usage limit reached(?:\|(\d{9,}))?`)

// Run runs a job to its end.
func Run(ctx context.Context, j Job) Outcome {
	bin := Binary()
	if _, err := exec.LookPath(bin); err != nil && !filepath.IsAbs(bin) {
		return Outcome{Err: fmt.Errorf("claude is not on PATH (%w) — install Claude Code and sign in, or set DUTYBOARD_CLAUDE", err)}
	}
	runCtx := ctx
	var cancel context.CancelFunc
	if j.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, j.Timeout)
		defer cancel()
	}

	cmd := exec.Command(bin, Args(j)...)
	cmd.Dir = j.Dir
	cmd.Env = append(os.Environ(), j.Env...)
	cmd.Stdin = nil
	isolate(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Outcome{Err: err}
	}
	var stderr strings.Builder
	cmd.Stderr = &limited{w: &stderr, n: 8000}
	if err := cmd.Start(); err != nil {
		return Outcome{Err: err}
	}

	// The context is watched here rather than by exec.CommandContext, because the agent starts
	// children of its own — a test run, a dev server, the MCP server — and killing only the parent
	// would leave them running with nobody to stop them.
	stopped := make(chan struct{})
	go func() {
		select {
		case <-runCtx.Done():
			killTree(cmd)
		case <-stopped:
		}
	}()

	out := Outcome{Session: j.SessionID}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if j.Log != nil {
			j.Log.Write(line)
			j.Log.Write([]byte("\n"))
		}
		readEvent(line, &out)
	}
	err = cmd.Wait()
	close(stopped)

	switch {
	case errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil:
		out.TimedOut = true
	case ctx.Err() != nil:
		out.Canceled = true
	case err != nil && !out.Limited:
		out.Err = fmt.Errorf("claude exited: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return out
}

func readEvent(line []byte, out *Outcome) {
	var ev struct {
		Type          string  `json:"type"`
		SessionID     string  `json:"session_id"`
		Result        string  `json:"result"`
		IsError       bool    `json:"is_error"`
		TotalCostUSD  float64 `json:"total_cost_usd"`
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
		if m := limitText.FindStringSubmatch(ev.Result); m != nil && ev.IsError {
			out.Limited = true
			if n, err := strconv.ParseInt(m[1], 10, 64); err == nil {
				out.ResetsAt = time.Unix(n, 0)
			}
		}
	}
}

type limited struct {
	w io.Writer
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	_, _ = l.w.Write(q)
	return len(p), nil
}
