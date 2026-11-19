package daemon

// "Connect" from the console: Sign in with altengine for exactly the instances this machine's boards
// deploy to, and keep what it ends in as this machine's deploy key — so nobody makes a key, works out
// which grants it needs, or types it into a terminal.
//
// The console shows the consent link this reports. Opened in a browser on this machine, altengine's
// redirect reaches the listener here and that is the end of it. Opened anywhere else, the redirect
// to 127.0.0.1 goes nowhere, so the person pastes the address it ended on back into the console. The
// code in that address cannot be used without the PKCE verifier, which never leaves this process:
// the key itself never passes through the board.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/setup"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// DeployKeyTool is the readiness item, and the sign-in the console asks for, that is this machine's
// altengine deploy key.
const DeployKeyTool = "deploy_key"

// deployScopes is what deploying to these boards' targets takes: write on a static site, full on a
// functions instance, both on a target named without a kind. Sorted, without repeats.
func deployScopes(views []board.BoardView) (scopes, targets []string) {
	seen := map[string]bool{}
	add := func(list *[]string, s string) {
		if !seen[s] {
			seen[s] = true
			*list = append(*list, s)
		}
	}
	for _, v := range views {
		if !deploysToAltengine(v) {
			continue
		}
		for _, t := range v.Profile.Deploy.Targets() {
			if t.Instance == "" {
				continue
			}
			add(&targets, t.Describe())
			if t.Kind == "static" || t.Kind == "" {
				add(&scopes, "static:write:"+t.Instance)
			}
			if t.Kind == "functions" || t.Kind == "" {
				add(&scopes, "functions:full:"+t.Instance)
			}
		}
	}
	sort.Strings(scopes)
	sort.Strings(targets)
	return scopes, targets
}

// deployDeviceName is how the deploy key is told apart from the key this machine provisioned
// DutyBoard with. altengine replaces an app's key for the same person and device_name, so the two
// must not share one, or connecting deploys would revoke the key upgrades use.
func deployDeviceName() string {
	name := altengine.DeviceName() + " · deploys"
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

// connectAltengine signs in for this machine's deploy targets and keeps the key. show tells the
// console what to do; the person's pasted address arrives through awaitInput.
func (d *Daemon) connectAltengine(ctx context.Context, req board.Request, show func(setup.Prompt)) (string, error) {
	if !altengine.CanSignIn(d.opt.Config.Altengine) {
		return "", errors.New("this machine's altengine has no Sign in with altengine — set a deploy key with `dutyboard --deploy-key` on it")
	}
	// The targets as saved now — the person has likely just added one — not as of the last poll.
	if err := d.refresh(ctx); err != nil {
		d.log.Printf("reading the boards before connecting altengine: %v", err)
	}
	d.mu.Lock()
	views := make([]board.BoardView, 0, len(d.views))
	for _, v := range d.views {
		views = append(views, v)
	}
	d.mu.Unlock()
	scopes, targets := deployScopes(views)
	if len(scopes) == 0 {
		return "", errors.New("none of this machine's boards deploys to altengine yet — add a target in the board's settings, save, and connect again")
	}

	o := &altengine.OAuth{Scopes: scopes}
	t, err := o.SignInWith(ctx, deployDeviceName(), func(link string) error {
		show(setup.Prompt{
			URL: link,
			Message: fmt.Sprintf("Approve DutyBoard deploying to %s in altengine. If the page you end on will not load — "+
				"you opened it on a computer other than this machine — copy its address from the address bar and paste it here.",
				strings.Join(targets, ", ")),
			NeedsInput: true,
		})
		return nil
	}, func(ctx context.Context) (string, error) { return d.awaitInput(ctx, req.RequestID) })
	if err != nil {
		return "", err
	}
	if err := o.Check(ctx, t); err != nil {
		return "", err
	}
	if err := state.SetCredential(state.DeployKey, t.Key); err != nil {
		return "", fmt.Errorf("storing the deploy key: %w", err)
	}
	// Every answer about what the old key could reach is stale now.
	d.mu.Lock()
	d.access = map[string]accessCheck{}
	d.mu.Unlock()
	return fmt.Sprintf("connected to altengine (%s) — deploys to %s", t.OrgName, strings.Join(targets, ", ")), nil
}
