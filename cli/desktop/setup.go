package main

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/altlimit/dutyboard/cli/desktop/host"
	"github.com/altlimit/dutyboard/cli/internal/app"
	"github.com/altlimit/dutyboard/cli/internal/daemon"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

func init() {
	application.RegisterEvent[SetupPairing]("setup:pairing")
}

// SetupPairing is the code a person approves in the console to let this machine in.
type SetupPairing struct {
	Code    string `json:"code"`
	Link    string `json:"link"` // the console page that approves it; "" when the board does not say
	Minutes int    `json:"minutes"`
}

// SetupDefaults is what the first screens start from.
type SetupDefaults struct {
	MachineName string `json:"machineName"`
	Server      string `json:"server"`   // a DutyBoard already set up here and not yet paired with
	Console     string `json:"console"`  // and its console
	Projects    string `json:"projects"` // the folder this machine would keep its boards' repositories in
	// Autostart is whether starting at sign-in is offered ticked. It is for an ordinary install; a home
	// somewhere else is somebody trying something, and should not be left starting by itself.
	Autostart bool `json:"autostart"`
}

// Setup is the first run: connecting this machine to a DutyBoard, and sending a person who has none
// to deploy their own. It is the terminal checklist's own steps (cli/internal/app), with a window
// where the terminal was.
type Setup struct {
	h       *host.Host
	app     *application.App
	machine *Machine
}

// Defaults is what the first screens start from.
func (s *Setup) Defaults() SetupDefaults {
	d := SetupDefaults{MachineName: app.DefaultMachineName(), Autostart: state.IsDefaultHome()}
	if cfg, err := state.LoadConfig(); err == nil {
		d.Server, d.Console, d.Projects = cfg.Server, cfg.Console, daemon.ProjectsRoot(cfg)
	}
	return d
}

// ChooseFolder asks the person for a folder, starting from one, and answers "" if they chose none.
func (s *Setup) ChooseFolder(from string) (string, error) {
	d := s.app.Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		SetTitle("Folder for this machine's projects")
	if from != "" {
		if _, err := os.Stat(from); err == nil {
			d.SetDirectory(from)
		}
	}
	path, err := d.PromptForSingleSelection()
	// Closing the dialog is an answer, not a failure — and Wails reports it as an error it keeps in an
	// internal package, so its wording is all there is to know it by.
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "cancel") {
		return "", nil
	}
	return path, err
}

// DeploymentStatus is the DutyBoard this machine works for, next to the one this app would deploy.
type DeploymentStatus struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"` // what is deployed
	Ours      string `json:"ours"`    // what this app deploys
	// Behind is the app carrying a later version than is deployed. Upgrading is done in a browser by
	// whoever deployed it, at UpgradeLink; this machine only says so.
	Behind      bool   `json:"behind"`
	UpgradeLink string `json:"upgradeLink"`
	// AppIsOlder is the other way round: the deployment is ahead, and it is this app that needs updating.
	AppIsOlder bool `json:"appIsOlder"`
}

// Deployment compares the DutyBoard this machine is paired with to the one this app carries.
func (s *Setup) Deployment(ctx context.Context) DeploymentStatus {
	cfg, err := state.LoadConfig()
	if err != nil || cfg.Server == "" {
		return DeploymentStatus{}
	}
	d, err := app.CheckDeployment(ctx, cfg, "")
	if err != nil {
		return DeploymentStatus{}
	}
	return DeploymentStatus{
		Reachable:  true,
		Version:    d.Version,
		Ours:       d.Ours,
		Behind:      d.Behind,
		UpgradeLink: app.DeployLink(d.App),
		AppIsOlder: d.Ahead,
	}
}

// OpenDeploy opens the page that deploys a new DutyBoard into the person's own altengine account. They
// sign in there, pick an organization and deploy it as themselves; nothing is kept on this machine.
func (s *Setup) OpenDeploy() error { return s.app.Browser.OpenURL(app.DeployLink("")) }

// Join connects this machine to a DutyBoard, and starts it working. address is the DutyBoard's API
// address or its console's. The code to approve arrives as a setup:pairing event, and the call
// returns — with the name of whoever approved it — once someone has. Cancelling the call gives up
// waiting. projects is the folder its boards' repositories will be kept in, empty to leave it as it
// is; autostart is whether the app should then start by itself at sign-in.
func (s *Setup) Join(ctx context.Context, address, name, projects string, autostart bool) (string, error) {
	cfg, err := state.LoadConfig()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(projects) != "" {
		// Checked before the code is asked for: a folder that cannot be used is a reason not to start.
		folder, err := host.Folder(projects)
		if err != nil {
			return "", err
		}
		cfg.ProjectsRoot = folder // saved by Pair, with the rest of what pairing learns
	}
	server, err := app.ResolveBoard(ctx, address)
	if errors.Is(err, app.ErrNotBoard) {
		// The terminal's wording ends in what the HTTP client made of the answer, which helps someone
		// reading a log and nobody reading a form.
		return "", errors.New("That address did not answer as a DutyBoard. Use your console's address, or the API address on its Machines page, and check that this machine can reach it.")
	}
	if err != nil {
		return "", err
	}
	paired, err := app.Pair(ctx, cfg, server, name, func(code, link string, minutes int) {
		s.app.Event.Emit("setup:pairing", SetupPairing{Code: code, Link: link, Minutes: minutes})
		if link != "" {
			_ = s.app.Browser.OpenURL(link)
		}
	})
	if err != nil {
		return "", err
	}
	if autostart {
		if err := s.machine.SetAutostart(true); err != nil {
			s.h.Note("could not set DutyBoard to start when you sign in: " + err.Error())
		}
	}
	go s.h.Start()
	return paired.OwnerName, nil
}

// Open opens a page in the person's browser: the console, to sign up or to approve a machine.
func (s *Setup) Open(url string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return errors.New("not a web address")
	}
	return s.app.Browser.OpenURL(url)
}
