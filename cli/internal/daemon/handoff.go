package daemon

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// proposesTeam reports whether a duty of this kind hands in a team: one drafting it, or a retro
// proposing changes to its charters.
func proposesTeam(kind string) bool { return kind == "roster" || kind == "retro" }

// beforeHandoff is what the machine checks, and says, when a session passes its duty to another role.
// It answers a refusal for the session to act on, or "" with what the machine attests added to args.
//
// A builder handing work to a reviewer must hand over all of it, committed, and the project's tests
// must pass on it here, first: a reviewer is the expensive session, and waking one to find the
// suite red wastes it. The builder fixes what fails in the same session, which still has the context.
// When they pass, the reviewer is told so, with the commit, and need not run them again — landing runs
// them once more after the rebase.
//
// Whatever role is handing on, the board is told which model did the work, so the reviewer can be a
// different one, and whether the change touched one of the board's sensitive paths.
func (d *Daemon) beforeHandoff(ctx context.Context, run *Run, args map[string]any) string {
	team := run.Team()
	if team == nil {
		return ""
	}
	if c := run.Choice(); c.Agent != "" {
		args["worked_with"] = map[string]any{"agent": c.Agent, "model": c.Model}
	}
	if run.Files {
		return ""
	}
	h, err := d.wt.Handing(ctx, run.Spec)
	if err != nil {
		if ctx.Err() != nil {
			return "this session is being stopped: stop now"
		}
		d.log.Printf("%s: reading the worktree of %s for a handoff: %v", run.Board, run.DutyID, err)
		return ""
	}
	if matchesAny(team.Settings.SensitivePaths, h.Changed) {
		args["sensitive"] = true
	}
	to, _ := args["to_role"].(string)
	target, ok := team.Other(to)
	if !ok || !team.Role.Reviewed || !target.Reviews {
		return ""
	}
	if h.Dirty != "" {
		return "not handed on: the worktree has changes that are not committed, and the reviewer reviews what is committed. Commit what belongs to this duty (and discard what does not), then hand it on again:\n" + clip(h.Dirty, 1500)
	}
	command := ""
	if p := d.view(run.Board).Profile; p != nil {
		command = p.TestCommand
	}
	if command == "" {
		return ""
	}
	if failed := d.prepared(ctx, run); failed != "" {
		return "not handed on: the worktree's prep command failed, so the tests could not run. Get it ready, then hand it on again:\n\n" + failed
	}
	d.status(ctx, run, "running the tests before review")
	out, err := d.wt.Test(ctx, run.Spec, command)
	d.status(ctx, run, "")
	if ctx.Err() != nil {
		return "this session is being stopped: stop now"
	}
	if err != nil {
		return fmt.Sprintf("not handed on: the project's tests (`%s`) fail on what you committed, and %s reviews only work that passes them. Fix it, commit, and hand it on again. The end of the output:\n\n```\n%s\n```", command, target.Name, strings.TrimSpace(out))
	}
	args["checks"] = map[string]any{"passed": true, "command": command, "commit": h.Commit}
	return ""
}

// prepared runs the board's prep command in a worktree made without it (see routesOnly), when a
// session is about to rely on it: before testing or landing what was built there. It answers what
// failed, or "".
func (d *Daemon) prepared(ctx context.Context, run *Run) string {
	if run.Files || !run.Spec.PrepLater {
		return ""
	}
	spec := run.Spec
	spec.PrepLater = false
	_, _, err := d.wt.Ensure(ctx, spec)
	var prepErr *worktree.PrepError
	switch {
	case errors.As(err, &prepErr):
		return fmt.Sprintf("Command: %s\nError: %v\nOutput (tail):\n%s", prepErr.Command, prepErr.Err, prepErr.Output)
	case err != nil:
		return err.Error()
	}
	run.Spec = spec
	return ""
}

// matchesAny reports whether any changed file matches any of the patterns: paths relative to the
// repository, with `*` within one folder and `**` across any number. A pattern with no slash matches
// a file's name anywhere, as in a .gitignore.
func matchesAny(patterns, files []string) bool {
	for _, p := range patterns {
		re, err := globRegexp(p)
		if err != nil {
			continue
		}
		for _, f := range files {
			f = strings.TrimPrefix(path.Clean(strings.ReplaceAll(f, "\\", "/")), "./")
			if re.MatchString(f) || (!strings.Contains(p, "/") && re.MatchString(path.Base(f))) {
				return true
			}
		}
	}
	return false
}

func globRegexp(glob string) (*regexp.Regexp, error) {
	glob = strings.TrimPrefix(strings.TrimSpace(glob), "./")
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(glob); i++ {
		switch c := glob[i]; {
		case c == '*' && i+1 < len(glob) && glob[i+1] == '*':
			i++
			if i+1 < len(glob) && glob[i+1] == '/' {
				i++
				b.WriteString("(?:.*/)?") // `a/**/b` matches `a/b` too
			} else {
				b.WriteString(".*")
			}
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	// A folder names everything in it.
	b.WriteString("(?:/.*)?$")
	return regexp.Compile(b.String())
}

// status says what a session's run is doing, on the board too when this daemon is connected to one.
func (d *Daemon) status(ctx context.Context, run *Run, detail string) {
	run.set("working", detail)
	if d.api != nil {
		d.report(ctx, run.Board)
	}
}
