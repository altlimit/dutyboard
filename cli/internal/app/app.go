// Package app is the program's front door: flags, the first-run menu, and which of its jobs to do.
package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/assets"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/provision"
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

	key, typed, err := altengineKey(u, client)
	if err != nil {
		return nil, err
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
	res, err := provision.Run(ctx, provision.Options{Client: client, Assets: bundle, UI: u, Instance: f.Instance, Origins: origins})
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
	// whatever set it — a CI job must never leave a credential file behind.
	if typed && u.Interactive {
		keep, err := u.Confirm("Keep the altengine key on this machine, for upgrades and project deploys?", true)
		if err != nil {
			return nil, err
		}
		if keep {
			if err := state.SetCredential(state.AltengineKey, key); err != nil {
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

// altengineKey finds the key: $ALTENGINE_KEY, then the stored one, then a person. The emulator
// takes anything, and `dev` is what it is usually given. `typed` says a person entered it.
func altengineKey(u *ui.UI, c *altengine.Client) (key string, typed bool, err error) {
	if k := os.Getenv("ALTENGINE_KEY"); k != "" {
		return k, false, nil
	}
	if c.Local() {
		return "dev", false, nil
	}
	if k, err := state.Credential(state.AltengineKey); err == nil && k != "" {
		return k, false, nil
	}
	u.Say("An altengine API key with control access to instances and functions")
	u.Say("(altengine console → Settings → API keys).")
	k, err := u.Secret("altengine API key")
	if err != nil {
		return "", false, err
	}
	if k == "" {
		return "", false, errors.New("no key given")
	}
	return k, true, nil
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
