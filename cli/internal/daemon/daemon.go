// Package daemon is the program's long-running half: it keeps the machine connected to its
// DutyBoard, decides what to work on, and runs one agent session per duty.
//
// The loop is code, not instructions. The daemon claims the duty, prepares its worktree, starts the
// agent with that one duty, and asks the board afterwards what state the session left it in —
// finished, parked on a question, or still held because the session stopped early. The agent never
// polls, claims, or picks its own next piece of work.
package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/live"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/tools"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// How often the daemon polls every board when nothing tells it to sooner. Board channels are the
// normal path; this catches a publish the platform dropped. Without live updates at all it polls
// much more often, because then it is the only path.
const (
	fallbackPoll = 15 * time.Minute
	pollNoLive   = 2 * time.Minute
	debounce     = 2 * time.Second
)

// Options configure a daemon.
type Options struct {
	Version string
	Config  *state.Config
	Key     string
	Out     io.Writer
}

// Daemon is one machine's worker.
type Daemon struct {
	opt   Options
	api   *board.Client
	wt    *worktree.Manager
	tools *tools.Registry
	log   *log.Logger
	exe   string

	mu           sync.Mutex
	me           *board.Me
	workspaces   map[string]string          // board → linked folder
	views        map[string]board.BoardView // board → profile and runner
	runs         map[string]*Run            // duty → session in flight
	tokens       map[string]*Run            // run token → session
	locks        map[string]*worktree.Lock  // board → integration lock
	rules        map[string]rulesEntry
	polled       map[string]board.PollBoard
	reported     map[string]string
	reportedAt   map[string]time.Time
	reportDue    map[string]bool
	requests     map[string]bool   // setup requests being handled
	problems     map[string]string // board → what stops this machine working it
	notices      map[string]string // board → what the owner should fix, which does not stop work
	access       map[string]accessCheck
	ghOK         bool
	ghCheckedAt  time.Time
	limitedUntil time.Time
	paused       bool

	wg     sync.WaitGroup
	wakeCh chan struct{}
	relink chan struct{}
	stop   context.CancelFunc
}

type rulesEntry struct {
	version int
	body    string
}

// New prepares a daemon.
func New(opt Options) (*Daemon, error) {
	if opt.Out == nil {
		opt.Out = os.Stdout
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	// "_tools" is no board's folder: board ids are lowercase letters, digits and dashes.
	tools.UseDir(filepath.Join(ProjectsRoot(opt.Config), "_tools"))
	reg, err := tools.Load()
	if err != nil {
		return nil, fmt.Errorf("reading the tool registry: %w", err)
	}
	api := board.New(opt.Config.Server, opt.Key)
	api.Origin = opt.Config.MachineID
	logger := log.New(opt.Out, "", log.LstdFlags)
	return &Daemon{
		opt:        opt,
		api:        api,
		wt:         &worktree.Manager{Root: state.Path("worktrees"), Log: logWriter{logger}},
		tools:      reg,
		log:        logger,
		exe:        exe,
		workspaces: map[string]string{},
		views:      map[string]board.BoardView{},
		runs:       map[string]*Run{},
		tokens:     map[string]*Run{},
		locks:      map[string]*worktree.Lock{},
		rules:      map[string]rulesEntry{},
		polled:     map[string]board.PollBoard{},
		reported:   map[string]string{},
		reportedAt: map[string]time.Time{},
		reportDue:  map[string]bool{},
		requests:   map[string]bool{},
		problems:   map[string]string{},
		notices:    map[string]string{},
		access:     map[string]accessCheck{},
		wakeCh:     make(chan struct{}, 1),
		relink:     make(chan struct{}, 1),
	}, nil
}

type logWriter struct{ l *log.Logger }

func (w logWriter) Write(p []byte) (int, error) {
	if s := strings.TrimSpace(string(p)); s != "" {
		w.l.Print(s)
	}
	return len(p), nil
}

// ErrRevoked is this machine's key, revoked in the console.
var ErrRevoked = errors.New("this machine was revoked in the console — run `dutyboard` again to pair it")

// Run works the boards until ctx ends or the machine is revoked.
func (d *Daemon) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	d.stop = cancel
	defer cancel()

	if err := d.refresh(ctx); err != nil {
		if board.IsStatus(err, 401) {
			_ = state.DeleteCredential(state.MachineKey)
			return ErrRevoked
		}
		return err
	}
	d.log.Printf("dutyboard %s — machine %q, %d board(s) linked", d.opt.Version, d.me.Machine.Name, len(d.me.Links))
	for _, missing := range d.tools.VerifyAll(ctx) {
		d.log.Printf("tool %s no longer works; its next setup duty will reinstall it", missing)
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- localmcp.Serve(ctx, d) }()
	interval := pollNoLive
	if d.me.Live {
		interval = fallbackPoll
		go d.liveLoop(ctx)
	} else {
		d.log.Printf("live updates are not configured on this DutyBoard; polling every %s", pollNoLive)
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.wake()
			}
		}
	}()

	d.wake()
	for {
		select {
		case <-ctx.Done():
			return d.shutdown()
		case err := <-serveErr:
			if err != nil && ctx.Err() == nil {
				return fmt.Errorf("the local MCP bridge stopped: %w", err)
			}
		case <-d.wakeCh:
			// Events come in bursts — a person files five duties, an interrupt moves two — and one
			// poll after the burst answers all of them.
			timer := time.NewTimer(debounce)
		drain:
			for {
				select {
				case <-d.wakeCh:
				case <-timer.C:
					break drain
				case <-ctx.Done():
					timer.Stop()
					return d.shutdown()
				}
			}
			if err := d.tick(ctx); err != nil {
				if errors.Is(err, ErrRevoked) {
					cancel()
					d.shutdown()
					return err
				}
				d.log.Printf("poll: %v", err)
			}
		}
	}
}

// shutdown stops every session. Their duties stay held: the next start finds them and resumes.
func (d *Daemon) shutdown() error {
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		d.log.Printf("some sessions did not stop within 20s")
	}
	return nil
}

func (d *Daemon) wake() {
	select {
	case d.wakeCh <- struct{}{}:
	default:
	}
}

// Reload is called by another `dutyboard` invocation that has just linked a folder.
func (d *Daemon) Reload() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d.mu.Lock()
	d.access = map[string]accessCheck{} // a reload is often a new deploy key: check again now
	d.mu.Unlock()
	if err := d.refresh(ctx); err != nil {
		d.log.Printf("reload: %v", err)
	}
	d.relinkLive()
	d.wake()
}

func (d *Daemon) relinkLive() {
	select {
	case d.relink <- struct{}{}:
	default:
	}
}

// refresh re-reads this machine's settings, links and linked folders.
func (d *Daemon) refresh(ctx context.Context) error {
	me, err := d.api.Me(ctx)
	if err != nil {
		return err
	}
	ws, err := state.Workspaces()
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.me = me
	d.workspaces = map[string]string{}
	for _, w := range ws {
		d.workspaces[w.Board] = w.Path
	}
	d.views = map[string]board.BoardView{}
	for _, l := range me.Links {
		d.views[l.ProjectID] = l
	}
	return nil
}

func (d *Daemon) liveLoop(ctx context.Context) {
	for {
		lctx, lcancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = live.Run(lctx, live.Options{
				Server: d.opt.Config.Server,
				Mint: func(ctx context.Context) (*live.Token, error) {
					t, err := d.api.Live(ctx)
					if err != nil {
						return nil, err
					}
					return &live.Token{Token: t.Token, WSURL: t.WSURL, ExpiresAt: t.ExpiresAt, Channels: t.Channels}, nil
				},
				OnEvent:     d.onEvent,
				OnConnected: d.wake,
				OnState: func(s string) {
					if s != "live" {
						d.log.Printf("live: %s", s)
					}
				},
			})
		}()
		select {
		case <-ctx.Done():
			lcancel()
			<-done
			return
		case <-d.relink:
			lcancel()
			<-done
		}
	}
}

func (d *Daemon) onEvent(ev live.Event) {
	if strings.HasPrefix(ev.Channel, "machine.") {
		switch ev.T() {
		case "revoked":
			d.log.Printf("this machine was revoked in the console; stopping")
			_ = state.DeleteCredential(state.MachineKey)
			if d.stop != nil {
				d.stop()
			}
		case "links":
			go d.Reload()
		default: // setup, pause, resume, config
			d.wake()
		}
		return
	}
	switch ev.T() {
	case "duty", "thread":
		id, status := ev.Str("id"), ev.Str("status")
		d.mu.Lock()
		run := d.runs[id]
		d.mu.Unlock()
		// A person moved the duty a session is working on. Stop the session: whatever it does next
		// is work nobody asked for any more. Our own writes echo back with our origin, and a session
		// parking its own duty is not a cancellation.
		if run != nil && status != "" && status != "active" && ev.Str("o") != d.opt.Config.MachineID {
			d.log.Printf("%s was moved to %s on the board; stopping its session", id, status)
			run.cancelByBoard()
		}
		if status == "queued" || status == "done" || status == "failed" || status == "deleted" {
			d.wake()
		}
	case "board":
		// A profile or rules change: re-read settings, but the channels this machine listens on are
		// the same, so the socket stays as it is.
		board := strings.TrimPrefix(ev.Channel, "board.")
		d.mu.Lock()
		delete(d.rules, board)
		d.mu.Unlock()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := d.refresh(ctx); err != nil {
				d.log.Printf("reloading settings: %v", err)
			}
			d.wake()
		}()
	}
}

// tick is one look at every board: settings, setup requests, and whatever can start now.
func (d *Daemon) tick(ctx context.Context) error {
	p, err := d.api.Poll(ctx)
	if board.IsStatus(err, 401) {
		_ = state.DeleteCredential(state.MachineKey)
		return ErrRevoked
	}
	if err != nil {
		return err
	}
	d.mu.Lock()
	d.paused = p.Paused
	for _, b := range p.Boards {
		d.polled[b.ProjectID] = b
	}
	limited := time.Now().Before(d.limitedUntil)
	maxSessions := 3
	if d.me != nil && d.me.Machine.MaxSessions > 0 {
		maxSessions = d.me.Machine.MaxSessions
	}
	d.mu.Unlock()

	for _, req := range p.Requests {
		if req.Status == "pending" {
			d.handleRequest(ctx, req)
		}
	}
	// Every linked board gets its clone here, before anything is claimed on it — a board linked from
	// the console, or whose repository just changed, is ready by the time its duties are.
	d.ensureWorkspaces(ctx)
	if p.Paused || limited {
		return nil
	}

	// Boards in a rotating order, one start per board per pass, so a board with a long queue cannot
	// take every session while another waits.
	boards := append([]board.PollBoard(nil), p.Boards...)
	sort.Slice(boards, func(i, j int) bool { return boards[i].ProjectID < boards[j].ProjectID })
	if n := len(boards); n > 0 {
		shift := int(time.Now().Unix()/60) % n
		boards = append(boards[shift:], boards[:shift]...)
	}
	started := map[string]int{}
	tried := map[string]bool{}
	for progress := true; progress; {
		progress = false
		for _, b := range boards {
			if d.running() >= maxSessions {
				return nil
			}
			if d.folder(b.ProjectID) == "" || d.problem(b.ProjectID) != "" {
				continue
			}
			if d.startOne(ctx, b, started, tried) {
				progress = true
			}
		}
	}
	return nil
}

func (d *Daemon) folder(boardID string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.workspaces[boardID]
}

func (d *Daemon) running() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.runs)
}

func (d *Daemon) isRunning(duty string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.runs[duty] != nil
}

// startOne starts at most one session on a board: first a duty this machine already holds but is
// not running (a restart, a plan limit that lifted), then the top of the queue.
func (d *Daemon) startOne(ctx context.Context, b board.PollBoard, started map[string]int, tried map[string]bool) bool {
	for _, a := range b.Active {
		if !a.Mine || d.isRunning(a.DutyID) || tried[a.DutyID] {
			continue
		}
		tried[a.DutyID] = true
		duty, err := d.api.Get(ctx, b.ProjectID, a.DutyID)
		if err != nil {
			d.log.Printf("reading held duty %s: %v", a.DutyID, err)
			continue
		}
		d.launch(ctx, b.ProjectID, a.AgentID, duty, true)
		return true
	}

	if b.Parallel > 0 && len(b.Active)+started[b.ProjectID] >= b.Parallel {
		return false
	}
	// Setup, then rules, then the queue: both change what every later duty runs against. The server
	// orders them this way too; sorting here as well keeps it so against one that does not yet.
	runnable := append(b.Runnable[:0:0], b.Runnable...)
	rank := func(kind string) int {
		switch kind {
		case "setup":
			return 0
		case "rules":
			return 1
		}
		return 2
	}
	sort.SliceStable(runnable, func(i, j int) bool { return rank(runnable[i].Kind) < rank(runnable[j].Kind) })
	for _, r := range runnable {
		if d.isRunning(r.DutyID) || tried[r.DutyID] {
			continue
		}
		tried[r.DutyID] = true
		agent := d.freeLane(b)
		claimed, err := d.api.Claim(ctx, b.ProjectID, r.DutyID, agent)
		if err != nil {
			if board.IsStatus(err, 409) {
				var e *board.Error
				if errors.As(err, &e) && (strings.Contains(e.Message, "at a time") || strings.Contains(e.Message, "to itself")) {
					return false // the board is full; the next event or poll tries again
				}
				if errors.As(err, &e) && !strings.Contains(e.Message, "claimed by another") && !strings.Contains(e.Message, "reserved") && !strings.Contains(e.Message, "parked on machine") {
					d.log.Printf("could not claim %s on %s: %s", r.DutyID, b.ProjectID, e.Message)
				}
				continue // someone else took it, or it is parked for another machine
			}
			d.log.Printf("claiming %s on %s: %v", r.DutyID, b.ProjectID, err)
			continue
		}
		started[b.ProjectID]++
		d.launch(ctx, b.ProjectID, agent, &claimed.Duty, r.Resumes)
		return true
	}
	return false
}

// freeLane is the lowest `<prefix>/<n>` neither running here nor holding a duty on the board.
func (d *Daemon) freeLane(b board.PollBoard) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	used := map[string]bool{}
	for _, r := range d.runs {
		used[r.Agent] = true
	}
	for _, a := range b.Active {
		used[a.AgentID] = true
	}
	for n := 1; ; n++ {
		agent := fmt.Sprintf("%s/%d", d.me.Machine.AgentPrefix, n)
		if !used[agent] {
			return agent
		}
	}
}

func (d *Daemon) lock(boardID string) *worktree.Lock {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.locks[boardID] == nil {
		d.locks[boardID] = &worktree.Lock{}
	}
	return d.locks[boardID]
}

// report tells the console what this machine is doing on a board, when that changed.
func (d *Daemon) report(ctx context.Context, boardID string) {
	d.mu.Lock()
	var runs []board.Run
	for _, r := range d.runs {
		if r.Board == boardID {
			runs = append(runs, board.Run{DutyID: r.DutyID, State: r.state(), Detail: r.detail()})
		}
	}
	problem := d.problems[boardID]
	if problem == "" {
		problem = d.notices[boardID]
	}
	d.mu.Unlock()
	sort.Slice(runs, func(i, j int) bool { return runs[i].DutyID < runs[j].DutyID })
	key := fmt.Sprint(runs, problem)
	d.mu.Lock()
	same := d.reported[boardID] == key
	d.reported[boardID] = key
	if !same {
		d.reportedAt[boardID] = time.Now()
	}
	d.mu.Unlock()
	if same {
		return
	}
	if err := d.api.ReportState(ctx, boardID, runs, problem); err != nil {
		d.log.Printf("reporting state on %s: %v", boardID, err)
	}
}

// activityEvery is how often what a session is doing is reported, at most, per board. A session can
// start a dozen things a minute; the console needs to see roughly what, not every one.
func activityEvery() time.Duration {
	if s, err := strconv.Atoi(os.Getenv("DUTYBOARD_ACTIVITY_SECONDS")); err == nil && s >= 0 {
		return time.Duration(s) * time.Second
	}
	return 15 * time.Second
}

// reportSoon reports a board's state now if it has not been reported recently, and otherwise once
// the interval is up — so a burst of activity is one write, carrying its latest line.
func (d *Daemon) reportSoon(boardID string) {
	d.mu.Lock()
	if d.reportDue[boardID] {
		d.mu.Unlock()
		return
	}
	wait := activityEvery() - time.Since(d.reportedAt[boardID])
	d.reportDue[boardID] = true
	d.mu.Unlock()
	if wait < 0 {
		wait = 0
	}
	time.AfterFunc(wait, func() {
		d.mu.Lock()
		delete(d.reportDue, boardID)
		d.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		d.report(ctx, boardID)
	})
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// newSessionID is a UUID v4, which is what Claude Code takes as a session id.
func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
