package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/live"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// fakeNotesBoard answers /duty/notes with the notes it is given, once each, as the board does, and
// /mcp with a reply carrying one line of text.
type fakeNotesBoard struct {
	mu      sync.Mutex
	pending []board.Note
	status  int // answered instead, when set
	asked   int
}

func (f *fakeNotesBoard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case "/duty/notes":
		f.asked++
		if f.status != 0 {
			w.WriteHeader(f.status)
			_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"not held"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"notes": f.pending})
		f.pending = nil
	case "/mcp":
		var msg rpc
		_ = json.NewDecoder(r.Body).Decode(&msg)
		_, _ = w.Write(toolText(msg.ID, "ok", false))
	default:
		http.NotFound(w, r)
	}
}

func notesDaemon(t *testing.T, f *fakeNotesBoard, liveUpdates bool) (*Daemon, *Run) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	run := &Run{Board: "b", DutyID: "duty_1", Agent: "m/1", Kind: "work", Token: "tok"}
	d := &Daemon{
		api:    board.New(srv.URL, "key"),
		me:     &board.Me{Live: liveUpdates},
		opt:    Options{Config: &state.Config{MachineID: "m"}},
		runs:   map[string]*Run{run.DutyID: run},
		tokens: map[string]*Run{run.Token: run},
	}
	return d, run
}

func TestNoteWrittenWhileWorkingReachesTheSession(t *testing.T) {
	f := &fakeNotesBoard{}
	d, run := notesDaemon(t, f, true)
	ctx := context.Background()

	if got := d.Notes(ctx, "tok"); got != "" || f.asked != 0 {
		t.Fatalf("with live updates and no note written, the board is not asked: %q, asked %d", got, f.asked)
	}

	f.pending = []board.Note{{From: "Sam", Message: "Also include the customer email.\nAnd a header row."}}
	d.onEvent(live.Event{Channel: "board.b", Data: map[string]any{"t": "thread", "id": "duty_1", "status": "active", "pn": float64(1)}})
	if run.byBoard.Load() {
		t.Fatal("a note does not stop the session")
	}
	got := d.Notes(ctx, "tok")
	for _, want := range []string{"A person wrote on this duty", "- Sam: Also include the customer email.\n  And a header row.", "Take it into account"} {
		if !strings.Contains(got, want) {
			t.Fatalf("notes text missing %q:\n%s", want, got)
		}
	}
	if again := d.Notes(ctx, "tok"); again != "" || f.asked != 1 {
		t.Fatalf("shown once: %q, asked %d", again, f.asked)
	}
	if d.Notes(ctx, "someone else's token") != "" {
		t.Fatal("a token the daemon did not give out hears nothing")
	}
}

func TestNotesRideOnTheNextBoardToolReply(t *testing.T) {
	f := &fakeNotesBoard{pending: []board.Note{{From: "Sam", Message: "Use the v2 endpoint."}}}
	d, run := notesDaemon(t, f, true)
	ctx := context.Background()
	call := func(tool string) []string {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": map[string]any{"duty_id": "duty_1"}}})
		reply, err := d.MCP(ctx, "tok", "", raw)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Result struct {
				Content []struct{ Text string } `json:"content"`
			} `json:"result"`
		}
		if err := json.Unmarshal(reply, &out); err != nil {
			t.Fatal(err)
		}
		var texts []string
		for _, c := range out.Result.Content {
			texts = append(texts, c.Text)
		}
		return texts
	}

	run.notesWaiting.Store(true)
	if got := call("duty_complete"); len(got) != 1 || f.asked != 0 {
		t.Fatalf("finishing is the board's to check, which refuses with the notes itself: %q, asked %d", got, f.asked)
	}
	got := call("duty_get")
	if len(got) != 2 || got[0] != "ok" || !strings.Contains(got[1], "- Sam: Use the v2 endpoint.") {
		t.Fatalf("the reply carries the note after the tool's own answer: %q", got)
	}
	if got := call("duty_get"); len(got) != 1 {
		t.Fatalf("and only once: %q", got)
	}
}

func TestNotesWhenTheBoardCannotSay(t *testing.T) {
	ctx := context.Background()

	// Not held any more: nobody left to tell, so the run stops asking.
	f := &fakeNotesBoard{status: http.StatusConflict}
	d, run := notesDaemon(t, f, true)
	run.notesWaiting.Store(true)
	if d.Notes(ctx, "tok") != "" || run.notesWaiting.Load() {
		t.Fatal("a duty no longer held is not asked about again")
	}

	// Down: still waiting, but not asked again at every step.
	f = &fakeNotesBoard{status: http.StatusBadGateway}
	d, run = notesDaemon(t, f, true)
	run.notesWaiting.Store(true)
	d.Notes(ctx, "tok")
	d.Notes(ctx, "tok")
	if !run.notesWaiting.Load() || f.asked != 1 {
		t.Fatalf("a board that could not answer is asked again later: waiting %v, asked %d", run.notesWaiting.Load(), f.asked)
	}

	// No live updates: nothing says a note was written, so the board is asked now and then.
	f = &fakeNotesBoard{pending: []board.Note{{From: "Sam", Message: "Smaller font."}}}
	d, _ = notesDaemon(t, f, false)
	if got := d.Notes(ctx, "tok"); !strings.Contains(got, "Smaller font.") {
		t.Fatalf("without live updates the first step asks: %q", got)
	}
	d.Notes(ctx, "tok")
	if f.asked != 1 {
		t.Fatalf("and then not at every step: asked %d", f.asked)
	}

	// A session being stopped hears nothing more.
	f = &fakeNotesBoard{pending: []board.Note{{From: "Sam", Message: "x"}}}
	d, run = notesDaemon(t, f, true)
	run.notesWaiting.Store(true)
	run.cancel = func() {}
	run.cancelByBoard()
	if d.Notes(ctx, "tok") != "" || f.asked != 0 {
		t.Fatal("a stopped session is not told")
	}
}
