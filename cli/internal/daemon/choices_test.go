package daemon

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

func choiceDaemon(t *testing.T) *Daemon {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell CLI fixture")
	}
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DUTYBOARD_CODEX", bin)
	runner.ForgetChecks()
	t.Cleanup(runner.ForgetChecks)
	return &Daemon{me: &board.Me{}, log: log.New(io.Discard, "", 0)}
}

func TestPriorityAvailabilityAndCooldowns(t *testing.T) {
	d := choiceDaemon(t)
	a := board.AgentOption{Agent: "codex", Model: "first", Effort: "high"}
	b := board.AgentOption{Agent: "codex", Model: "second", Effort: "low"}
	c := board.AgentOption{Agent: "codex", Model: "first", Effort: "low"}
	v := board.BoardView{Runner: &board.Runner{Options: []board.AgentOption{a, c, b}}}
	ctx := context.Background()
	// Explicit board policies require an explicit machine allowlist.
	if _, _, err := d.chooseAgent(ctx, v, true); err == nil {
		t.Fatal("unconfigured machine ran explicit policy")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{b, a, c}
	got, wait, err := d.chooseAgent(ctx, v, true)
	if err != nil || !wait.IsZero() || got != a {
		t.Fatalf("board priority ignored: %v %v %v", got, wait, err)
	}
	reset := time.Now().Add(time.Hour)
	d.markLimited(a, reset)
	got, _, err = d.chooseAgent(ctx, v, true)
	if err != nil || got != b {
		t.Fatalf("did not skip exhausted model across efforts: %v %v", got, err)
	}
	// Another board using a different model is not stopped by this limit.
	other := board.BoardView{Runner: &board.Runner{Options: []board.AgentOption{b}}}
	if got, _, err = d.chooseAgent(ctx, other, true); err != nil || got != b {
		t.Fatal("unrelated model was blocked")
	}
	d.markLimited(b, reset.Add(time.Hour))
	got, wait, err = d.chooseAgent(ctx, v, true)
	if err != nil || got.Agent != "" || !wait.Equal(reset) {
		t.Fatalf("wrong earliest reset: %v %v %v", got, wait, err)
	}
	// Simulate a daemon restart; persisted limits prevent another immediate attempt.
	d.limits = nil
	_, wait, err = d.chooseAgent(ctx, v, true)
	if err != nil || !wait.Equal(reset) {
		t.Fatalf("lost limits on restart: %v %v", wait, err)
	}
	d.limits[limitKey(a)] = time.Now().Add(-time.Second)
	got, _, err = d.chooseAgent(ctx, v, true)
	if err != nil || got != a {
		t.Fatal("highest priority did not recover after reset")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{}
	if _, _, err := d.chooseAgent(ctx, v, true); err == nil {
		t.Fatal("explicitly disabled machine ran work")
	}
}

func TestLegacyChoiceAndDisabledAgent(t *testing.T) {
	d := choiceDaemon(t)
	v := board.BoardView{Runner: &board.Runner{Agent: "codex", Model: "old"}}
	got, _, err := d.chooseAgent(context.Background(), v, true)
	if err != nil || got.Model != "old" {
		t.Fatalf("legacy policy changed: %v %v", got, err)
	}
	d.me.Machine.AgentOptions = []board.AgentOption{}
	if _, _, err := d.chooseAgent(context.Background(), v, true); err == nil {
		t.Fatal("legacy board bypassed explicit disable")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{{Agent: "codex", Model: "old"}}
	t.Setenv("DUTYBOARD_CODEX", filepath.Join(t.TempDir(), "missing"))
	runner.ForgetChecks()
	if _, _, err := d.chooseAgent(context.Background(), v, true); err == nil {
		t.Fatal("missing CLI was available")
	}
}

func TestHandoffNeverResumesAnotherCombination(t *testing.T) {
	for _, session := range []string{"codex:thread", "cursor:chat", "claude-uuid"} {
		rec := state.RunRecord{Session: session, ExecutionAgent: "codex", ExecutionModel: "first", ExecutionEffort: "high", Attempts: 2, Check: "check result"}
		resume, changed := prepareChoice(&rec, board.AgentOption{Agent: "claude-code", Model: "next", Effort: "low"}, true)
		if resume || !changed || rec.Session == session {
			t.Fatalf("unsafe handoff: %#v", rec)
		}
		if rec.Attempts != 2 || rec.Check != "check result" {
			t.Fatal("handoff lost duty state")
		}
	}
	rec := state.RunRecord{Session: "codex:same", ExecutionAgent: "codex", ExecutionModel: "first", ExecutionEffort: "high"}
	resume, changed := prepareChoice(&rec, board.AgentOption{Agent: "codex", Model: "first", Effort: "high"}, true)
	if !resume || changed || rec.Session != "codex:same" {
		t.Fatal("same combination did not resume")
	}
	resume, changed = prepareChoice(&rec, board.AgentOption{Agent: "codex", Model: "second", Effort: "high"}, true)
	if resume || !changed {
		t.Fatal("changed model resumed native conversation")
	}
}

func TestExplicitQuotaRetryIsScopedDurableAndAppliedOnce(t *testing.T) {
	d := choiceDaemon(t)
	a := board.AgentOption{Agent: "codex", Model: "a"}
	b := board.AgentOption{Agent: "codex", Model: "b"}
	until := time.Now().Add(time.Hour)
	d.markLimited(a, until)
	d.markLimited(b, until)
	if err := d.applyQuotaRetries(nil); err != nil {
		t.Fatal(err)
	}
	if len(d.limits) != 2 {
		t.Fatal("an ordinary readiness check cleared cooldowns")
	}
	requests := map[string]board.QuotaRetry{"board-a": {ID: "request-1", Options: []board.AgentOption{a}}}
	if err := d.applyQuotaRetries(requests); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.limits[limitKey(a)]; ok {
		t.Fatal("requested model is still cooling")
	}
	if !d.limits[limitKey(b)].Equal(until) {
		t.Fatal("retry cleared an unrelated model")
	}
	// It still has no usage: cooling down again must survive replayed polls and restarts.
	d.markLimited(a, until)
	d.limits, d.quotaRetries = nil, nil
	if err := d.applyQuotaRetries(requests); err != nil {
		t.Fatal(err)
	}
	if !d.limits[limitKey(a)].Equal(until) {
		t.Fatal("same retry cleared a new cooldown after restart")
	}
	requests["board-a"] = board.QuotaRetry{ID: "request-2", Options: []board.AgentOption{}}
	if err := d.applyQuotaRetries(requests); err != nil {
		t.Fatal(err)
	}
	if len(d.limits) != 2 {
		t.Fatal("empty board policy reset all models")
	}
	requests["*"] = board.QuotaRetry{ID: "request-all", Options: nil}
	if err := d.applyQuotaRetries(requests); err != nil {
		t.Fatal(err)
	}
	if len(d.limits) != 0 {
		t.Fatal("machine owner retry did not clear all limits")
	}
	d.limits, d.quotaRetries = nil, nil
	d.loadLimitsLocked()
	if len(d.limits) != 0 {
		t.Fatal("cleared limits came back after restart")
	}
}
