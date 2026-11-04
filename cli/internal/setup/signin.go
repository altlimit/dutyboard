// Package setup is what the console can ask a machine to do about the tools duties need: install an
// agent or the GitHub CLI, and sign in to one.
//
// A sign-in runs the tool's own login command, unattended, and passes what it prints for a person —
// a link, a one-time code — to the console, which shows it to the machine's owner. Each of these
// tools has a sign-in made for a machine without a browser: GitHub's and Codex's device codes,
// Cursor's link, and Claude's link plus a code pasted back, which the console returns to the
// command's stdin. No credential passes through DutyBoard: the person signs in on the tool's own
// site, and the tool keeps what it gets on this machine.
package setup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Prompt is what a sign-in needs a person to do.
type Prompt struct {
	URL        string `json:"url,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
	NeedsInput bool   `json:"needs_input,omitempty"`
}

// signIn is how one tool signs in unattended.
type signIn struct {
	label string
	bin   func() string
	args  []string
	env   []string
	// message tells the person what to do with the prompt.
	message string
	// inputMarker is text the command prints when it waits for a value pasted back; "" for a tool that
	// finds out by itself that the person signed in.
	inputMarker string
	// enter is sent on stdin first, for a tool that waits for Enter before showing its code.
	enter bool
	// after runs once the sign-in succeeds.
	after [][]string
}

// noBrowser keeps a sign-in from opening a browser on the machine — on a server there is none, and on
// a desktop the person is at the console instead.
var noBrowser = []string{"BROWSER=true", "GH_BROWSER=true", "NO_OPEN_BROWSER=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1"}

func signIns() map[string]signIn {
	return map[string]signIn{
		"claude-code": {
			label: "Claude Code", bin: envOr("DUTYBOARD_CLAUDE", "claude"),
			args:        []string{"auth", "login"},
			message:     "Open the link and sign in. The page then shows a code: paste it here.",
			inputMarker: "Paste code",
		},
		"codex": {
			label: "Codex", bin: envOr("DUTYBOARD_CODEX", "codex"),
			args:    []string{"login", "--device-auth"},
			message: "Open the link, sign in, and enter the code.",
		},
		"cursor": {
			label: "Cursor", bin: cursorBin,
			args:    []string{"login"},
			message: "Open the link and sign in.",
		},
		"gh": {
			label: "GitHub CLI", bin: func() string { return "gh" },
			args:    []string{"auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"},
			message: "Open the link, sign in to GitHub, and enter the code.",
			enter:   true,
			after:   [][]string{{"auth", "setup-git"}},
		},
	}
}

func envOr(name, def string) func() string {
	return func() string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return def
	}
}

func cursorBin() string {
	if b := os.Getenv("DUTYBOARD_CURSOR"); b != "" {
		return b
	}
	if _, err := exec.LookPath("cursor-agent"); err == nil {
		return "cursor-agent"
	}
	return "agent"
}

// Label is a tool's name for people.
func Label(tool string) string {
	if s, ok := signIns()[tool]; ok {
		return s.label
	}
	return tool
}

// SignInTimeout is how long a sign-in waits for a person.
const SignInTimeout = 15 * time.Minute

// SignIn runs tool's sign-in. show is called whenever there is more to tell the person; input waits
// for the value they paste back, for the tools that need one.
func SignIn(ctx context.Context, tool string, show func(Prompt), input func(context.Context) (string, error)) error {
	s, ok := signIns()[tool]
	if !ok {
		return fmt.Errorf("this dutyboard cannot sign in to %q", tool)
	}
	bin := s.bin()
	if _, err := exec.LookPath(bin); err != nil {
		return fmt.Errorf("%s is not installed on this machine", s.label)
	}
	ctx, cancel := context.WithTimeout(ctx, SignInTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, s.args...)
	cmd.Env = append(os.Environ(), noBrowser...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out := &watched{}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		return err
	}
	if s.enter {
		_, _ = io.WriteString(stdin, "\n")
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	shown := Prompt{}
	asked := false
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			_ = stdin.Close()
			if err != nil {
				if ctx.Err() != nil {
					return fmt.Errorf("nobody finished signing in to %s within %s", s.label, SignInTimeout)
				}
				return fmt.Errorf("signing in to %s failed: %s", s.label, lastLines(out.String(), 2, err))
			}
			for _, args := range s.after {
				if b, err := exec.CommandContext(ctx, bin, args...).CombinedOutput(); err != nil {
					return fmt.Errorf("signed in to %s, but `%s %s` failed: %s", s.label, bin, strings.Join(args, " "), lastLines(string(b), 1, err))
				}
			}
			return nil
		case <-tick.C:
			p := Parse(out.String())
			p.Message = s.message
			p.NeedsInput = s.inputMarker != "" && strings.Contains(out.String(), s.inputMarker)
			if p.URL != "" && p != shown {
				shown = p
				show(p)
			}
			if p.NeedsInput && !asked {
				asked = true
				go func() {
					v, err := input(ctx)
					if err != nil {
						return // the context ends the command
					}
					_, _ = io.WriteString(stdin, strings.TrimSpace(v)+"\n")
				}()
			}
		}
	}
}

var (
	ansi    = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	urlRe   = regexp.MustCompile(`https://[^\s"'<>]+`)
	codeRe  = regexp.MustCompile(`\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b`)
	trailRe = regexp.MustCompile(`[.,;:)\]]+$`)
)

// Parse finds what a sign-in printed for a person: the first link it gave, and a one-time code like
// ABCD-1234 if there is one.
func Parse(out string) Prompt {
	out = ansi.ReplaceAllString(out, "")
	var p Prompt
	if m := urlRe.FindString(out); m != "" {
		p.URL = trailRe.ReplaceAllString(m, "")
	}
	// A code inside the link is the link's business, not one to type.
	rest := urlRe.ReplaceAllString(out, " ")
	if m := codeRe.FindString(rest); m != "" {
		p.Code = m
	}
	return p
}

func lastLines(out string, n int, err error) string {
	out = strings.TrimSpace(ansi.ReplaceAllString(out, ""))
	if out == "" {
		return err.Error()
	}
	lines := strings.Split(out, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}

// watched is a command's output, read while it runs.
type watched struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *watched) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.buf.Len() > 64<<10 {
		return len(p), nil
	}
	return w.buf.Write(p)
}

func (w *watched) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// ErrUnsupported is a tool this machine cannot install by itself.
var ErrUnsupported = errors.New("not on this operating system")
