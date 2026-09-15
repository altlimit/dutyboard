// Package service installs the daemon to start by itself: a systemd user unit on Linux (started at
// boot once the user lingers), or an @reboot crontab entry where there is no systemd user manager; a
// launchd agent on macOS; a hidden launcher in the Startup folder on Windows.
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
		return err == nil || cronInstalled()
	case "darwin":
		_, err := os.Stat(plistPath())
		return err == nil
	case "windows":
		_, err := os.Stat(startupPath())
		return err == nil || exec.Command("schtasks", "/Query", "/TN", taskName).Run() == nil
	}
	return false
}

// Installation says how the daemon was set to start, and anything a person still has to do.
type Installation struct {
	Logs  string   // how to follow its log
	Notes []string // e.g. the command that makes a Linux user service start at boot
}

// Install sets the daemon to start by itself and starts it now.
func Install(exe string) (*Installation, error) {
	logs, notes, err := install(exe)
	if err != nil {
		return nil, err
	}
	return &Installation{Logs: logs, Notes: notes}, nil
}

func install(exe string) (string, []string, error) {
	logPath := state.Path("logs", "daemon.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return "", nil, err
	}
	path := os.Getenv("PATH")
	switch runtime.GOOS {
	case "linux":
		// A systemd user service when it will keep running: the user lingers, or lingering can be turned
		// on. Otherwise it would stop when the user logs out and not start at boot, and turning lingering
		// on needs an admin — so the user's own crontab starts it instead, which needs neither.
		systemd := exec.Command("systemctl", "--user", "show-environment").Run() == nil
		_, cronErr := exec.LookPath("crontab")
		lingers, turnedOn := linger()
		who := os.Getenv("USER")
		if !systemd || (!lingers && cronErr == nil) {
			if cronErr != nil {
				return "", nil, fmt.Errorf("%w: neither systemd user services nor crontab are available (on WSL, enable systemd in /etc/wsl.conf)", ErrUnsupported)
			}
			if systemd {
				_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
				_ = os.Remove(unitPath())
			}
			if err := installCron(exe, path, logPath); err != nil {
				return "", nil, err
			}
			note := "your crontab starts it — every 5 minutes when it is not already running, which covers boot and a crash — with no login needed"
			if systemd {
				note += fmt.Sprintf(". A systemd user service would stop when you log out, since %s does not linger; if an admin runs `sudo loginctl enable-linger %s`, run `dutyboard --service` again to switch to it", who, who)
			}
			return "tail -f " + logPath, []string{note}, nil
		}
		_ = removeCron()
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
			return "", nil, err
		}
		if err := os.WriteFile(unitPath(), []byte(unit), 0o644); err != nil {
			return "", nil, err
		}
		for _, args := range [][]string{{"--user", "daemon-reload"}, {"--user", "enable", "--now", unitName}} {
			if out, err := exec.Command("systemctl", args...).CombinedOutput(); err != nil {
				return "", nil, fmt.Errorf("systemctl %s: %v: %s", strings.Join(args, " "), err, out)
			}
		}
		var notes []string
		switch {
		case turnedOn:
			notes = append(notes, "turned on lingering for "+who+", so it starts at boot without anyone logging in")
		case !lingers:
			notes = append(notes, "it runs while you are logged in; to have it start at boot and keep running after you log out, an admin can run: sudo loginctl enable-linger "+who)
		}
		return "journalctl --user -u dutyboard -f", notes, nil
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
			return "", nil, err
		}
		if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
			return "", nil, err
		}
		// Unloaded first: loading a label launchd already has fails, and installing again after an
		// upgrade is exactly that.
		_ = exec.Command("launchctl", "unload", plistPath()).Run()
		if out, err := exec.Command("launchctl", "load", "-w", plistPath()).CombinedOutput(); err != nil {
			return "", nil, fmt.Errorf("launchctl load: %v: %s", err, out)
		}
		return "tail -f " + logPath, nil, nil
	case "windows":
		// wscript runs it with no window (the 0), logging to a file since nobody watches a console.
		if err := os.MkdirAll(filepath.Dir(startupPath()), 0o755); err != nil {
			return "", nil, err
		}
		if err := os.WriteFile(startupPath(), []byte(windowsLauncher(exe, logPath)), 0o644); err != nil {
			return "", nil, err
		}
		if out, err := exec.Command("wscript.exe", startupPath()).CombinedOutput(); err != nil {
			return "", nil, fmt.Errorf("starting it: %v: %s", err, out)
		}
		return logPath, nil, nil
	}
	return "", nil, ErrUnsupported
}

// Uninstall stops the daemon starting at login.
func Uninstall() error {
	switch runtime.GOOS {
	case "linux":
		_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
		_ = removeCron()
		if err := os.Remove(unitPath()); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
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

// linger says whether this user lingers, turning it on when it can. A systemd user service runs while
// its user has a session; without lingering, a server that reboots — or a person who logs out of SSH
// — stops it until someone logs in again.
func linger() (lingers, turnedOn bool) {
	who := os.Getenv("USER")
	if who == "" {
		return false, false
	}
	out, err := exec.Command("loginctl", "show-user", who, "--property=Linger", "--value").Output()
	if err == nil && strings.TrimSpace(string(out)) == "yes" {
		return true, false
	}
	// Allowed without sudo on some systems. --no-ask-password: where polkit wants a password it is
	// refused rather than asked, since nobody may be at the terminal, and loginctl does not try to
	// start a polkit agent and print its failure to.
	if exec.Command("loginctl", "--no-ask-password", "enable-linger", who).Run() == nil {
		return true, true
	}
	return false, false
}

const cronMark = "# dutyboard"

func crontabLines() []string {
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		return nil // no crontab yet
	}
	return strings.Split(strings.TrimRight(string(out), "\n"), "\n")
}

func cronInstalled() bool {
	for _, l := range crontabLines() {
		if strings.HasSuffix(strings.TrimSpace(l), cronMark) {
			return true
		}
	}
	return false
}

func writeCrontab(lines []string) error {
	cmd := exec.Command("crontab", "-")
	cmd.Stdin = strings.NewReader(strings.Join(lines, "\n") + "\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("crontab: %v: %s", err, out)
	}
	return nil
}

func removeCron() error {
	var keep []string
	found := false
	for _, l := range crontabLines() {
		if strings.HasSuffix(strings.TrimSpace(l), cronMark) {
			found = true
			continue
		}
		keep = append(keep, l)
	}
	if !found {
		return nil
	}
	return writeCrontab(keep)
}

// installCron adds a line that starts the daemon every five minutes — which does nothing when one is
// already running — replacing one this wrote before, and starts it now in the background. One line
// rather than @reboot as well: two starting in the same minute at boot would both find nothing running.
func installCron(exe, path, logPath string) error {
	line := fmt.Sprintf("*/5 * * * * PATH=%s DUTYBOARD_HOME=%s %s --no-service >> %s 2>&1 %s",
		shellQuote(path), shellQuote(state.Home()), shellQuote(exe), shellQuote(logPath), cronMark)
	var lines []string
	for _, l := range crontabLines() {
		if !strings.HasSuffix(strings.TrimSpace(l), cronMark) && l != "" {
			lines = append(lines, l)
		}
	}
	if err := writeCrontab(append(lines, line)); err != nil {
		return err
	}
	return startDetached(exe, logPath)
}

// shellQuote quotes s for /bin/sh, which is what cron runs a line with.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func startDetached(exe, logPath string) error {
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	cmd := exec.Command(exe, "--no-service")
	cmd.Stdout, cmd.Stderr = f, f
	cmd.Env = append(os.Environ(), "DUTYBOARD_HOME="+state.Home())
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
