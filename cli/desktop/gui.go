package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/altlimit/dutyboard/cli/desktop/host"
	"github.com/altlimit/dutyboard/cli/internal/app"
	"github.com/altlimit/dutyboard/cli/internal/service"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

//go:embed all:frontend/dist
var dist embed.FS

// The site's mark (site/src/favicon.svg), drawn once to these files: the app's icon, and the tray's
// in the favicon's two colour schemes.
var (
	//go:embed build/appicon.png
	appIcon []byte
	//go:embed icons/tray-light.png
	trayLight []byte
	//go:embed icons/tray-dark.png
	trayDark []byte
)

func init() {
	application.RegisterEvent[host.Snapshot]("machine:status")
	application.RegisterEvent[string]("machine:log")
}

// Machine is what the window can ask of this machine.
type Machine struct {
	h   *host.Host
	app *application.App
}

// Status is the machine now.
func (m *Machine) Status() host.Snapshot { return m.h.Snapshot() }

// Logs are the daemon's recent lines, oldest first.
func (m *Machine) Logs() []string { return m.h.Logs() }

// Pause stops the daemon; the duties it holds are resumed by Resume.
func (m *Machine) Pause() { m.h.Pause() }

// Resume starts the daemon again.
func (m *Machine) Resume() { m.h.Start() }

// SetProjects changes the folder this machine keeps its boards' repositories in.
func (m *Machine) SetProjects(path string) error { return m.h.SetProjects(path) }

// autostartID names this home's sign-in entry. The default home's is the app's own name; any other
// home gets one of its own, so that two homes do not take turns overwriting one entry.
func autostartID() string {
	if state.IsDefaultHome() {
		return "DutyBoard"
	}
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(state.Home()))))
	return "DutyBoard-" + hex.EncodeToString(sum[:4])
}

// Autostart reports whether the app starts, in the tray, when the person signs in.
func (m *Machine) Autostart() bool {
	on, err := m.app.Autostart.IsEnabled()
	return err == nil && on
}

// SetAutostart turns starting at sign-in on or off. On, it also retires what a command-line install
// left to start `dutyboard` at sign-in: two things starting the same machine would only have the
// second find the first already there.
func (m *Machine) SetAutostart(on bool) error {
	if !on {
		return m.app.Autostart.Disable()
	}
	args := []string{"--tray"}
	if !state.IsDefaultHome() {
		args = append(args, "--home", state.Home())
	}
	if err := m.app.Autostart.EnableWithOptions(application.AutostartOptions{Identifier: autostartID(), Arguments: args}); err != nil {
		return err
	}
	if state.IsDefaultHome() && service.Installed() {
		_ = service.Uninstall()
	}
	return nil
}

// TakeOver stops the dutyboard a CLI install left running, and runs it here instead.
func (m *Machine) TakeOver() error { return m.h.TakeOver() }

// OpenConsole opens the board's console in the person's browser.
func (m *Machine) OpenConsole() error {
	url := m.h.Snapshot().Console
	if url == "" {
		return errors.New("this machine is not connected to a DutyBoard yet")
	}
	return m.app.Browser.OpenURL(url)
}

// Quit stops the machine and closes the app, as the tray's Quit does.
func (m *Machine) Quit() { m.app.Quit() }

// runApp is the app. With quitOnly it is not: it is a message to the app already running to quit,
// carried by the single-instance channel, and if no app is running there is nothing to tell.
func runApp(startHidden, quitOnly bool, consoleErr error) int {
	h := host.New(app.Version)
	machine := &Machine{h: h}
	setup := &Setup{h: h, machine: machine}
	updates := &Updates{h: h}

	var window *application.WebviewWindow
	show := func() {
		if window == nil {
			return
		}
		window.Show()
		window.UnMinimise()
		window.Focus()
	}

	var browserArgs []string
	// For driving the window from a test: WebView2's own remote debugging, off unless asked for.
	if port := os.Getenv("DUTYBOARD_DESKTOP_DEBUG_PORT"); port != "" {
		browserArgs = append(browserArgs, "--remote-debugging-port="+port)
	}

	sub, _ := fs.Sub(dist, "frontend/dist")
	a := application.New(application.Options{
		Name:        "DutyBoard",
		Description: "Runs your DutyBoard's agents on this machine",
		Icon:        appIcon,
		Services:    []application.Service{application.NewService(machine), application.NewService(setup), application.NewService(updates)},
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(sub)},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			AdditionalBrowserArgs:         browserArgs,
			// With the rest of what this machine keeps, rather than WebView2's default of a folder
			// named after the executable in %APPDATA% — which a second home would share, and which
			// removing DutyBoard's folder would leave behind.
			WebviewUserDataPath: state.Path("webview"),
		},
		Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: false},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.altlimit.dutyboard.desktop." + strings.NewReplacer("\\", "_", "/", "_", ":", "_").Replace(h.Snapshot().Home),
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
				for _, arg := range d.Args {
					if arg == "--quit" {
						application.Get().Quit()
						return
					}
				}
				show()
			},
		},
		// Quitting is stopping: sessions are given their time to finish, as with `dutyboard --stop`.
		OnShutdown: func() { h.Pause() },
	})
	machine.app, setup.app, updates.app = a, a, a
	if quitOnly {
		// Reaching here means no other instance took the message: nothing is running.
		return 0
	}

	h.OnChange = func(s host.Snapshot) { a.Event.Emit("machine:status", s) }
	h.OnLog = func(line string) { a.Event.Emit("machine:log", line) }

	window = a.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "DutyBoard",
		Name:             "main",
		Width:            920,
		Height:           760,
		Hidden:           startHidden,
		BackgroundColour: application.NewRGB(15, 17, 21),
		URL:              "/",
	})
	// Closing the window is not stopping the machine: it stays in the tray.
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		window.Hide()
		e.Cancel()
	})

	tray := a.SystemTray.New()
	tray.SetIcon(trayLight).SetDarkModeIcon(trayDark)
	tray.SetTooltip("DutyBoard")
	tray.OnClick(show)
	menu := a.NewMenu()
	menu.Add("Show DutyBoard").OnClick(func(*application.Context) { show() })
	menu.Add("Open console").OnClick(func(*application.Context) { _ = machine.OpenConsole() })
	menu.AddSeparator()
	pause := menu.Add("Pause")
	pause.OnClick(func(*application.Context) {
		if s := h.Snapshot().State; s == host.Working || s == host.Starting {
			go h.Pause()
		} else {
			go h.Start()
		}
	})
	menu.AddSeparator()
	menu.Add("Quit").OnClick(func(*application.Context) { a.Quit() })
	tray.SetMenu(menu)

	onChange := h.OnChange
	h.OnChange = func(s host.Snapshot) {
		onChange(s)
		tray.SetTooltip("DutyBoard — " + string(s.State))
		if s.State == host.Working || s.State == host.Starting {
			pause.SetLabel("Pause")
		} else {
			pause.SetLabel("Resume")
		}
	}

	updates.visible = func() bool { return window != nil && window.IsVisible() }
	updates.start()

	if consoleErr != nil {
		h.Note("could not hide the consoles of the programs this starts: " + consoleErr.Error())
	}
	go h.Start()

	if err := a.Run(); err != nil {
		return 1
	}
	return 0
}
