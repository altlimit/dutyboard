// Package runner starts the agent that does a duty. An Agent is one coding agent — Claude Code today
// — and a Job says what a session needs in terms that are not any one agent's: the worktree, the
// prompt, the MCP servers, what it may do. Each agent turns a Job into its own command line and reads
// its own output back into an Outcome, so the daemon never learns an agent's flags or event format.
package runner

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Agent is a coding agent the runner can start.
type Agent interface {
	// Name is how a board names it in `runner.agent`.
	Name() string
	// Check says whether this machine can run it: installed, and findable. Being signed in is found
	// out by the first session.
	Check(ctx context.Context) error
	// Run works one session to its end.
	Run(ctx context.Context, j Job) Outcome
}

// DefaultAgent is the agent a board that names none gets.
const DefaultAgent = "claude-code"

var agents = map[string]Agent{
	DefaultAgent: Claude{},
	"codex":      Codex{},
	"cursor":     Cursor{},
}

// For answers the agent a board names, "" being the default.
func For(name string) (Agent, error) {
	if name == "" {
		name = DefaultAgent
	}
	if a, ok := agents[name]; ok {
		return a, nil
	}
	return nil, fmt.Errorf("this version of dutyboard cannot run the %q agent (it knows %s)", name, strings.Join(Names(), ", "))
}

// Names are the agents this build can run.
func Names() []string {
	out := make([]string, 0, len(agents))
	for n := range agents {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Job is one session.
type Job struct {
	Dir          string // the duty's worktree; the session runs in it
	Prompt       string // the duty
	Instructions string // how to work a duty, the rules and the project, added to the agent's own
	SessionID    string // a UUID; with Resume, the conversation to continue
	Resume       bool
	Name         string // a label for the session, where the agent keeps one
	Model        string // the board's choice, in the agent's terms; "" for the agent's default
	Effort       string
	// SessionDir is a private folder for the session's own files (an MCP config, say). The agent may
	// write there; the runner removes it when the session ends.
	SessionDir string
	MCPServers []MCPServer
	Access     Access
	AddDirs    []string // folders outside the worktree the session may read, such as the board's local files
	// Writable are folders outside the worktree a sandboxed agent must be able to write: the
	// repository's git data (a worktree's commits land there), the tools folder.
	Writable []string
	Env      []string
	Log      io.Writer // the agent's raw output, one event per line
	Timeout  time.Duration
	// OnActivity receives a short line each time the agent starts something: "Editing
	// src/ui/pause.gd", "Running `npm test`". Called from the reading goroutine; keep it cheap.
	OnActivity func(string)
}

// MCPServer is one MCP server a session is connected to: a command the agent starts (stdio), or a
// URL it connects to (HTTP).
type MCPServer struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string // plain settings, for a command
	URL     string
	// Secrets are credentials: environment variables for a command, headers for a URL. Kept apart
	// from Env so an agent can keep them off its command line.
	Secrets map[string]string
	// Tools are the server's tools the session may call without asking; empty allows them all.
	Tools []string
}

// Access is what a session may do without asking, which headless is everything it may do at all.
// The default — edit files in the worktree, run commands, read the web, and use its MCP servers — is
// each agent's to express.
type Access struct {
	// Mode is a board's permission mode, in its agent's terms; "" is the default above.
	Mode string
	// Tools are more of the agent's own tools a board allows, on top of the default.
	Tools []string
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
	// Denied is each tool call the permission rules refused, as "Tool: input".
	Denied []string
}

// stream reads an agent's output, a line at a time, into the Outcome, and says what the agent just
// started doing ("" for a line that is not the start of something).
type stream interface {
	Read(line []byte, out *Outcome) (activity string)
}

// runProcess runs an agent's command in the job's worktree until it exits, the job times out or the
// context ends, feeding each line of its output to s. Shared by every agent: what differs between
// them is the command and the reading, not keeping a process and its children in hand.
func runProcess(ctx context.Context, j Job, bin string, args []string, stdin io.Reader, s stream) Outcome {
	runCtx := ctx
	var cancel context.CancelFunc
	if j.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, j.Timeout)
		defer cancel()
	}

	cmd := exec.Command(bin, args...)
	cmd.Dir = j.Dir
	cmd.Env = append(os.Environ(), j.Env...)
	cmd.Stdin = stdin
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
	// children of its own — a test run, a dev server, an MCP server — and killing only the parent
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
		if a := s.Read(line, &out); a != "" && j.OnActivity != nil {
			j.OnActivity(a)
		}
	}
	err = cmd.Wait()
	close(stopped)

	switch {
	case errors.Is(runCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil:
		out.TimedOut = true
	case ctx.Err() != nil:
		out.Canceled = true
	case err != nil && !out.Limited:
		out.Err = fmt.Errorf("%s exited: %w: %s%s", filepath.Base(bin), err, strings.TrimSpace(stderr.String()), killedHint(err))
	}
	return out
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

// killedHint explains an agent that died of a signal the runner did not send — its own stops are
// reported as a timeout or a cancellation instead. The usual cause is a command in the session that
// matched the agent's own process: `pkill -f` or `pgrep -f` on text that appears in its prompt.
func killedHint(err error) string {
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return ""
	}
	code := exit.ExitCode()
	if code == 143 || code == 137 || code == -1 {
		return " — it was killed by something on this machine, not by the runner: often a command in the session (pkill -f, or a script's cleanup) matched the agent's own process, whose command line carries the whole prompt"
	}
	return ""
}
