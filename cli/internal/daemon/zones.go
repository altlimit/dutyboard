package daemon

// Keeping a board's recurring duties on the right hour.
//
// A schedule is written in local time — "9am every Monday" — but the board's function cannot
// convert a zone to an offset: it runs on a JavaScript runtime that, in the emulator, has no
// timezone support at all. So the board stores the offset as a number and trusts whoever can work
// it out to keep it honest. This machine can: Go carries the whole timezone database, and the
// daemon is already talking to every board it works.
//
// So once an hour, and at startup, each board is asked what zones its schedules keep time in and
// what it believes they are worth. Anything this machine disagrees with is corrected, and the
// board re-aims the schedule — which is what makes "9am" stay 9am through a clock change.
//
// Several machines on one board all do this, and that is fine: they agree, and a correction that
// changes nothing writes nothing.

import (
	"context"
	"time"
	// The timezone database, compiled in. Without it a machine with no zoneinfo files — a bare
	// container, most Windows installs — could not name an offset at all, and correcting a board
	// to the wrong hour is worse than leaving it alone.
	_ "time/tzdata"

	"github.com/altlimit/dutyboard/cli/internal/board"
)

// How often a board's zones are checked. A clock change is twice a year; an hour late to notice it
// is a schedule an hour out, once, on boards nobody has opened in a browser either.
const zoneCheckEvery = time.Hour

// syncZones corrects the timezone offsets of every linked board's recurring duties. Quiet: a board
// with no schedules answers an empty list, and nothing is written.
func (d *Daemon) syncZones(ctx context.Context, boards []board.PollBoard) {
	for _, b := range boards {
		d.mu.Lock()
		due := time.Since(d.zoneChecked[b.ProjectID]) >= zoneCheckEvery
		d.mu.Unlock()
		if !due {
			continue
		}
		if err := d.syncBoardZones(ctx, b.ProjectID); err != nil {
			// Worth a line and nothing more: the schedules still run, on the offset they have.
			d.log.Printf("%s: could not check the clocks its recurring duties keep (%v)", b.ProjectID, err)
		}
		d.mu.Lock()
		d.zoneChecked[b.ProjectID] = time.Now()
		d.mu.Unlock()
	}
}

func (d *Daemon) syncBoardZones(ctx context.Context, boardID string) error {
	asked, err := d.api.SyncSchedules(ctx, boardID, nil)
	if err != nil || len(asked.Zones) == 0 {
		return err
	}
	now := time.Now()
	wrong := map[string]int{}
	for _, z := range asked.Zones {
		offset, ok := offsetOf(z.TZ, now)
		if !ok {
			d.log.Printf("%s: a recurring duty keeps time in %q, which this machine's timezone database does not know", boardID, z.TZ)
			continue
		}
		if offset != z.OffsetMin {
			wrong[z.TZ] = offset
		}
	}
	if len(wrong) == 0 {
		return nil
	}
	told, err := d.api.SyncSchedules(ctx, boardID, wrong)
	if err != nil {
		return err
	}
	if told.Updated > 0 {
		for tz, offset := range wrong {
			d.log.Printf("%s: %s is now %s; its recurring duties keep the hour they were set for", boardID, tz, offsetText(offset))
		}
	}
	return nil
}

// offsetOf is what a zone is worth right now, in minutes from UTC.
func offsetOf(tz string, at time.Time) (int, bool) {
	if tz == "" || tz == "UTC" {
		return 0, true
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return 0, false
	}
	_, seconds := at.In(loc).Zone()
	return seconds / 60, true
}

func offsetText(minutes int) string {
	sign := "+"
	if minutes < 0 {
		sign, minutes = "-", -minutes
	}
	return "UTC" + sign + time.Date(0, 1, 1, minutes/60, minutes%60, 0, 0, time.UTC).Format("15:04")
}
