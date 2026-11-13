package daemon

import (
	"context"
	"errors"
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
	"github.com/altlimit/dutyboard/cli/internal/tools"
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

// Run is one duty being worked on this machine.
type Run struct {
	Board, DutyID, Agent, Kind, Title string
	Token                             string
	Spec                              worktree.Spec
	Worktree                          string
	// Files is a duty worked in a folder of its own, with no repository: on a board of one-off tasks,
	// or on one that runs an account through its MCP servers (Service).
	Files   bool
	Service bool

	mu         sync.Mutex
	st, det    string
	integrated *worktree.Result
	opened     []string // the board's other repositories this duty has a worktree of
	cancel     context.CancelFunc
	byBoard    atomic.Bool
	// missingSince is when the board first answered without this duty among those this machine holds.
	missingSince time.Time
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

func (d *Daemon) specFor(ctx context.Context, boardID, duty string, v board.BoardView) worktree.Spec {
	repo := d.wt.RepoOf(ctx, boardID, duty) // a duty already under way stays on its clone
	if repo == "" {
		repo = d.folder(boardID)
	}
	s := worktree.Spec{Repo: repo, Board: boardID, DutyID: duty, CopyFrom: d.localDir(boardID)}
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
	if v.Profile != nil && v.Profile.Git.Mode == "squash" {
		return worktree.ModeSquash
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
	if records, _ := state.RunRecords(); duty.Check != "" && records[run.DutyID].Check == "" {
		if d.check(dctx, rctx, run, v, duty) {
			return
		}
	}
	spec := d.specFor(dctx, run.Board, run.DutyID, v)
	run.Spec, run.Files, run.Service = spec, v.Folder(), v.Service()
	run.set("working", "preparing its worktree")
	d.report(dctx, run.Board)

	var (
		path, prepFailed string
		created          bool
		files            prompt.Files
		err              error
	)
	if run.Files {
		path, created, files.Inputs, files.Missing, err = d.prepareFiles(rctx, run, duty)
		if err != nil {
			if rctx.Err() != nil {
				d.settleStopped(dctx, run, v)
				return
			}
			d.park(dctx, run, v, fmt.Sprintf("The runner on this machine could not fetch this duty's files, so it has not started:\n\n%v", err))
			return
		}
		files.Dir = path
		_, files.In, files.Out = d.filesFolder(run)
		if run.Service {
			files.Service = true
			if files.Keep, err = d.keptFolder(run.Board); err != nil {
				d.park(dctx, run, v, fmt.Sprintf("The runner on this machine could not make the board's kept folder, so this duty has not started:\n\n%v", err))
				return
			}
		}
	} else {
		path, created, err = d.wt.Ensure(rctx, spec)
		if rctx.Err() != nil {
			// Whatever went wrong in there is the stopping, not something to ask a person about.
			d.settleStopped(dctx, run, v)
			return
		}
		var prepErr *worktree.PrepError
		switch {
		case errors.As(err, &prepErr) && path != "":
			// The worktree is there; only its prep failed. That is the session's to sort out — it has the
			// shell and the project in front of it — not a question for a person.
			d.log.Printf("%s: prep failed for %q, handing it to the session: %v", run.Board, run.Title, prepErr.Err)
			prepFailed = fmt.Sprintf("Command: %s\nError: %v\nOutput (tail):\n%s", prepErr.Command, prepErr.Err, prepErr.Output)
		case err != nil:
			d.park(dctx, run, v, fmt.Sprintf("The runner on this machine could not prepare a worktree for this duty, so it has not started:\n\n%v", err))
			return
		}
	}
	run.Worktree = path

	records, _ := state.RunRecords()
	rec := records[run.DutyID]
	rec.Board, rec.Agent = run.Board, run.Agent
	// The board's other repositories: the folders for all of them, and a worktree of each the duty
	// opened before — or of every one, for a setup, which has to make the machine ready for them all.
	d.repoPlaceholders(dctx, run, v)
	for _, r := range boardRepos(v) {
		if run.Files {
			break
		}
		wanted := run.Kind == "setup"
		for _, n := range rec.Repos {
			wanted = wanted || n == r.Name
		}
		if !wanted {
			continue
		}
		if _, failed, err := d.openRepo(rctx, run, v, r.Name); err != nil {
			d.log.Printf("%s: opening repository %q for %s: %v", run.Board, r.Name, run.DutyID, err)
		} else if failed != "" {
			prepFailed += fmt.Sprintf("\n\nIn repository %s (%s):\n%s", r.Name, d.wt.PathOf(d.repoSpec(dctx, run.Board, run.DutyID, r)), failed)
		}
	}
	// A conversation can only be resumed where it happened: a new worktree means a new session.
	resume := !created && rec.Session != "" && (resuming || rec.Attempts > 0)
	if rec.Session == "" || created {
		rec.Session, resume = newSessionID(), false
	}
	if created {
		rec.Attempts = 0
	}

	for {
		if rctx.Err() != nil {
			_ = state.SaveRunRecord(run.DutyID, &rec)
			d.settleStopped(dctx, run, v)
			return
		}
		// Re-read policy between attempts, including while every option is cooling down.
		policy := v
		policy.Runner = d.view(run.Board).Runner
		policy = withDutyOptions(policy, duty.AgentOptions)
		choice, until, choiceErr := d.chooseAgent(rctx, policy, true)
		if choiceErr != nil {
			d.park(dctx, run, v, "No configured agent can continue this duty: "+choiceErr.Error())
			return
		}
		if !until.IsZero() {
			// Keep the claim and worktree but release this machine's session slot.
			// The scheduler resumes the held duty once a choice becomes available.
			_ = state.SaveRunRecord(run.DutyID, &rec)
			d.setNotice(dctx, run.Board, "All configured agent options are at their usage limit; next reset "+until.Format(time.RFC3339))
			d.wakeAt(until)
			return
		}
		v = withChoice(policy, choice)
		var switched bool
		resume, switched = prepareChoice(&rec, choice, resume)
		rulesAt, rules := d.rulesFor(dctx, run.Board)
		in := prompt.Input{
			Duty: *duty, Board: v, Rules: rules, RulesAt: rulesAt, Branch: spec.Branch(), Worktree: path,
			Mode: string(modeFor(dctx, v, spec)), Resuming: resume || switched, Attempt: rec.Attempts,
			ProjectRoot: spec.Repo, LocalDir: spec.CopyFrom, Tools: d.tools.Describe(), PrepFailed: prepFailed,
			Repos: d.promptRepos(dctx, run, v), Check: rec.Check,
		}
		if run.Files {
			in.Files = &files
		}
		servers, _ := d.boardMCPServers(v)
		for _, s := range servers {
			in.MCPServers = append(in.MCPServers, prompt.MCPServer{Name: s.Name, Tools: s.Tools, Note: noteOf(v, s.Name)})
		}
		if run.Kind == "setup" || run.Kind == "rules" {
			kind := ""
			if v.Profile != nil {
				kind = v.Profile.Type
			}
			in.Hints = hints.For(kind)
		}
		if run.Kind == "setup" && !run.Files {
			base := spec.Base
			if base == "" {
				base = worktree.DefaultBranch(dctx, spec.Repo, worktree.Remote(dctx, spec.Repo))
			}
			in.Detected = deploy.Detect(path, base).Describe()
			// Read from what the duty started from, not the worktree: a resumed session that has
			// already built part of the first version is still building it.
			ref := base
			if remote := worktree.Remote(dctx, spec.Repo); remote != "" {
				ref = remote + "/" + base
			}
			in.Fresh = worktree.Fresh(dctx, spec.Repo, ref)
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

		if switched {
			task += "\n\nThis duty is continuing with a different agent/model/effort. The previous session may have left unfinished changes. Read the duty thread, inspect the existing files and git diff, preserve completed work, and continue from that state. Do not assume the previous attempt finished or repeat external actions without checking their outcome."
		}
		job := d.job(run, v, path, system, task, rec, resume)
		logPath := state.Path("logs", run.Board, run.DutyID, time.Now().Format("20060102-150405.000000000")+".jsonl")
		_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
		logFile, _ := os.Create(logPath)
		if logFile != nil {
			job.Log = logFile
		}
		rec.Repos = run.openRepos()
		_ = state.SaveRunRecord(run.DutyID, &rec)
		run.set("working", choice.Agent+" · "+choice.Model+" · "+choice.Effort)
		d.report(dctx, run.Board)

		agent, err := runner.For(agentName(v))
		if err != nil {
			d.park(dctx, run, v, "The runner on this machine could not start this duty: "+err.Error())
			return
		}
		outcome := agent.Run(rctx, job)
		if logFile != nil {
			logFile.Close()
		}
		rec.Repos = run.openRepos()
		if len(outcome.Denied) > 0 {
			// Refused tools are the runner's business, so they are said here, where its owner looks —
			// not left to the session to raise as a duty for someone who never configured them.
			d.log.Printf("%s: %q was refused %d tool call(s): %s — widen the board's allowed tools if the work needs them",
				run.Board, clip(run.Title, 60), len(outcome.Denied), clip(strings.Join(outcome.Denied, "; "), 400))
		}
		if outcome.Session != "" {
			rec.Session = outcome.Session
		}
		if dctx.Err() != nil {
			// The daemon is stopping. The duty stays held; the next start resumes it.
			_ = state.SaveRunRecord(run.DutyID, &rec)
			return
		}

		fresh, err := d.api.Get(dctx, run.Board, run.DutyID)
		if board.IsStatus(err, 404) {
			d.log.Printf("%s was deleted; removing its worktree", run.DutyID)
			d.removeWork(dctx, run, v, false)
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
			d.removeWork(dctx, run, v, keepBranch)
			_ = state.SaveRunRecord(run.DutyID, nil)
			d.log.Printf("%s: %s %q", run.Board, fresh.Status, fresh.Title)
			if run.byBoard.Load() {
				d.noteRemoved(dctx, run, true)
			}
			if fresh.Status == "done" && res != nil && res.OK && !res.NoOp && (res.Mode == worktree.ModePush || res.Mode == worktree.ModeSquash) {
				d.watchDeploy(dctx, run, v, spec, res.Commit)
			}
			return
		case "active":
			if fresh.AssignedAgentID != run.Agent {
				_ = state.SaveRunRecord(run.DutyID, nil)
				return
			}
			if outcome.Limited && !run.byBoard.Load() {
				until := outcome.ResetsAt
				if until.IsZero() || !until.After(time.Now()) {
					until = time.Now().Add(30 * time.Minute)
				}
				d.markLimited(choice, until)
				_ = state.SaveRunRecord(run.DutyID, &rec)
				d.log.Printf("%s/%s reached its usage limit until %s; trying the next configured option", choice.Agent, choice.Model, until.Format(time.RFC3339))
				_ = d.api.Checkpoint(dctx, run.Board, run.DutyID, run.Agent, "note", fmt.Sprintf("%s (%s) reached its usage limit. The runner will try the next enabled option; existing work is kept.", choice.Agent, choice.Model), "", false)
				fresh.Notes = duty.Notes
				duty, resume = fresh, true
				continue
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
			case <-rctx.Done():
			case <-time.After(time.Duration(rec.Attempts) * retryDelay()):
			}
			fresh.Notes = duty.Notes // a claim hands them over; a read of the duty does not
			duty, resume = fresh, true
		default: // needs_decision, blocked, queued: the session parked it, or a person moved it
			d.afterPark(dctx, run, rec)
			return
		}
	}
}

// settleStopped ends a run stopped while no session was running: still being prepared, or waiting to
// retry. The board says what becomes of its work. It does nothing when the daemon itself is stopping,
// since the record is what the next start resumes from.
func (d *Daemon) settleStopped(dctx context.Context, run *Run, v board.BoardView) {
	if dctx.Err() != nil || !run.byBoard.Load() {
		return
	}
	fresh, err := d.api.Get(dctx, run.Board, run.DutyID)
	gone := board.IsStatus(err, 404)
	if err != nil && !gone {
		d.log.Printf("reading %s after stopping it: %v", run.DutyID, err)
		return
	}
	switch {
	case gone || fresh.Status == "done" || fresh.Status == "failed":
		d.removeWork(dctx, run, v, false)
		_ = state.SaveRunRecord(run.DutyID, nil)
		if !gone {
			d.noteRemoved(dctx, run, true)
		}
	case fresh.Status == "active": // moved and moved back: the next pass picks it up as held
	default:
		records, _ := state.RunRecords()
		d.afterPark(dctx, run, records[run.DutyID])
	}
}

// noteRemoved puts it on the record that this machine has let go of a duty, so whoever called it off
// can see that nothing is left running here rather than having to wonder.
func (d *Daemon) noteRemoved(ctx context.Context, run *Run, stopped bool) {
	d.mu.Lock()
	machine := ""
	if d.me != nil {
		machine = d.me.Machine.Name
	}
	d.mu.Unlock()
	what, left := "worktree", ""
	if run.Files {
		what = "folder"
		dir, _, _ := d.filesFolder(run)
		if _, err := os.Stat(dir); err == nil {
			left = dir
		}
	} else if d.wt.Exists(run.Spec) {
		left = d.wt.PathOf(run.Spec)
	}
	msg := fmt.Sprintf("Removed this duty's %s on %s.", what, machine)
	if stopped {
		msg = fmt.Sprintf("Stopped this duty's session on %s, with everything it started, and removed its %s.", machine, what)
	}
	if left != "" {
		msg = fmt.Sprintf("Stopped this duty's session on %s, but could not remove `%s`.", machine, left)
		if !stopped {
			msg = fmt.Sprintf("Could not remove this duty's %s on %s: `%s`.", what, machine, left)
		}
	}
	if err := d.api.Checkpoint(ctx, run.Board, run.DutyID, run.Agent, "note", msg, "", false); err != nil {
		d.log.Printf("noting the clean-up on %s: %v", run.DutyID, err)
	}
}

// removeWork removes a finished duty's worktrees — or, on a board with no repository, its folder. The
// folder a board run through its MCP servers keeps between duties stays.
func (d *Daemon) removeWork(ctx context.Context, run *Run, v board.BoardView, keepBranch bool) {
	if run.Files {
		dir, _, _ := d.filesFolder(run)
		_ = os.RemoveAll(dir)
		return
	}
	_ = d.wt.Remove(ctx, run.Spec, keepBranch)
	d.removeRepos(ctx, run, v, keepBranch)
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

func noteOf(v board.BoardView, server string) string {
	for _, s := range v.Profile.MCPServers {
		if s.Name == server {
			return s.Note
		}
	}
	return ""
}

// agentName is the agent a board's duties are worked by, "" for the default.
func agentName(v board.BoardView) string {
	if v.Runner != nil {
		return v.Runner.Agent
	}
	return ""
}

// job is one session, in terms that are no one agent's: the agent turns it into its command line.
func (d *Daemon) job(run *Run, v board.BoardView, path, system, task string, rec state.RunRecord, resume bool) runner.Job {
	servers, _ := d.boardMCPServers(v)
	j := runner.Job{
		Dir: path, Prompt: task, Instructions: system, SessionID: rec.Session, Resume: resume,
		Mark:       "DUTYBOARD_RUN_TOKEN=" + run.Token,
		Name:       clip(run.Title, 80),
		Timeout:    180 * time.Minute,
		SessionDir: state.Path("run", "sessions", run.Token),
		// The local bridge is the session's DutyBoard server. The run token in its environment is how
		// the daemon knows which session a message came from.
		MCPServers: append([]runner.MCPServer{{
			Name: "dutyboard", Command: d.exe, Args: []string{"mcp"},
			Env:     map[string]string{"DUTYBOARD_HOME": state.Home()},
			Secrets: map[string]string{"DUTYBOARD_RUN_TOKEN": run.Token},
		}}, servers...),
		// A worktree's commits are written to its clone's git folder, and setup installs into the tools
		// folder: an agent that sandboxes its writes to the worktree needs both.
		Writable: append(append([]string{tools.Dir()}, d.repoWritable(v)...), d.repoPlaceholders(context.Background(), run, v)...),
		AddDirs:  d.repoPlaceholders(context.Background(), run, v),
		Env:      append(d.tools.SessionEnv(), "DUTYBOARD_RUN_TOKEN="+run.Token, "DUTYBOARD_HOME="+state.Home()),
	}
	if r := v.Runner; r != nil {
		j.NativeEffort = r.UseMachineDefaults || r.Options != nil
		if r.Model != "" {
			j.Model = r.Model
		}
		if r.Effort != "" {
			j.Effort = r.Effort
		}
		// A board's permission mode and extra tools are its agent's own terms; the agent reads them.
		j.Access = runner.Access{Mode: r.PermissionMode, Tools: r.AllowedTools}
		if r.SessionMinutes > 0 {
			j.Timeout = time.Duration(r.SessionMinutes) * time.Minute
		}
	}
	if run.Spec.Repo != "" {
		j.Writable = append(j.Writable, filepath.Join(run.Spec.Repo, ".git"))
	}
	if run.Kind == "setup" && !run.Files {
		j.AddDirs = append(j.AddDirs, run.Spec.CopyFrom)
	}
	if run.Service {
		// What a board run through its MCP servers keeps between duties on this machine.
		j.AddDirs = append(j.AddDirs, d.localDir(run.Board))
		j.Writable = append(j.Writable, d.localDir(run.Board))
	}
	var loggedAt time.Time
	j.OnActivity = func(line string) {
		if run.state() != "working" {
			return // integrating and the like say more than the tool call that started them
		}
		run.set("working", clip(line, 280))
		d.reportSoon(run.Board)
		// The terminal gets a line now and then, so someone watching it can see the session is alive
		// without it scrolling every file read past them.
		if time.Since(loggedAt) >= time.Minute {
			loggedAt = time.Now()
			d.log.Printf("%s: %s — %s", run.Board, clip(run.Title, 60), clip(line, 120))
		}
	}
	return j
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
		d.snapshotRepos(ctx, run, d.view(run.Board))
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
