package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestMachineDefaultsFollowAvailabilityOrderAndFallback(t *testing.T) {
	d := choiceDaemon(t)
	a := board.AgentOption{Agent: "codex", Model: "machine-first", Effort: "high"}
	b := board.AgentOption{Agent: "codex", Model: "machine-second", Effort: "low"}
	v := board.BoardView{Runner: &board.Runner{UseMachineDefaults: true, Options: []board.AgentOption{b}}}
	ctx := context.Background()
	if _, _, err := d.chooseAgent(ctx, v, true); err == nil {
		t.Fatal("unconfigured machine inherited a legacy agent")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{a, b}
	if got, _, err := d.chooseAgent(ctx, v, true); err != nil || got != a {
		t.Fatalf("did not inherit machine order: %v %v", got, err)
	}
	d.markLimited(a, time.Now().Add(time.Hour))
	if got, _, err := d.chooseAgent(ctx, v, true); err != nil || got != b {
		t.Fatalf("inherited quota fallback failed: %v %v", got, err)
	}
	d.limits = map[string]time.Time{}
	d.me.Machine.AgentOptions = []board.AgentOption{b, a}
	if got, _, err := d.chooseAgent(ctx, v, true); err != nil || got != b {
		t.Fatal("machine reorder did not apply")
	}
	v.Runner.UseMachineDefaults = false
	v.Runner.Options = []board.AgentOption{a}
	if got, _, err := d.chooseAgent(ctx, v, true); err != nil || got != a {
		t.Fatal("board override did not take priority")
	}
	v.Runner.UseMachineDefaults = true
	d.me.Machine.AgentOptions = []board.AgentOption{}
	if _, _, err := d.chooseAgent(ctx, v, true); err == nil {
		t.Fatal("empty inherited list ran work")
	}
	// A different machine uses its own list, not a union of linked-machine choices.
	other := choiceDaemon(t)
	other.me.Machine.AgentOptions = []board.AgentOption{a}
	if got, _, err := other.chooseAgent(ctx, v, true); err != nil || got != a {
		t.Fatal("default leaked between machines")
	}
}

func TestDutyPriorityOverridesBoardWithoutChangingOtherSettings(t *testing.T) {
	d := choiceDaemon(t)
	ctx := context.Background()
	cheap := board.AgentOption{Agent: "codex", Model: "cheap", Effort: "low"}
	smart := board.AgentOption{Agent: "codex", Model: "smart", Effort: "high"}
	fallback := board.AgentOption{Agent: "codex", Model: "backup", Effort: "high"}
	d.me.Machine.AgentOptions = []board.AgentOption{cheap, fallback, smart}
	v := board.BoardView{Runner: &board.Runner{UseMachineDefaults: true, Options: []board.AgentOption{cheap}, PermissionMode: "acceptEdits", Parallel: 3, Instructions: "Keep these rules"}}
	override := withDutyOptions(v, []board.AgentOption{smart, fallback})
	if !v.Runner.UseMachineDefaults || v.Runner.Options[0] != cheap {
		t.Fatal("duty changed shared board policy")
	}
	if override.Runner.PermissionMode != v.Runner.PermissionMode || override.Runner.Parallel != 3 || override.Runner.Instructions != v.Runner.Instructions {
		t.Fatal("duty changed other runner settings")
	}
	if got, _, err := d.chooseAgent(ctx, override, true); err != nil || got != smart {
		t.Fatalf("duty priority not used: %v %v", got, err)
	}
	if got, _, err := d.chooseAgent(ctx, withDutyOptions(v, nil), true); err != nil || got != cheap {
		t.Fatalf("inheritance changed: %v %v", got, err)
	}
	until := time.Now().Add(time.Hour)
	d.markLimited(smart, until)
	if got, _, err := d.chooseAgent(ctx, override, true); err != nil || got != fallback {
		t.Fatalf("duty fallback ignored: %v %v", got, err)
	}
	d.markLimited(fallback, until)
	if _, wait, err := d.chooseAgent(ctx, override, true); err != nil || !wait.Equal(until) {
		t.Fatalf("exhausted override fell back to board: %v %v", wait, err)
	}
	if wait := quotaWait(override.Runner.AvailableChoices(d.me.Machine.AgentOptions), d.limits, time.Now()); !wait.Equal(until) {
		t.Fatal("override quota status hidden by ready board default")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{cheap}
	if _, _, err := d.chooseAgent(ctx, override, true); err == nil {
		t.Fatal("override bypassed machine availability")
	}
}

func TestBoardReadinessIncludesDutyOverrides(t *testing.T) {
	d := choiceDaemon(t)
	ctx := context.Background()
	cheap := board.AgentOption{Agent: "codex", Model: "cheap"}
	smart := board.AgentOption{Agent: "codex", Model: "smart"}
	v := board.BoardView{ProjectID: "board", Runner: &board.Runner{Options: []board.AgentOption{cheap}}}
	var poll board.PollBoard
	if err := json.Unmarshal([]byte(`{"project_id":"board","runnable":[{"duty_id":"smart-duty","agent_options":[{"agent":"codex","model":"smart"}]}]}`), &poll); err != nil {
		t.Fatal(err)
	}
	d.polled = map[string]board.PollBoard{"board": poll}
	d.views = map[string]board.BoardView{"board": v}
	d.me.Machine.AgentOptions = []board.AgentOption{smart}
	if got, _, err := d.chooseBoardAgent(ctx, v, false); err != nil || got != smart {
		t.Fatalf("unavailable board default blocked override: %v %v", got, err)
	}
	if d.dutyReady(ctx, "board", nil) {
		t.Fatal("default duty used another duty's override")
	}
	if !d.dutyReady(ctx, "board", []board.AgentOption{smart}) {
		t.Fatal("override not ready")
	}
	d.me.Machine.AgentOptions = []board.AgentOption{cheap, smart}
	d.markLimited(cheap, time.Now().Add(time.Hour))
	if got, _, err := d.chooseBoardAgent(ctx, v, true); err != nil || got != smart {
		t.Fatalf("limited board default blocked override: %v %v", got, err)
	}
	// Held duties also have to resume after a daemon restart, with their own priority.
	if err := json.Unmarshal([]byte(`{"project_id":"board","active":[{"duty_id":"smart-duty","mine":true,"agent_options":[{"agent":"codex","model":"smart"}]}],"runnable":[]}`), &poll); err != nil {
		t.Fatal(err)
	}
	d.polled["board"] = poll
	if got, _, err := d.chooseBoardAgent(ctx, v, true); err != nil || got != smart {
		t.Fatalf("held override not ready after restart: %v %v", got, err)
	}
}

type choiceTransport func(*http.Request) (*http.Response, error)

func (f choiceTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestClaimSkipsUnavailableAndLimitedDutyOverrides(t *testing.T) {
	d := choiceDaemon(t)
	var poll board.PollBoard
	if err := json.Unmarshal([]byte(`{"project_id":"board","runnable":[
 {"duty_id":"unavailable","agent_options":[{"agent":"codex","model":"unavailable"}]},
 {"duty_id":"limited","agent_options":[{"agent":"codex","model":"limited"}]},
 {"duty_id":"ready","agent_options":[{"agent":"codex","model":"smart"}]}
 ]}`), &poll); err != nil {
		t.Fatal(err)
	}
	d.me.Machine.AgentOptions = []board.AgentOption{{Agent: "codex", Model: "smart"}, {Agent: "codex", Model: "limited"}}
	d.views = map[string]board.BoardView{"board": {ProjectID: "board", Runner: &board.Runner{Options: []board.AgentOption{{Agent: "codex", Model: "unavailable"}}}}}
	d.markLimited(board.AgentOption{Agent: "codex", Model: "limited"}, time.Now().Add(time.Hour))
	var claims []string
	d.api = board.New("http://test", "")
	d.api.HTTP.Transport = choiceTransport(func(r *http.Request) (*http.Response, error) {
		var body struct {
			DutyID string `json:"duty_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if r.URL.Path != "/duty/claim" {
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
		claims = append(claims, body.DutyID)
		return &http.Response{StatusCode: 409, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"CONFLICT","message":"claimed by another"}}`)), Header: make(http.Header)}, nil
	})
	if d.startOne(context.Background(), poll, map[string]int{}, map[string]bool{}) {
		t.Fatal("started a refused claim")
	}
	if len(claims) != 1 || claims[0] != "ready" {
		t.Fatalf("claimed wrong duties: %v", claims)
	}
	if d.limitWakeAt.IsZero() {
		t.Fatal("did not schedule a quota wake")
	}
}
