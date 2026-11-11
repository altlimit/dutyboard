package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// Limits are shared by all boards using this agent/model on this machine. Effort
// does not buy a fresh model quota. Keep them across daemon restarts as well.
func limitKey(o board.AgentOption) string { return o.Agent + ":" + o.Model }
func (d *Daemon) loadLimitsLocked() {
	if d.limits != nil {
		return
	}
	d.limits = map[string]time.Time{}
	b, err := os.ReadFile(state.Path("limits.json"))
	if err == nil {
		_ = json.Unmarshal(b, &d.limits)
	}
	if d.limits == nil {
		d.limits = map[string]time.Time{}
	}
}
func (d *Daemon) markLimited(o board.AgentOption, until time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.loadLimitsLocked()
	key := limitKey(o)
	if until.After(d.limits[key]) {
		d.limits[key] = until
	}
	for k, t := range d.limits {
		if !t.After(time.Now()) {
			delete(d.limits, k)
		}
	}
	if err := state.WriteJSON(state.Path("limits.json"), d.limits, 0600); err != nil {
		d.log.Printf("saving model cooldowns: %v", err)
	}
}

// chooseAgent intersects the board's priority list with the machine owner's
// enabled combinations, checking installed/authenticated CLIs. A zero choice and
// nonzero wait means every usable option is cooling down; error means none exists.
func (d *Daemon) chooseAgent(ctx context.Context, v board.BoardView, respectLimits bool) (board.AgentOption, time.Time, error) {
	d.mu.Lock()
	var enabled []board.AgentOption
	if d.me != nil {
		enabled = d.me.Machine.AgentOptions
	}
	d.loadLimitsLocked()
	limits := make(map[string]time.Time, len(d.limits))
	for k, t := range d.limits {
		limits[k] = t
	}
	d.mu.Unlock()
	var wait time.Time
	var problems []string
	explicit := v.Runner != nil && v.Runner.Options != nil
	for _, option := range v.Runner.Choices() {
		allowed := enabled == nil && !explicit // preserve legacy single-agent boards
		for _, e := range enabled {
			if e == option {
				allowed = true
				break
			}
		}
		if !allowed {
			continue
		}
		agent, err := runner.For(option.Agent)
		if err == nil {
			err = agent.Check(ctx)
		}
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		selected := withChoice(v, option)
		if selected.Service() {
			if _, missing := d.boardMCPServers(selected); len(missing) > 0 {
				problems = append(problems, strings.Join(missing, "; "))
				continue
			}
		}
		until := limits[limitKey(option)]
		if respectLimits && time.Now().Before(until) {
			if wait.IsZero() || until.Before(wait) {
				wait = until
			}
			continue
		}
		return option, time.Time{}, nil
	}
	if !wait.IsZero() {
		return board.AgentOption{}, wait, nil
	}
	if len(problems) > 0 {
		return board.AgentOption{}, time.Time{}, fmt.Errorf("%s", strings.Join(problems, "; "))
	}
	return board.AgentOption{}, time.Time{}, fmt.Errorf("no enabled agent/model/effort combination matches this board — enable combinations on Machines and select them in board settings")
}

func withChoice(v board.BoardView, option board.AgentOption) board.BoardView {
	r := board.Runner{}
	if v.Runner != nil {
		r = *v.Runner
	}
	r.Agent, r.Model, r.Effort = option.Agent, option.Model, option.Effort
	v.Runner = &r
	return v
}

// prepareChoice prevents native sessions from leaking between agents or models.
// The on-disk work and DutyBoard thread remain available to the next session.
func prepareChoice(rec *state.RunRecord, choice board.AgentOption, resume bool) (bool, bool) {
	previous := rec.ExecutionAgent
	if previous == "" && rec.Session != "" {
		previous = "claude-code"
		if strings.HasPrefix(rec.Session, "codex:") {
			previous = "codex"
		}
		if strings.HasPrefix(rec.Session, "cursor:") {
			previous = "cursor"
		}
	}
	changed := previous != "" && (previous != choice.Agent || (rec.ExecutionAgent != "" && (rec.ExecutionModel != choice.Model || rec.ExecutionEffort != choice.Effort)))
	if changed {
		rec.Session = newSessionID()
		resume = false
	}
	rec.ExecutionAgent, rec.ExecutionModel, rec.ExecutionEffort = choice.Agent, choice.Model, choice.Effort
	return resume, changed
}

// Schedule one wake for the earliest known quota reset, including after restart.
func (d *Daemon) wakeAt(until time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.limitWakeAt.After(time.Now()) && !until.Before(d.limitWakeAt) {
		return
	}
	d.limitWakeAt = until
	time.AfterFunc(time.Until(until), d.wake)
}

// Apply each explicit retry once, including after a missed live event or restart.
// Clearing cooldowns never changes claims, native sessions or the files left by a duty.
func (d *Daemon) applyQuotaRetries(requests map[string]board.QuotaRetry) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(requests) == 0 {
		return nil
	}
	d.loadLimitsLocked()
	if d.quotaRetries == nil {
		d.quotaRetries = map[string]string{}
		b, err := os.ReadFile(state.Path("quota-retries.json"))
		if err == nil {
			_ = json.Unmarshal(b, &d.quotaRetries)
		}
		if d.quotaRetries == nil {
			d.quotaRetries = map[string]string{}
		}
	}
	next := make(map[string]string, len(requests))
	changed := false
	limits := make(map[string]time.Time, len(d.limits))
	for key, until := range d.limits {
		limits[key] = until
	}
	for scope, req := range requests {
		next[scope] = req.ID
		if req.ID == "" || d.quotaRetries[scope] == req.ID {
			continue
		}
		changed = true
		if req.Options == nil {
			limits = map[string]time.Time{}
		} else {
			for _, option := range req.Options {
				delete(limits, limitKey(option))
			}
		}
	}
	if !changed {
		return nil
	}
	if err := state.WriteJSON(state.Path("limits.json"), limits, 0600); err != nil {
		return err
	}
	if err := state.WriteJSON(state.Path("quota-retries.json"), next, 0600); err != nil {
		return err
	}
	d.limits, d.quotaRetries = limits, next
	d.limitWakeAt = time.Time{}
	d.readiness.due = true
	runner.ForgetChecks()
	d.log.Printf("cleared requested usage cooldowns; retrying available agents")
	return nil
}
