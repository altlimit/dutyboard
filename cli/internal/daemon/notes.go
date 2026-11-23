package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
)

// A person who writes "also do X" on a duty while a session works it should change the work in
// progress, not watch it finish without X. The board tells the machine holding the duty (a `pn` on
// its live event), the run marks it, and the session is shown the note at its next step: an agent
// with hooks after any tool it uses (`dutyboard hook`, through Notes), and any agent in the reply to
// the next board tool it calls. The board refusing to finish over unseen notes stays as the last
// net, for a note written after the last step.

const (
	// notesNoLiveEvery is how often a session on a DutyBoard without live updates has the board asked,
	// since nothing will say a note was written.
	notesNoLiveEvery = time.Minute
	// notesRetryAfter is how long a board that could not answer is left before it is asked again, so a
	// board that is down does not slow every step of the session.
	notesRetryAfter = 30 * time.Second
)

// finishing are the tools that end a session's hold on its duty. The board checks for notes in them
// itself, and refuses with the notes if there are any.
var finishing = map[string]bool{"duty_complete": true, "duty_fail": true, "duty_handoff": true}

// Notes is `dutyboard hook`'s question: what a person has written on the duty of the session holding
// runToken since that session was last shown it. "" when nothing, or when anything goes wrong — a
// hook never gets in a session's way.
func (d *Daemon) Notes(ctx context.Context, runToken string) string {
	d.mu.Lock()
	run := d.tokens[runToken]
	d.mu.Unlock()
	return d.takeNotes(ctx, run)
}

// takeNotes asks the board for the run's new notes when one is known to be waiting (or, without live
// updates, now and then), and answers them as the session is to read them. The board counts them as
// shown once it answers them.
func (d *Daemon) takeNotes(ctx context.Context, run *Run) string {
	if run == nil || run.byBoard.Load() || d.api == nil {
		return ""
	}
	now := time.Now()
	run.mu.Lock()
	retrying := !run.notesFailed.IsZero() && now.Sub(run.notesFailed) < notesRetryAfter
	stale := now.Sub(run.notesAsked) >= notesNoLiveEvery
	run.mu.Unlock()
	if retrying {
		return ""
	}
	if !run.notesWaiting.Swap(false) {
		d.mu.Lock()
		live := d.me != nil && d.me.Live
		d.mu.Unlock()
		if live || !stale {
			return ""
		}
	}
	run.mu.Lock()
	run.notesAsked = now
	run.mu.Unlock()

	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	notes, err := d.api.NewNotes(cctx, run.Board, run.DutyID, run.Agent)
	run.mu.Lock()
	run.notesFailed = time.Time{}
	if err != nil && !board.IsStatus(err, 409) && !board.IsStatus(err, 404) {
		// Not answered, so still waiting. A duty no longer held (409) has nobody left to tell.
		run.notesFailed = now
		run.notesWaiting.Store(true)
	}
	run.mu.Unlock()
	if err != nil {
		return ""
	}
	return notesText(notes)
}

// notesText is new notes as the session reads them.
func notesText(notes []board.Note) string {
	if len(notes) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("A person wrote on this duty while you are working on it:\n")
	for _, n := range notes {
		from := n.From
		if from == "" {
			from = "A person"
		}
		b.WriteString("- " + from + ": " + strings.ReplaceAll(strings.TrimSpace(n.Message), "\n", "\n  ") + "\n")
	}
	b.WriteString("Take it into account from here on. It is part of the brief, and where it disagrees with the brief, the note wins. " +
		"Carry on with the work you have done rather than starting over, unless the note asks for that.")
	return b.String()
}

// withNotes adds the run's new notes, if any, to a tool's reply. A reply that carries no content (an
// error from the board, say) is passed on as it is and the notes wait for the next one.
func (d *Daemon) withNotes(ctx context.Context, run *Run, tool string, reply json.RawMessage) json.RawMessage {
	if run == nil || finishing[tool] || len(reply) == 0 {
		return reply
	}
	var msg map[string]json.RawMessage
	if json.Unmarshal(reply, &msg) != nil || len(msg["result"]) == 0 {
		return reply
	}
	var result map[string]any
	if json.Unmarshal(msg["result"], &result) != nil {
		return reply
	}
	content, ok := result["content"].([]any)
	if !ok {
		return reply
	}
	text := d.takeNotes(ctx, run)
	if text == "" {
		return reply
	}
	result["content"] = append(content, map[string]any{"type": "text", "text": text})
	b, err := json.Marshal(result)
	if err != nil {
		return reply
	}
	msg["result"] = b
	out, err := json.Marshal(msg)
	if err != nil {
		return reply
	}
	return out
}
