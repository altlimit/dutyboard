package daemon

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/readiness"
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
		body, _ := json.Marshal(rep.Items)

		d.mu.Lock()
		r.running, r.at = false, time.Now()
		same := r.sent == string(body) && time.Since(r.sentAt) < readinessResend
		d.mu.Unlock()
		if same || ctx.Err() != nil {
			return
		}
		err := d.api.ReportReadiness(ctx, rep.Items, rep.CheckedAt)
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
