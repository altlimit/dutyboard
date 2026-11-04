package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// checkTimeout bounds a scheduled duty's check: it decides whether an agent is needed, it is not
// the work.
const checkTimeout = 10 * time.Minute

// checkOutput is as much of what a check printed as a session is shown — the end of it, where a
// script that fails says why.
const checkOutput = 8000

// check runs a scheduled duty's check before anything else is done for it. Exiting 0 and printing
// nothing means there is nothing to do: the duty is dropped and check answers true, and the run is
// over. Anything else is what the agent is woken with, kept on the run record so a retried or
// resumed session is shown it too.
func (d *Daemon) check(dctx, rctx context.Context, run *Run, v board.BoardView, duty *board.Duty) bool {
	stateDir := state.Path("checks", run.Board, duty.ScheduleID)
	if duty.ScheduleID == "" {
		stateDir = state.Path("checks", run.Board, run.DutyID)
	}
	_ = os.MkdirAll(stateDir, 0o755)
	dir := d.folder(run.Board)
	if dir == "" || v.Folder() {
		dir = stateDir
	}
	env := append(d.tools.SessionEnv(), "DUTYBOARD_STATE_DIR="+stateDir, "DUTYBOARD_BOARD="+run.Board, "DUTYBOARD_DUTY_ID="+run.DutyID)

	run.set("working", "running its check")
	d.report(dctx, run.Board)
	ctx, cancel := context.WithTimeout(rctx, checkTimeout)
	out, err := worktree.Shell(ctx, dir, duty.Check, env)
	cancel()
	if rctx.Err() != nil {
		return true // a person moved it, or the daemon is stopping: not this run's to carry on
	}
	out = strings.TrimSpace(out)

	var said string
	var exit *exec.ExitError
	switch {
	case err == nil && out == "" && len(duty.Notes) > 0:
		said = "Nothing (it exited 0 and printed nothing), but a person wrote on this duty, so it is worked anyway."
	case err == nil && out == "":
		qerr := d.api.Quiet(dctx, run.Board, run.DutyID, run.Agent)
		if qerr == nil {
			d.log.Printf("%s: %q — its check found nothing to do", run.Board, run.Title)
			return true
		}
		d.log.Printf("%s: dropping %q after a quiet check: %v", run.Board, run.Title, qerr)
		said = "Nothing (it exited 0 and printed nothing), but the board would not drop the duty (" + qerr.Error() + "). " +
			"Unless the board's notes ask for something, complete it saying the check found nothing to do."
	case err == nil:
		said = tail(out, checkOutput)
	case errors.As(err, &exit):
		said = fmt.Sprintf("It exited %d.", exit.ExitCode())
		if out != "" {
			said += "\n" + tail(out, checkOutput)
		}
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		said = fmt.Sprintf("It did not finish within %s.", checkTimeout)
	default:
		said = "It could not be run: " + err.Error()
	}
	d.log.Printf("%s: %q — its check woke an agent", run.Board, run.Title)
	records, _ := state.RunRecords()
	rec := records[run.DutyID]
	rec.Board, rec.Agent, rec.Check = run.Board, run.Agent, said
	_ = state.SaveRunRecord(run.DutyID, &rec)
	return false
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
