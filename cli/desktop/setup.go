package main

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/altlimit/dutyboard/cli/desktop/host"
	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/app"
	"github.com/altlimit/dutyboard/cli/internal/daemon"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
)

func init() {
	application.RegisterEvent[SetupLine]("setup:line")
	application.RegisterEvent[SetupQuestion]("setup:question")
	application.RegisterEvent[SetupPairing]("setup:pairing")
}

// SetupLine is one line of what setting up is doing, as the terminal would print it.
type SetupLine struct {
	Kind string `json:"kind"` // step, say, note, ok, warn
	Text string `json:"text"`
}

// SetupQuestion is something setting up needs a person to decide before it goes on.
type SetupQuestion struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"` // ask, secret, confirm, choose
	Text    string   `json:"text"`
	Options []string `json:"options"`
	Default string   `json:"default"` // ask: the text; confirm: "yes" or "no"; choose: the option's index
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
	Hosted      string `json:"hosted"`   // altengine's own address, used when none is given
	Server      string `json:"server"`   // a DutyBoard already set up here and not yet paired with
	Console     string `json:"console"`  // and its console
	Projects    string `json:"projects"` // the folder this machine would keep its boards' repositories in
}

// Provisioned is a DutyBoard that now exists.
type Provisioned struct {
	Server  string `json:"server"`
	Console string `json:"console"`
	Version string `json:"version"`
}

// Setup is the first run: making a DutyBoard, and connecting this machine to one. It is the terminal
// checklist's own steps (cli/internal/app), with a window where the terminal was.
type Setup struct {
	h   *host.Host
	app *application.App

	mu      sync.Mutex
	seq     int
	waiting map[string]chan string
}

// Defaults is what the first screens start from.
func (s *Setup) Defaults() SetupDefaults {
	d := SetupDefaults{MachineName: app.DefaultMachineName(), Hosted: altengine.DefaultURL}
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

// Provision makes a DutyBoard on altengine, or brings one up to this version — the same run either
// way. What it does arrives as setup:line events and what it needs to know as setup:question events,
// answered with Answer. altengineURL is empty for altengine itself; an emulator's address is the
// other thing it can be. Cancelling the call stops it where it is, which is safe: every step can be
// run again.
func (s *Setup) Provision(ctx context.Context, altengineURL, key string) (*Provisioned, error) {
	u := ui.NewRemote(&window{s: s, ctx: ctx})
	res, err := app.Provision(ctx, u, app.Flags{Altengine: strings.TrimSpace(altengineURL), Key: strings.TrimSpace(key)})
	if err != nil {
		return nil, err
	}
	return &Provisioned{Server: res.APIURL, Console: res.ConsoleURL, Version: res.Version}, nil
}

// DeploymentStatus is the DutyBoard this machine works for, next to the one this app would deploy.
type DeploymentStatus struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"` // what is deployed
	Ours      string `json:"ours"`    // what this app deploys
	// CanUpgrade is the app carrying a later version AND this machine holding an altengine key to
	// deploy it with. A machine that only joined someone's DutyBoard has no such key, and upgrading
	// is not its job: it is told nothing rather than asked for one.
	CanUpgrade bool `json:"canUpgrade"`
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
		CanUpgrade: d.Behind && app.CanProvision(cfg.Altengine),
		AppIsOlder: d.Ahead,
	}
}

// Upgrade brings the DutyBoard this machine is paired with up to the version this app carries. It is
// Provision aimed at that deployment, so it reports and asks the same way; the machine keeps working
// while it runs.
func (s *Setup) Upgrade(ctx context.Context) (*Provisioned, error) {
	cfg, err := state.LoadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.Server == "" {
		return nil, errors.New("this machine is not connected to a DutyBoard")
	}
	u := ui.NewRemote(&window{s: s, ctx: ctx})
	res, err := app.Provision(ctx, u, app.UpgradeFlags(cfg, app.Flags{}))
	if err != nil {
		return nil, err
	}
	return &Provisioned{Server: res.APIURL, Console: res.ConsoleURL, Version: res.Version}, nil
}

// Join connects this machine to the DutyBoard at server, and starts it working. The code to approve
// arrives as a setup:pairing event, and the call returns — with the name of whoever approved it —
// once someone has. Cancelling the call gives up waiting. projects is the folder its boards'
// repositories will be kept in; empty leaves it as it is.
func (s *Setup) Join(ctx context.Context, server, name, projects string) (string, error) {
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
	paired, err := app.Pair(ctx, cfg, server, name, func(code, link string, minutes int) {
		s.app.Event.Emit("setup:pairing", SetupPairing{Code: code, Link: link, Minutes: minutes})
		if link != "" {
			_ = s.app.Browser.OpenURL(link)
		}
	})
	if errors.Is(err, app.ErrNotBoard) {
		// The terminal's wording ends in what the HTTP client made of the answer, which helps someone
		// reading a log and nobody reading a form.
		return "", errors.New("That address did not answer as a DutyBoard. Check it against the API address on the console's Machines page, and that this machine can reach it.")
	}
	if err != nil {
		return "", err
	}
	go s.h.Start()
	return paired.OwnerName, nil
}

// Answer gives a question its answer: the text for ask and secret, "yes" or "no" for confirm, the
// option's index for choose.
func (s *Setup) Answer(id, value string) {
	s.mu.Lock()
	ch := s.waiting[id]
	delete(s.waiting, id)
	s.mu.Unlock()
	if ch != nil {
		ch <- value
	}
}

// Open opens a page in the person's browser: the console, to sign up or to approve a machine.
func (s *Setup) Open(url string) error {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return errors.New("not a web address")
	}
	return s.app.Browser.OpenURL(url)
}

// window is ui.Remote on the app's window, for one run.
type window struct {
	s   *Setup
	ctx context.Context
}

func (w *window) Event(kind, text string) {
	w.s.app.Event.Emit("setup:line", SetupLine{Kind: kind, Text: text})
}

func (w *window) ask(q SetupQuestion) (string, error) {
	s := w.s
	ch := make(chan string, 1)
	s.mu.Lock()
	s.seq++
	q.ID = strconv.Itoa(s.seq)
	if s.waiting == nil {
		s.waiting = map[string]chan string{}
	}
	s.waiting[q.ID] = ch
	s.mu.Unlock()
	if q.Options == nil {
		q.Options = []string{}
	}
	s.app.Event.Emit("setup:question", q)
	select {
	case v := <-ch:
		return v, nil
	case <-w.ctx.Done():
		s.mu.Lock()
		delete(s.waiting, q.ID)
		s.mu.Unlock()
		return "", w.ctx.Err()
	}
}

func (w *window) Ask(question, def string) (string, error) {
	v, err := w.ask(SetupQuestion{Kind: "ask", Text: question, Default: def})
	if err == nil && strings.TrimSpace(v) == "" {
		v = def
	}
	return strings.TrimSpace(v), err
}

func (w *window) Secret(question string) (string, error) {
	v, err := w.ask(SetupQuestion{Kind: "secret", Text: question})
	return strings.TrimSpace(v), err
}

func (w *window) Confirm(question string, def bool) (bool, error) {
	d := "no"
	if def {
		d = "yes"
	}
	v, err := w.ask(SetupQuestion{Kind: "confirm", Text: question, Default: d})
	return v == "yes", err
}

func (w *window) Choose(question string, options []string, def int) (int, error) {
	v, err := w.ask(SetupQuestion{Kind: "choose", Text: question, Options: options, Default: strconv.Itoa(def)})
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 || n >= len(options) {
		return 0, errors.New("no option chosen")
	}
	return n, nil
}
