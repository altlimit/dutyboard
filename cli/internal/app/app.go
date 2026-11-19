// Package app is the program's front door: flags, the first-run menu, and which of its jobs to do.
package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/assets"
	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/provision"
	"github.com/altlimit/dutyboard/cli/internal/service"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
)

// Version is set at release by -ldflags "-X github.com/altlimit/dutyboard/cli/internal/app.Version=…".
var Version = "dev"

// Flags are the few overrides the program takes. Everything else is decided in the console.
type Flags struct {
	ProvisionOnly bool
	Local         bool
	Altengine     string
	Source        string
	Instance      string
	Origins       string
	ShowVersion   bool
	Server        string
	Name          string
	Root          string
	NoService     bool
	Service       bool
	DeployKey     bool
	MCPSecrets    bool
	Stop          bool
	// Device signs in to altengine with a code entered on another device, instead of a browser here.
	Device bool
	// SignOut revokes the altengine key kept here, when it came from signing in, and forgets it.
	SignOut bool
	// Open shows a page in the person's browser — the desktop app's own way of doing it. Nil is the
	// system browser.
	Open func(string) error
	// Key is an altengine key a person gave in a window. There is no flag for it: on a command line
	// it would be in the shell's history and the process list.
	Key string
}

// Main runs the program and returns its exit code.
func Main(args []string) int {
	// `dutyboard mcp` is started by an agent, not a person: MCP over stdio, bridged to the daemon.
	if len(args) > 0 && args[0] == "mcp" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := localmcp.ServeStdio(ctx, os.Stdin, os.Stdout); err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}

	var f Flags
	fs := flag.NewFlagSet("dutyboard", flag.ContinueOnError)
	fs.BoolVar(&f.ProvisionOnly, "provision-only", false, "provision or upgrade DutyBoard on altengine, then exit")
	fs.BoolVar(&f.Local, "local", false, "provision the local altengine emulator (http://127.0.0.1:9191)")
	fs.StringVar(&f.Altengine, "altengine", "", "altengine API origin (default: $ALTENGINE_URL, else hosted)")
	fs.StringVar(&f.Source, "source", "", "deploy the function and console from this DutyBoard checkout")
	fs.StringVar(&f.Instance, "instance", "", "use, or create, the deployment on this functions instance without asking")
	fs.StringVar(&f.Origins, "origins", "", "extra console origins to allow, comma-separated (default: $DUTYBOARD_ORIGINS)")
	fs.BoolVar(&f.ShowVersion, "version", false, "print the version")
	fs.StringVar(&f.Server, "server", "", "the DutyBoard API URL to pair this machine with")
	fs.StringVar(&f.Name, "name", "", "this machine's name, when pairing")
	fs.StringVar(&f.Root, "root", "", "the folder setups requested from the console clone into (default ~/dutyboard)")
	fs.BoolVar(&f.NoService, "no-service", false, "do not offer to start dutyboard at login; run in this terminal")
	fs.BoolVar(&f.Service, "service", false, "set dutyboard to start by itself (at boot on a server) without asking, start it, and exit")
	fs.BoolVar(&f.DeployKey, "deploy-key", false, "set the altengine key this machine deploys projects with, then exit")
	fs.BoolVar(&f.MCPSecrets, "mcp-secrets", false, "set the secrets your boards' MCP servers need on this machine, then exit")
	fs.BoolVar(&f.Device, "device", false, "sign in to altengine with a code you enter on another device (no browser here)")
	fs.BoolVar(&f.SignOut, "sign-out", false, "sign this machine out of altengine: revoke and forget the key kept here")
	fs.BoolVar(&f.Stop, "stop", false, "stop the dutyboard running on this machine; the duties it holds resume when it starts again")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "dutyboard — runs your DutyBoard's work on this machine.")
		fmt.Fprintln(fs.Output(), "\nRun with no flags to connect this machine and start working. Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if f.ShowVersion {
		fmt.Println("dutyboard", Version)
		return 0
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	u := ui.New()

	var err error
	switch {
	case f.ProvisionOnly:
		_, err = Provision(ctx, u, f)
	case f.DeployKey:
		err = SetDeployKey(ctx, u, f)
	case f.MCPSecrets:
		err = SetMCPSecrets(ctx, u)
	case f.SignOut:
		if err = SignOutAltengine(ctx); err == nil {
			u.OK("signed out of altengine — no key is kept on this machine")
		}
	case f.Stop:
		err = stopRunning(u, true)
	default:
		err = Start(ctx, u, f)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return 130
		}
		fmt.Fprintf(os.Stderr, "\n✖ %v\n", err)
		return 1
	}
	return 0
}

// Provision provisions or upgrades a deployment and records it in config.json.
func Provision(ctx context.Context, u *ui.UI, f Flags) (*provision.Result, error) {
	base := f.Altengine
	if base == "" {
		base = os.Getenv("ALTENGINE_URL")
	}
	if f.Local && base == "" {
		base = "http://127.0.0.1:9191"
	}
	client := altengine.New(base, "")

	bundle, err := loadAssets(ctx, u, f.Source)
	if err != nil {
		return nil, err
	}
	u.Say("DutyBoard v%s  (%s)", bundle.Version, bundle.Source)

	key, typed, signedIn, stored := f.Key, f.Key != "", false, false
	if key == "" {
		if key, typed, signedIn, stored, err = altengineKey(ctx, u, client, f); err != nil {
			return nil, err
		}
	}
	client.Key = key

	extra := f.Origins
	if extra == "" {
		extra = os.Getenv("DUTYBOARD_ORIGINS")
	}
	var origins []string
	for _, o := range strings.Split(extra, ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins = append(origins, strings.TrimRight(o, "/"))
		}
	}
	opts := provision.Options{Client: client, Assets: bundle, UI: u, Instance: f.Instance, Origins: origins}
	if signedIn {
		opts.NamePrefix = altengine.NamePrefix
	}
	res, err := provision.Run(ctx, opts)
	if err != nil && stored && altengine.IsStatus(err, http.StatusUnauthorized) {
		// The key kept here was revoked: the person who signed in left the organization or reset their
		// password, or someone removed it in the altengine console. Keeping it would fail every upgrade
		// the same way, so it goes, and a person is asked again.
		if ferr := ForgetAltengineKey(); ferr != nil {
			u.Warn("could not remove the key kept on this machine: %v", ferr)
		}
		u.Warn("altengine no longer accepts the key kept on this machine — it was revoked")
		if !u.Interactive {
			return nil, errors.New("altengine revoked the key kept on this machine — sign in again")
		}
		return Provision(ctx, u, f)
	}
	if err != nil {
		return nil, err
	}

	cfg, err := state.LoadConfig()
	if err != nil {
		return nil, err
	}
	cfg.Server, cfg.Console, cfg.Altengine, cfg.Instances = res.APIURL, res.ConsoleURL, client.BaseURL, res.Names.Map()
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	// Only a key a person just typed is offered for keeping. One from the environment belongs to
	// whatever set it — a CI job must never leave a credential file behind. And not by default: this
	// key can manage the whole deployment, agents on this machine run as the same user, and all it
	// is needed for again is the next upgrade. Projects deploy with a key of their own.
	if typed && u.Interactive {
		u.Say("This key can manage your DutyBoard deployment. Agents on this machine run as you and could read a key kept here,")
		u.Say("so keep it only if this machine runs no agents. Projects deploy with a narrower key: `dutyboard --deploy-key`.")
		keep, err := u.Confirm("Keep this key on this machine for the next upgrade?", false)
		if err != nil {
			return nil, err
		}
		if keep {
			if err := rememberAltengineKey(key, false); err != nil {
				u.Warn("could not store the key: %v", err)
			}
		}
	}

	u.Step("Done")
	u.Say("API:      %s", res.APIURL)
	if res.ConsoleURL != "" {
		u.Say("Console:  %s", res.ConsoleURL)
	}
	return res, nil
}

// altengineKey finds the key: $ALTENGINE_KEY, then the stored one, then a person — who, on hosted
// altengine, can sign in instead of making and pasting a key. The emulator takes anything, and `dev`
// is what it is usually given. `typed` says a person pasted it; `signedIn` that it came from "Sign in
// with altengine", so it reaches only instances named `dutyboard…`; `stored` that it was kept here.
func altengineKey(ctx context.Context, u *ui.UI, c *altengine.Client, f Flags) (key string, typed, signedIn, stored bool, err error) {
	if k := os.Getenv("ALTENGINE_KEY"); k != "" {
		return k, false, false, false, nil
	}
	if c.Local() {
		return "dev", false, false, false, nil
	}
	if k, err := state.Credential(state.AltengineKey); err == nil && k != "" {
		cfg, _ := state.LoadConfig()
		return k, false, cfg != nil && cfg.AltengineSignedIn, true, nil
	}
	// Only with someone there to approve it: run from CI with no key, a sign-in would wait ten minutes
	// for nobody, where asking for the key fails at once and says what is missing.
	if altengine.CanSignIn(c.BaseURL) && u.Interactive {
		device := f.Device || browserless()
		label := "Sign in with altengine — opens your browser"
		if device {
			label = "Sign in with altengine — with a code you enter on any device"
		}
		pick, err := u.Choose("How should DutyBoard reach your altengine?", []string{label, "Paste an altengine API key"}, 0)
		if err != nil {
			return "", false, false, false, err
		}
		if pick == 0 {
			t, err := SignInAltengine(ctx, u, device, f.Open)
			switch {
			case err == nil:
				return t.Key, false, true, false, nil
			case errors.Is(err, altengine.ErrDeviceFlowUnavailable):
				u.Warn("%v", err)
				u.Say("Run this on a machine with a browser to sign in, or paste a key.")
			default:
				return "", false, false, false, err
			}
		}
	}
	u.Say("An altengine API key with control access to instances and functions")
	u.Say("(altengine console → Settings → API keys).")
	k, err := u.Secret("altengine API key")
	if err != nil {
		return "", false, false, false, err
	}
	if k == "" {
		return "", false, false, false, errors.New("no key given")
	}
	return k, true, false, false, nil
}

// loadAssets picks where the function and console come from: a checkout named on the command line,
// what this binary carries, a checkout this is being run inside, or the matching release.
func loadAssets(ctx context.Context, u *ui.UI, source string) (*assets.Bundle, error) {
	if source != "" {
		return assets.FromSource(source)
	}
	if b, ok := assets.Embedded(); ok {
		return b, nil
	}
	if wd, err := os.Getwd(); err == nil {
		if repo, ok := assets.FindSource(wd); ok {
			return assets.FromSource(repo)
		}
	}
	u.Say("this build carries no DutyBoard assets; downloading them from the release")
	return assets.Download(ctx, Version, state.Path("cache"))
}

// SetDeployKey stores the altengine key projects are deployed with, checks it against the instances
// the boards this machine works deploy to, and offers to drop the provisioning key if one is kept.
func SetDeployKey(ctx context.Context, u *ui.UI, f Flags) error {
	if !u.Interactive {
		return errors.New("--deploy-key asks for the key: run it in a terminal")
	}
	u.Say("The key the runner deploys projects with. Give it only what deploys need, on only the instances your boards")
	u.Say("deploy to: write on a static site, full on a functions instance. Nothing else — agents run as you.")
	u.Say("(altengine console → Settings → API keys.) Leave it empty to remove the one kept here.")
	key, err := u.Secret("altengine deploy key")
	if err != nil {
		return err
	}
	if key == "" {
		if err := state.DeleteCredential(state.DeployKey); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		u.OK("removed this machine's deploy key")
		return reloadDaemon(u)
	}

	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	base := f.Altengine
	if base == "" {
		base = cfg.Altengine
	}
	client := altengine.New(base, key)
	if cfg.Server != "" && !client.Local() {
		if mk, _ := state.Credential(state.MachineKey); mk != "" {
			api := board.New(cfg.Server, mk)
			api.Version = Version
			if boards, err := api.Boards(ctx); err == nil {
				for _, b := range boards {
					if !b.Linked || b.Profile == nil || b.Profile.Deploy.Method != "altengine" {
						continue
					}
					for _, t := range b.Profile.Deploy.Targets() {
						if err := client.CanDeploy(ctx, t.Kind, t.Instance); err != nil {
							u.Warn("%s: %v", b.ProjectID, err)
						} else {
							u.OK("%s: can deploy to %s", b.ProjectID, t.Describe())
						}
					}
				}
			}
		}
	}
	if err := state.SetCredential(state.DeployKey, key); err != nil {
		return fmt.Errorf("storing the deploy key: %w", err)
	}
	u.OK("stored this machine's deploy key")

	if k, _ := state.Credential(state.AltengineKey); k != "" && k != key {
		drop, err := u.Confirm("This machine also keeps the key DutyBoard was provisioned with, which can manage your whole deployment. Remove it?", true)
		if err != nil {
			return err
		}
		if drop {
			_ = state.DeleteCredential(state.AltengineKey)
			u.OK("removed the provisioning key; the next upgrade asks for it")
		}
	}
	return reloadDaemon(u)
}

// reloadDaemon has a running daemon pick up a changed key now rather than at its next check.
func reloadDaemon(u *ui.UI) error {
	if !localmcp.Running() {
		return nil
	}
	c, err := localmcp.Dial()
	if err != nil {
		return nil
	}
	defer c.Close()
	if err := c.Reload(); err == nil {
		u.OK("the running dutyboard has picked it up")
	}
	return nil
}

// SetMCPSecrets asks for each secret the MCP servers on this machine's boards name, and keeps the
// values here — in the OS keyring where there is one. They never go to the board: every member can
// read a board's profile.
func SetMCPSecrets(ctx context.Context, u *ui.UI) error {
	if !u.Interactive {
		return errors.New("--mcp-secrets asks for the values: run it in a terminal")
	}
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	mk, _ := state.Credential(state.MachineKey)
	if cfg.Server == "" || mk == "" {
		return errors.New("this machine is not paired with a DutyBoard yet — run `dutyboard` first")
	}
	linked := board.New(cfg.Server, mk)
	linked.Version = Version
	boards, err := linked.Boards(ctx)
	if err != nil {
		return err
	}
	// Every secret the boards name, so one already kept for a board can be offered to another
	// board's server of the same name.
	type secret struct {
		board, server, note, kind, name, key, have string
	}
	var all []*secret
	for _, b := range boards {
		if !b.Linked || b.Profile == nil {
			continue
		}
		for _, s := range b.Profile.MCPServers {
			kind := "environment variable"
			if s.URL != "" {
				kind = "header (the whole value, e.g. \"Bearer …\")"
			}
			for _, name := range s.Secrets {
				key := state.MCPSecret(b.ProjectID, s.Name, name)
				have, _ := state.Credential(key)
				all = append(all, &secret{board: b.ProjectID, server: s.Name, note: s.Note, kind: kind, name: name, key: key, have: have})
			}
		}
	}
	if len(all) == 0 {
		u.OK("no MCP server on the boards this machine works needs a secret")
		return nil
	}
	elsewhere := func(x *secret) *secret {
		for _, o := range all {
			if o != x && o.have != "" && o.server == x.server && o.name == x.name {
				return o
			}
		}
		return nil
	}
	shown := ""
	ask := func(x *secret, question string) (string, error) {
		if head := x.board + " — MCP server " + x.server; head != shown {
			shown = head
			u.Step("%s", head)
			if x.note != "" {
				u.Say("%s", x.note)
			}
		}
		return u.Secret(fmt.Sprintf("%s, %s (%s)", x.name, x.kind, question))
	}
	store := func(x *secret, val string) error {
		if err := state.SetCredential(x.key, val); err != nil {
			return fmt.Errorf("storing %s: %w", x.name, err)
		}
		x.have = val
		u.OK("stored %s for %s", x.name, x.board)
		return nil
	}

	// What is missing first: a secret already set is kept without asking, so running this again
	// after adding a server to one board asks only about that server.
	var kept []*secret
	for _, x := range all {
		if x.have != "" {
			kept = append(kept, x)
			continue
		}
		from := elsewhere(x)
		question := "not set — Enter skips it"
		if from != nil {
			question = "not set — Enter uses the one set for " + from.board + ", - skips it"
		}
		val, err := ask(x, question)
		if err != nil {
			return err
		}
		switch {
		case val != "" && val != "-":
			err = store(x, val)
		case val == "" && from != nil:
			err = store(x, from.have)
		}
		if err != nil {
			return err
		}
	}
	if len(kept) > 0 {
		names := make([]string, len(kept))
		for i, x := range kept {
			names[i] = x.board + "/" + x.server + " " + x.name
		}
		u.Say("Already set: %s.", strings.Join(names, ", "))
		change, err := u.Confirm("Change any of them?", false)
		if err != nil {
			return err
		}
		for _, x := range kept {
			if !change {
				break
			}
			val, err := ask(x, "set — Enter keeps it, - removes it")
			if err != nil {
				return err
			}
			switch {
			case val == "-":
				_ = state.DeleteCredential(x.key)
				u.OK("removed %s for %s", x.name, x.board)
			case val != "":
				if err := store(x, val); err != nil {
					return err
				}
			}
		}
	}
	return reloadDaemon(u)
}

// stopRunning stops the daemon running on this machine, if there is one. With say, it explains when
// and how it comes back.
func stopRunning(u *ui.UI, say bool) error {
	if !localmcp.Running() {
		if say {
			u.OK("dutyboard is not running on this machine")
		}
		return nil
	}
	c, err := localmcp.Dial()
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Stop(2 * time.Minute); err != nil {
		return err
	}
	if say {
		u.OK("stopped — the duties it held are resumed when it starts again")
		// What brings it back depends on what starts it, and only a crontab does so unasked.
		switch {
		case service.ByCron():
			u.Say("Started by itself from your crontab, it is back within 5 minutes; `dutyboard --service` starts it now.")
		case service.Installed():
			u.Say("It starts by itself again the next time you sign in; `dutyboard --service` starts it now.")
		default:
			u.Say("Nothing here starts it by itself; `dutyboard` starts it again.")
		}
	}
	return nil
}
