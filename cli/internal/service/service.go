// Package service installs the daemon to start when this user logs in: a systemd user unit on Linux,
// a launchd agent on macOS, a hidden launcher in the Startup folder on Windows.
//
// A service starts with almost none of the login shell's environment, and the daemon runs Claude,
// git, and whatever the project's toolchain is. So the PATH the install was run with is written into
// the service — the same PATH that found `claude` just now.
package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/state"
)

const (
	unitName  = "dutyboard.service"
	agentName = "com.altlimit.dutyboard"
	taskName  = "DutyBoard"
)

// ErrUnsupported is a machine with no service manager this knows how to use.
var ErrUnsupported = errors.New("no supported service manager here")

func unitPath() string {
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "systemd", "user", unitName)
}

// startupPath is the launcher in this user's Startup folder. Not a Task Scheduler task: creating an
// at-logon task is refused with "Access is denied" to anyone not running as administrator, and the
// Startup folder is the user's own.
func startupPath() string {
	dir := os.Getenv("APPDATA")
	if dir == "" {
		dir, _ = os.UserConfigDir()
	}
	return filepath.Join(dir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "DutyBoard.vbs")
}

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", agentName+".plist")
}

// Installed reports whether the daemon is set to start at login.
func Installed() bool {
	switch runtime.GOOS {
	case "linux":
		_, err := os.Stat(unitPath())
		return err == nil
	case "darwin":
		_, err := os.Stat(plistPath())
		return err == nil
	case "windows":
		_, err := os.Stat(startupPath())
		return err == nil || exec.Command("schtasks", "/Query", "/TN", taskName).Run() == nil
	}
	return false
}

// Install sets the daemon to start at login and starts it now. Answers where its log goes.
func Install(exe string) (string, error) {
	logPath := state.Path("logs", "daemon.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return "", err
	}
	path := os.Getenv("PATH")
	switch runtime.GOOS {
	case "linux":
		if exec.Command("systemctl", "--user", "show-environment").Run() != nil {
			return "", fmt.Errorf("%w: systemd user services are not available (on WSL, enable systemd in /etc/wsl.conf)", ErrUnsupported)
		}
		unit := fmt.Sprintf(`[Unit]
Description=DutyBoard runner
After=network-online.target

[Service]
ExecStart=%s
Restart=on-failure
RestartSec=10
Environment=PATH=%s
Environment=DUTYBOARD_HOME=%s

[Install]
WantedBy=default.target
`, exe, path, state.Home())
		if err := os.MkdirAll(filepath.Dir(unitPath()), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(unitPath(), []byte(unit), 0o644); err != nil {
			return "", err
		}
		for _, args := range [][]string{{"--user", "daemon-reload"}, {"--user", "enable", "--now", unitName}} {
			if out, err := exec.Command("systemctl", args...).CombinedOutput(); err != nil {
				return "", fmt.Errorf("systemctl %s: %v: %s", strings.Join(args, " "), err, out)
			}
		}
		return "journalctl --user -u dutyboard -f", nil
	case "darwin":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key><array><string>%s</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>%s</string>
    <key>DUTYBOARD_HOME</key><string>%s</string>
  </dict>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, agentName, xmlEscape(exe), xmlEscape(path), xmlEscape(state.Home()), xmlEscape(logPath), xmlEscape(logPath))
		if err := os.MkdirAll(filepath.Dir(plistPath()), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
			return "", err
		}
		// Unloaded first: loading a label launchd already has fails, and installing again after an
		// upgrade is exactly that.
		_ = exec.Command("launchctl", "unload", plistPath()).Run()
		if out, err := exec.Command("launchctl", "load", "-w", plistPath()).CombinedOutput(); err != nil {
			return "", fmt.Errorf("launchctl load: %v: %s", err, out)
		}
		return "tail -f " + logPath, nil
	case "windows":
		// wscript runs it with no window (the 0), logging to a file since nobody watches a console.
		if err := os.MkdirAll(filepath.Dir(startupPath()), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(startupPath(), []byte(windowsLauncher(exe, logPath)), 0o644); err != nil {
			return "", err
		}
		if out, err := exec.Command("wscript.exe", startupPath()).CombinedOutput(); err != nil {
			return "", fmt.Errorf("starting it: %v: %s", err, out)
		}
		return logPath, nil
	}
	return "", ErrUnsupported
}

// Uninstall stops the daemon starting at login.
func Uninstall() error {
	switch runtime.GOOS {
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
		return os.Remove(unitPath())
	case "darwin":
		_ = exec.Command("launchctl", "unload", "-w", plistPath()).Run()
		return os.Remove(plistPath())
	case "windows":
		_ = exec.Command("schtasks", "/Delete", "/F", "/TN", taskName).Run() // what 2.2.1 and earlier installed, for anyone allowed to
		return os.Remove(startupPath())
	}
	return ErrUnsupported
}

// windowsLauncher is a VBScript that starts the daemon hidden with its output appended to logPath.
// The daemon's own home is set in the script too, so a DUTYBOARD_HOME the install ran with holds.
func windowsLauncher(exe, logPath string) string {
	command := fmt.Sprintf(`cmd /c ""%s" >> "%s" 2>&1"`, exe, logPath)
	quote := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
	return "Set shell = CreateObject(\"WScript.Shell\")\r\n" +
		"shell.Environment(\"PROCESS\")(\"DUTYBOARD_HOME\") = " + quote(state.Home()) + "\r\n" +
		"shell.Run " + quote(command) + ", 0, False\r\n"
}

func xmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}
