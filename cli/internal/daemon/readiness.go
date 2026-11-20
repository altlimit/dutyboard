package daemon

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/readiness"
	"github.com/altlimit/dutyboard/cli/internal/seal"
)

// How often the machine's checklist is made again when nothing asks for it sooner, and how often it is
// sent when it has not changed — so the console can tell a quiet machine from one that stopped.
const (
	readinessEvery  = 30 * time.Minute
	readinessResend = 6 * time.Hour
)

type readinessState struct {
	due      bool      // asked for: a retry from the console, a reload
	running  bool      // being made now
	at       time.Time // last made
	sent     string    // what was last sent
	sentAt   time.Time
	disabled bool // the DutyBoard is too old to take it
}

// checkReadiness makes the machine's checklist when it is due, in the background, and sends it when it
// changed. Started from every tick; most of them find it is not due.
func (d *Daemon) checkReadiness(ctx context.Context) {
	d.mu.Lock()
	r := &d.readiness
	if r.disabled || r.running || (!r.due && time.Since(r.at) < readinessEvery) || d.me == nil {
		d.mu.Unlock()
		return
	}
	r.running, r.due = true, false
	links := append([]board.BoardView(nil), d.me.Links...)
	enabled := slices.Clone(d.me.Machine.AgentOptions)
	d.mu.Unlock()

	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		rep := readiness.Check(ctx, links, enabled)
		rep.Items = fitForBoard(rep.Items)
		body, _ := json.Marshal(rep.Items)

		d.mu.Lock()
		r.running, r.at = false, time.Now()
		same := r.sent == string(body) && time.Since(r.sentAt) < readinessResend
		d.mu.Unlock()
		if same || ctx.Err() != nil {
			return
		}
		// The public half of this machine's sealing key goes with it: the console encrypts to it what
		// its owner types there, so a secret reaches this machine without the board being able to read it.
		sealKey, err := seal.PublicKey()
		if err != nil {
			d.log.Printf("this machine's sealing key: %v", err)
		}
		err = d.api.ReportReadiness(ctx, rep.Items, rep.CheckedAt, sealKey)
		d.mu.Lock()
		defer d.mu.Unlock()
		switch {
		case err == nil:
			r.sent, r.sentAt = string(body), time.Now()
		case board.IsStatus(err, 404):
			// A DutyBoard from before machines reported this: say so once, and try again when the
			// daemon next starts.
			r.disabled = true
			d.log.Printf("this DutyBoard is too old to show what this machine needs; upgrade it with `dutyboard --provision-only`")
		default:
			d.log.Printf("reporting what this machine needs: %v", err)
		}
	}()
}

// What the board keeps of one checklist item. It refuses a whole report with an item over these, and
// a path or an error message can run long on a real machine (a missing agent's full search path).
const (
	maxItemLabel  = 60
	maxItemDetail = 400
	maxItemFix    = 300
)

// fitForBoard shortens what is too long for the board to keep, on whole characters, rather than have
// the board refuse the machine's whole checklist for one long line.
func fitForBoard(items []readiness.Item) []readiness.Item {
	for i := range items {
		items[i].Label = shorten(items[i].Label, maxItemLabel)
		items[i].Detail = shorten(items[i].Detail, maxItemDetail)
		items[i].Fix = shorten(items[i].Fix, maxItemFix)
	}
	return items
}

func shorten(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
