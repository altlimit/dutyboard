package app

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/assets"
	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/provision"
	"github.com/altlimit/dutyboard/cli/internal/readiness"
	"github.com/altlimit/dutyboard/cli/internal/service"
	"github.com/altlimit/dutyboard/cli/internal/setup"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
)

// The checklist is `dutyboard` run by a person: each step finds out whether it is already done, and
// asks only when it is not — so running it again on a machine that is set up asks nothing.
//
//  1. the DutyBoard this machine is paired with is there, and as new as this binary;
//  2. the machine is paired (pairMachine);
//  3. dutyboard starts by itself, and what is running is this binary;
//  4. what duties need from this machine — agents signed in, gh, a commit author — is printed;
//  5. the rest is in the console, which it opens on this machine's checklist.

// checkDeployment compares the DutyBoard this machine is paired with to the one this binary deploys,
// and offers to upgrade it. Reaching it is not required: a machine can still work while it is down.
func checkDeployment(ctx context.Context, u *ui.UI, cfg *state.Config, f Flags) error {
	health, err := provision.Health(ctx, cfg.Server)
	if err != nil {
		u.Warn("could not reach your DutyBoard at %s: %v", cfg.Server, err)
		return nil
	}
	if health.ConsoleURL != "" && health.ConsoleURL != cfg.Console {
		cfg.Console = health.ConsoleURL
		if err := cfg.Save(); err != nil {
			return err
		}
	}
	ours := bundleVersion(f.Source)
	switch {
	case ours == "" || health.Version == "":
		u.OK("DutyBoard v%s at %s", health.Version, cfg.Server)
	case versionLess(health.Version, ours):
		u.Say("Your DutyBoard is v%s; this dutyboard deploys v%s.", health.Version, ours)
		u.Say("Upgrading changes the board and the console for everyone on it. It needs an altengine API key.")
		yes, err := u.Confirm(fmt.Sprintf("Upgrade it to v%s now?", ours), true)
		if err != nil || !yes {
			if !yes {
				u.Note("left at v%s — `dutyboard --provision-only` upgrades it later", health.Version)
			}
			return err
		}
		up := f
		if up.Altengine == "" {
			up.Altengine = cfg.Altengine
		}
		if up.Instance == "" && cfg.Instances != nil {
			up.Instance = cfg.Instances["functions"] // the deployment this machine uses, without asking which
		}
		if _, err := Provision(ctx, u, up); err != nil {
			u.Warn("the upgrade did not finish: %v", err)
			u.Note("this machine carries on with the DutyBoard as it is; `dutyboard --provision-only` tries again")
			return nil
		}
		// Provision saved its own copy of the config.
		fresh, err := state.LoadConfig()
		if err != nil {
			return err
		}
		*cfg = *fresh
	case versionLess(ours, health.Version):
		u.Warn("your DutyBoard is v%s and this dutyboard is v%s — update it: alt update altlimit/dutyboard", health.Version, ours)
	default:
		u.OK("DutyBoard v%s, up to date", health.Version)
	}
	return nil
}

// bundleVersion is the DutyBoard this binary would deploy, found without downloading anything: a
// checkout named on the command line, the assets it carries, a checkout it is run in, else its own
// version — a release carries the assets of the same release. "" when it cannot say.
func bundleVersion(source string) string {
	if source != "" {
		if b, err := assets.FromSource(source); err == nil {
			return b.Version
		}
	}
	if b, ok := assets.Embedded(); ok && b.Version != "" {
		return b.Version
	}
	if wd, err := os.Getwd(); err == nil {
		if repo, ok := assets.FindSource(wd); ok {
			if b, err := assets.FromSource(repo); err == nil {
				return b.Version
			}
		}
	}
	if Version == "dev" {
		return ""
	}
	return strings.TrimPrefix(Version, "v")
}

// versionLess compares dotted versions numerically: 2.9.0 < 2.10.0. One that is not a version is never
// less than anything, so nothing is offered on a guess.
func versionLess(a, b string) bool {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return false
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// acceptRequests asks about setups the console asked for that this machine, set to ask first, is
// holding. Answers the ones a person agreed to; the ones refused are reported failed.
func acceptRequests(ctx context.Context, u *ui.UI, api *board.Client) ([]string, error) {
	me, err := api.Me(ctx)
	if err != nil || me.Machine.RemoteSetup != "ask" {
		return nil, nil
	}
	var accepted []string
	for _, r := range me.Requests {
		if r.Status != "pending" {
			continue
		}
		what := fmt.Sprintf("Work the board %s on this machine?", r.ProjectID)
		switch {
		case r.Kind == "create_repo" && r.Repo != nil:
			what = fmt.Sprintf("Make the repository %s on GitHub for the board %s, and work it on this machine?", r.Repo.Name, r.ProjectID)
		case r.Kind == "install_tool":
			what = fmt.Sprintf("Install %s on this machine?", setup.Label(r.Tool))
		case r.Kind == "sign_in":
			what = fmt.Sprintf("Sign in to %s on this machine? The link and code to use show in the console.", setup.Label(r.Tool))
		}
		u.Step("Asked for from the console")
		yes, err := u.Confirm(what, true)
		if err != nil {
			return accepted, err
		}
		if yes {
			accepted = append(accepted, r.RequestID)
			continue
		}
		if err := api.ReportRequest(ctx, r.RequestID, "failed", "refused on the machine"); err != nil {
			u.Warn("could not say so to the board: %v", err)
		} else {
			u.OK("refused")
		}
	}
	return accepted, nil
}

// ensureService makes sure dutyboard starts by itself and that what is running is this binary, and
// hands it the requests a person accepted. Answers false when this terminal should run it instead.
func ensureService(u *ui.UI, cfg *state.Config, accepted []string) (bool, error) {
	u.Step("Running on this machine")
	installed, running := service.Installed(), localmcp.Running()

	if running {
		c, err := localmcp.Dial()
		if err != nil {
			return false, err
		}
		theirs := c.Version()
		same := theirs == Version
		restart := !installed
		switch {
		case !installed:
			u.Say("dutyboard is running here, but is not set to start by itself.")
			yes, err := u.Confirm("Start dutyboard by itself — when you log in, or at boot on a server?", true)
			if err != nil {
				c.Close()
				return false, err
			}
			restart = yes
		case !same:
			if theirs == "" {
				theirs = "an older version"
			} else {
				theirs = "v" + strings.TrimPrefix(theirs, "v")
			}
			u.Say("The dutyboard running here is %s; this one is %s.", theirs, Version)
			yes, err := u.Confirm("Restart it on this one?", true)
			if err != nil {
				c.Close()
				return false, err
			}
			restart = yes
		}
		if !restart {
			defer c.Close()
			if err := c.Reload(); err == nil {
				u.OK("dutyboard %s is running, and has picked up any change", c.Version())
			}
			for _, id := range accepted {
				_ = c.Accept(id)
			}
			return true, nil
		}
		c.Close()
	} else if installed {
		u.Say("dutyboard is set to start by itself, and is not running; starting it.")
	} else {
		yes, err := u.Confirm("Start dutyboard by itself — when you log in, or at boot on a server?", true)
		if err != nil || !yes {
			return false, err
		}
	}

	if err := installService(u, cfg); err != nil {
		u.Warn("%v; running here instead", err)
		return false, nil
	}
	handOver(u, accepted)
	return true, nil
}

// handOver gives the requests a person accepted to the dutyboard just started, once it answers.
func handOver(u *ui.UI, accepted []string) {
	if len(accepted) == 0 {
		return
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		c, err := localmcp.Dial()
		if err != nil {
			continue
		}
		for _, id := range accepted {
			_ = c.Accept(id)
		}
		c.Close()
		return
	}
	u.Warn("the dutyboard just started did not answer; the setups you accepted wait until you run `dutyboard` again")
}

// showReadiness prints what duties need from this machine, and what to run for what is missing.
func showReadiness(ctx context.Context, u *ui.UI, api *board.Client) {
	me, err := api.Me(ctx)
	if err != nil {
		return
	}
	u.Step("What duties need from this machine")
	rep := readiness.Check(ctx, me.Links)
	for _, it := range rep.Items {
		if !it.Needed && len(me.Links) > 0 && it.State != readiness.OK {
			continue // nothing here needs it: not worth a warning
		}
		line := it.Label
		if it.Detail != "" {
			line += " — " + it.Detail
		}
		switch it.State {
		case readiness.OK:
			u.OK("%s", line)
		case readiness.Unknown:
			u.Say("? %s", line)
		default:
			u.Warn("%s", line)
			if it.Fix != "" {
				u.Note("    %s", it.Fix)
			}
		}
	}
	if len(me.Links) == 0 {
		u.Note("No board is on this machine yet. Each board chooses its agent; this machine needs that one signed in.")
	}
}

// handOff points the person at this machine in the console, where the rest of setting up is.
func handOff(u *ui.UI, cfg *state.Config) {
	if cfg.Console == "" {
		return
	}
	link := strings.TrimRight(cfg.Console, "/") + "/#/machines?setup=" + cfg.MachineID
	u.Step("Finish in your console")
	u.Say("%s", link)
	u.Note("Put boards on this machine there; it shows what this machine still needs, and can fix most of it.")
	openBrowser(link)
}
