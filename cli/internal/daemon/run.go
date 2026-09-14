package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/deploy"
	"github.com/altlimit/dutyboard/cli/internal/hints"
	"github.com/altlimit/dutyboard/cli/internal/prompt"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// maxAttempts is how many sessions may stop without finishing a duty before it goes to a person.
const maxAttempts = 3

// retryDelay is the wait before the next attempt, times the attempt number. DUTYBOARD_RETRY_SECONDS
// shortens it for tests.
func retryDelay() time.Duration {
	if s, err := strconv.Atoi(os.Getenv("DUTYBOARD_RETRY_SECONDS")); err == nil && s >= 0 {
		return time.Duration(s) * time.Second
	}
	return 30 * time.Second
}

// defaultTools is what a session may use without asking when the board does not say. Headless, a
// tool that needs permission is a tool that is refused, so the list is what real work needs.
var defaultTools = []string{"Read", "Edit", "Write", "Glob", "Grep", "Bash", "Agent", "TodoWrite", "WebFetch", "WebSearch", "mcp__dutyboard"}

// Run is one duty being worked on this machine.
type Run struct {
	Board, DutyID, Agent, Kind, Title string
	Token                             string
	Spec                              worktree.Spec
	Worktree                          string

	mu         sync.Mutex
	st, det    string
	integrated *worktree.Result
	cancel     context.CancelFunc
	byBoard    atomic.Bool
}

func (r *Run) set(s, detail string) {
	r.mu.Lock()
	r.st, r.det = s, detail
	r.mu.Unlock()
}

func (r *Run) state() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.st == "" {
		return "working"
	}
	return r.st
}

func (r *Run) detail() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.det
}

func (r *Run) cancelByBoard() {
	r.byBoard.Store(true)
	r.cancel()
}

func (r *Run) setIntegrated(res *worktree.Result) {
	r.mu.Lock()
	r.integrated = res
	r.mu.Unlock()
}

func (r *Run) integration() *worktree.Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.integrated
}

// launch starts a session for a claimed (or already held) duty.
func (d *Daemon) launch(ctx context.Context, boardID, agent string, duty *board.Duty, resuming bool) {
	rctx, cancel := context.WithCancel(ctx)
	run := &Run{Board: boardID, DutyID: duty.ID, Agent: agent, Kind: duty.Kind, Title: duty.Title, Token: randomHex(24), cancel: cancel}
	d.mu.Lock()
	d.runs[duty.ID] = run
	d.tokens[run.Token] = run
	d.mu.Unlock()
	d.log.Printf("%s: %s %q as %s", boardID, map[bool]string{true: "resuming", false: "starting"}[resuming], duty.Title, agent)
	d.report(ctx, boardID)

	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer cancel()
		d.execute(ctx, rctx, run, duty, resuming)
		d.mu.Lock()
		delete(d.runs, run.DutyID)
		delete(d.tokens, run.Token)
		d.mu.Unlock()
		if ctx.Err() == nil {
			report, cancelReport := context.WithTimeout(context.Background(), 30*time.Second)
			d.report(report, boardID)
			cancelReport()
			d.wake() // finishing a duty emits no event for the next one
		}
	}()
}

func (d *Daemon) view(boardID string) board.BoardView {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.views[boardID]
}

func (d *Daemon) specFor(boardID, duty string, v board.BoardView) worktree.Spec {
	s := worktree.Spec{Repo: d.folder(boardID), Board: boardID, DutyID: duty}
	if p := v.Profile; p != nil {
		s.Base = p.DefaultBranch
		s.Prep, s.PrepInputs, s.Cache, s.Copy = p.Worktree.Prep, p.Worktree.PrepInputs, p.Worktree.Cache, p.Worktree.Copy
	}
	return s
}

func modeFor(ctx context.Context, v board.BoardView, s worktree.Spec) worktree.Mode {
	if worktree.Remote(ctx, s.Repo) == "" {
		return worktree.ModeBranch
	}
	if v.Profile != nil && v.Profile.Git.Mode == "pr" {
		return worktree.ModePR
	}
	return worktree.ModePush
}

func (d *Daemon) rulesFor(ctx context.Context, boardID string) (int, string) {
	d.mu.Lock()
	want := d.polled[boardID].RulesVersion
	have, ok := d.rules[boardID]
	d.mu.Unlock()
	if ok && have.version == want {
		return have.version, have.body
	}
	version, body, err := d.api.Rules(ctx, boardID)
	if err != nil {
		d.log.Printf("reading rules for %s: %v", boardID, err)
		return have.version, have.body
	}
	d.mu.Lock()
	d.rules[boardID] = rulesEntry{version: version, body: body}
	d.mu.Unlock()
	return version, body
}

// execute works one duty until the board says it is no longer this session's to work. dctx is the
// daemon's own context; rctx is the session's, which a person moving the duty cancels.
func (d *Daemon) execute(dctx, rctx context.Context, run *Run, duty *board.Duty, resuming bool) {
	v := d.view(run.Board)
	spec := d.specFor(run.Board, run.DutyID, v)
	run.Spec = spec
	run.set("working", "preparing its worktree")
	d.report(dctx, run.Board)

	path, created, err := d.wt.Ensure(rctx, spec)
	if err != nil {
		d.park(dctx, run, v, fmt.Sprintf("The runner on this machine could not prepare a worktree for this duty, so it has not started:\n\n%v", err))
		return
	}
	run.Worktree = path

	records, _ := state.RunRecords()
	rec := records[run.DutyID]
	rec.Board, rec.Agent = run.Board, run.Agent
	// A conversation can only be resumed where it happened: a new worktree means a new session.
	resume := !created && rec.Session != "" && (resuming || rec.Attempts > 0)
	if rec.Session == "" || created {
		rec.Session, resume = newSessionID(), false
	}
	if created {
		rec.Attempts = 0
	}

	for {
		if rctx.Err() != nil && !run.byBoard.Load() {
			return
		}
		rulesAt, rules := d.rulesFor(dctx, run.Board)
		in := prompt.Input{
			Duty: *duty, Board: v, Rules: rules, RulesAt: rulesAt, Branch: spec.Branch(), Worktree: path,
			Mode: string(modeFor(dctx, v, spec)), Resuming: resume, Attempt: rec.Attempts,
			ProjectRoot: spec.Repo, Tools: d.tools.Describe(),
		}
		if run.Kind == "setup" || run.Kind == "rules" {
			kind := ""
			if v.Profile != nil {
				kind = v.Profile.Type
			}
			in.Hints = hints.For(kind)
		}
		if run.Kind == "setup" {
			base := spec.Base
			if base == "" {
				base = worktree.DefaultBranch(dctx, spec.Repo, worktree.Remote(dctx, spec.Repo))
			}
			in.Detected = deploy.Detect(path, base).Describe()
		}
		system, err := prompt.System(in)
		if err != nil {
			d.log.Printf("prompt: %v", err)
			return
		}
		task, err := prompt.Duty(in)
		if err != nil {
			d.log.Printf("prompt: %v", err)
			return
		}

		job := d.job(run, v, path, system, task, rec, resume)
		logPath := state.Path("logs", run.Board, run.DutyID, time.Now().Format("20060102-150405")+".jsonl")
		_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
		logFile, _ := os.Create(logPath)
		if logFile != nil {
			job.Log = logFile
		}
		_ = state.SaveRunRecord(run.DutyID, &rec)
		run.set("working", "")
		d.report(dctx, run.Board)

		outcome := runner.Run(rctx, job)
		if logFile != nil {
			logFile.Close()
		}
		_ = os.Remove(job.MCPConfig)
		if outcome.Session != "" {
			rec.Session = outcome.Session
		}
		if dctx.Err() != nil {
			// The daemon is stopping. The duty stays held; the next start resumes it.
			_ = state.SaveRunRecord(run.DutyID, &rec)
			return
		}

		if outcome.Limited {
			until := outcome.ResetsAt
			if until.IsZero() || time.Until(until) > 6*time.Hour {
				until = time.Now().Add(30 * time.Minute)
			}
			d.mu.Lock()
			if until.After(d.limitedUntil) {
				d.limitedUntil = until
			}
			d.mu.Unlock()
			d.log.Printf("the agent's plan limit was reached; waiting until %s", until.Format(time.Kitchen))
			run.set("limited", "plan limit; resumes at "+until.Format(time.RFC3339))
			d.report(dctx, run.Board)
			select {
			case <-dctx.Done():
				return
			case <-rctx.Done():
			case <-time.After(time.Until(until)):
			}
			resume = true
			if !run.byBoard.Load() {
				continue
			}
		}

		fresh, err := d.api.Get(dctx, run.Board, run.DutyID)
		if board.IsStatus(err, 404) {
			d.log.Printf("%s was deleted; removing its worktree", run.DutyID)
			_ = d.wt.Remove(dctx, spec, false)
			_ = state.SaveRunRecord(run.DutyID, nil)
			return
		}
		if err != nil {
			d.log.Printf("reading %s after its session: %v", run.DutyID, err)
			_ = state.SaveRunRecord(run.DutyID, &rec)
			return
		}

		switch fresh.Status {
		case "done", "failed":
			res := run.integration()
			keepBranch := res != nil && res.Mode == worktree.ModeBranch && !res.NoOp
			_ = d.wt.Remove(dctx, spec, keepBranch)
			_ = state.SaveRunRecord(run.DutyID, nil)
			d.log.Printf("%s: %s %q", run.Board, fresh.Status, fresh.Title)
			if fresh.Status == "done" && res != nil && res.OK && !res.NoOp && res.Mode == worktree.ModePush {
				d.watchDeploy(dctx, run, v, spec, res.Commit)
			}
			return
		case "active":
			if fresh.AssignedAgentID != run.Agent {
				_ = state.SaveRunRecord(run.DutyID, nil)
				return
			}
			rec.Attempts++
			_ = state.SaveRunRecord(run.DutyID, &rec)
			why := describe(outcome)
			d.log.Printf("%s: the session stopped without finishing %q (%s), attempt %d of %d", run.Board, fresh.Title, why, rec.Attempts, maxAttempts)
			if rec.Attempts >= maxAttempts {
				d.attachLog(dctx, run, logPath)
				d.park(dctx, run, v, fmt.Sprintf(
					"The runner on this machine started %d sessions on this duty and each stopped before finishing it (last: %s). "+
						"The latest session log is attached. What should change before it is tried again?", rec.Attempts, why))
				return
			}
			run.set("waiting", fmt.Sprintf("retrying (%s)", why))
			d.report(dctx, run.Board)
			select {
			case <-dctx.Done():
				return
			case <-time.After(time.Duration(rec.Attempts) * retryDelay()):
			}
			duty, resume = fresh, true
		default: // needs_decision, blocked, queued: the session parked it, or a person moved it
			d.afterPark(dctx, run, rec)
			return
		}
	}
}

func describe(o runner.Outcome) string {
	switch {
	case o.TimedOut:
		return "it ran past the board's session limit"
	case o.Err != nil:
		return o.Err.Error()
	case o.IsError:
		return "it ended with an error: " + clip(o.Result, 300)
	case o.Result != "":
		return "it ended saying: " + clip(o.Result, 300)
	default:
		return "no reason given"
	}
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// job is the agent command line for one session.
func (d *Daemon) job(run *Run, v board.BoardView, path, system, task string, rec state.RunRecord, resume bool) runner.Job {
	j := runner.Job{
		Dir: path, Prompt: task, SystemPrompt: system, SessionID: rec.Session, Resume: resume,
		Name: clip(run.Title, 80), Permission: "acceptEdits", AllowedTools: defaultTools,
		Timeout: 180 * time.Minute,
		Env:     append(d.tools.SessionEnv(), "DUTYBOARD_RUN_TOKEN="+run.Token, "DUTYBOARD_HOME="+state.Home()),
	}
	if r := v.Runner; r != nil {
		if r.Model != "" {
			j.Model = r.Model
		}
		if r.Effort != "" {
			j.Effort = r.Effort
		}
		if r.PermissionMode != "" {
			j.Permission = r.PermissionMode
		}
		if len(r.AllowedTools) > 0 {
			j.AllowedTools = append(append([]string{}, r.AllowedTools...), "mcp__dutyboard")
		}
		if r.SessionMinutes > 0 {
			j.Timeout = time.Duration(r.SessionMinutes) * time.Minute
		}
	}
	if run.Kind == "setup" {
		j.AddDirs = []string{run.Spec.Repo}
	}
	j.MCPConfig = d.writeMCPConfig(run)
	return j
}

// writeMCPConfig names the local bridge as the session's DutyBoard server. The run token in its
// environment is how the daemon knows which session a message came from.
func (d *Daemon) writeMCPConfig(run *Run) string {
	p := state.Path("run", "sessions", run.Token+".json")
	cfg := map[string]any{"mcpServers": map[string]any{"dutyboard": map[string]any{
		"type": "stdio", "command": d.exe, "args": []string{"mcp"},
		"env": map[string]string{"DUTYBOARD_RUN_TOKEN": run.Token, "DUTYBOARD_HOME": state.Home()},
	}}}
	if err := state.WriteJSON(p, cfg, 0o600); err != nil {
		d.log.Printf("writing the session's MCP config: %v", err)
	}
	return p
}

// park puts a question on the duty for a person, and keeps the duty for this machine.
func (d *Daemon) park(ctx context.Context, run *Run, v board.BoardView, message string) {
	if err := d.api.Checkpoint(ctx, run.Board, run.DutyID, run.Agent, "question", message, "needs_decision", true); err != nil {
		d.log.Printf("parking %s: %v", run.DutyID, err)
	}
	records, _ := state.RunRecords()
	d.afterPark(ctx, run, records[run.DutyID])
}

// afterPark keeps a parked duty's worktree and conversation for when it comes back, and — when
// another machine could be the one to pick it up — pushes a snapshot of the work to the remote.
func (d *Daemon) afterPark(ctx context.Context, run *Run, rec state.RunRecord) {
	rec.Board, rec.Agent, rec.Attempts = run.Board, run.Agent, 0
	_ = state.SaveRunRecord(run.DutyID, &rec)
	d.mu.Lock()
	machines := d.polled[run.Board].Machines
	d.mu.Unlock()
	if machines > 1 && d.wt.Exists(run.Spec) {
		if err := d.wt.Snapshot(ctx, run.Spec); err != nil {
			d.log.Printf("snapshotting %s for another machine: %v", run.DutyID, err)
		}
	}
	d.log.Printf("%s: parked %q; its worktree waits for it", run.Board, run.Title)
}

// attachLog puts the tail of a session's event log on the duty, so the person deciding what to do
// next can see what happened.
func (d *Daemon) attachLog(ctx context.Context, run *Run, path string) {
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return
	}
	const max = 1 << 20
	if len(b) > max {
		b = b[len(b)-max:]
	}
	if err := d.api.Attach(ctx, run.Board, run.DutyID, run.Agent, "session-log.jsonl", "application/jsonl", b); err != nil {
		d.log.Printf("attaching the session log to %s: %v", run.DutyID, err)
	}
}

