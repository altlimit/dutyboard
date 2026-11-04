package runner

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Status is what this machine has of one agent: whether it is installed, and whether it is signed in.
// It is what the console's checklist for a machine shows, and what Check turns into an error.
type Status struct {
	Agent     string `json:"agent"`
	Label     string `json:"label"`
	Installed bool   `json:"installed"`
	// SignedIn is nil when the agent could not say: an older CLI with no status command. That is not
	// held against it — the first session finds out.
	SignedIn *bool `json:"signed_in,omitempty"`
	// Detail says what is wrong, for a person; Fix is the command that puts it right on this machine.
	Detail string `json:"detail,omitempty"`
	Fix    string `json:"fix,omitempty"`
}

// Ready is installed and not known to be signed out.
func (s Status) Ready() bool { return s.Installed && (s.SignedIn == nil || *s.SignedIn) }

// Err is nil for a ready agent, and otherwise says what is wrong and how to fix it.
func (s Status) Err() error {
	if s.Ready() {
		return nil
	}
	return errors.New(s.Detail)
}

func yes() *bool { t := true; return &t }
func no() *bool  { f := false; return &f }

// statusCache remembers a sign-in check for a few minutes: a daemon checks every board on every tick,
// and asking an agent's CLI takes a second or more.
type statusCache struct {
	mu sync.Mutex
	at time.Time
	s  Status
}

const statusTTL = 5 * time.Minute

// get answers the remembered status, or checks again. Only an installed agent's answer is kept: one
// that is not installed costs nothing to look for again, and is seen the moment it is installed.
func (c *statusCache) get(ctx context.Context, check func(context.Context) Status) Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < statusTTL {
		return c.s
	}
	s := check(ctx)
	if s.Installed {
		c.s, c.at = s, time.Now()
	}
	return s
}

func (c *statusCache) forget() {
	c.mu.Lock()
	c.at = time.Time{}
	c.mu.Unlock()
}

var (
	claudeStatus statusCache
	codexStatus  statusCache
	cursorStatus statusCache
)

// ForgetChecks drops remembered answers about the agents on this machine, so the next check asks again.
func ForgetChecks() {
	claudeStatus.forget()
	codexStatus.forget()
	cursorStatus.forget()
}

// All is the status of every agent this build can run, in a stable order.
func All(ctx context.Context) []Status {
	out := make([]Status, 0, len(agents))
	for _, n := range Names() {
		out = append(out, agents[n].Status(ctx))
	}
	return out
}
