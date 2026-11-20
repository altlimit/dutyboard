package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// ForgetAltengineKey removes the kept key: revoked, or signed out.
func ForgetAltengineKey() error {
	if err := state.DeleteCredential(state.AltengineKey); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	cfg.AltengineSignedIn = false
	return cfg.Save()
}

// SignOutAltengine revokes a key that came from signing in, and forgets it. A pasted key is only
// forgotten: it belongs to whoever made it, in the altengine console.
func SignOutAltengine(ctx context.Context) error {
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	if k, err := state.Credential(state.AltengineKey); err == nil && k != "" && cfg.AltengineSignedIn {
		if err := (&altengine.OAuth{}).Revoke(ctx, k); err != nil {
			return err
		}
	}
	return ForgetAltengineKey()
}

// browserless is a machine where a browser opened here would not reach the person: over SSH, or a
// Linux box with no display (WSL opens Windows' browser, so it counts as having one).
func browserless() bool {
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return true
	}
	if runtime.GOOS != "linux" || os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return false
	}
	return !isWSL()
}

func isWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	b, err := os.ReadFile("/proc/version")
	return err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft")
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		openers := []string{"wslview", "xdg-open"}
		if isWSL() {
			// Windows' own shell opens a URL given as its one argument, with no quoting to get wrong.
			openers = []string{"wslview", "explorer.exe", "xdg-open"}
		}
		for _, opener := range openers {
			if _, err := exec.LookPath(opener); err == nil {
				cmd = exec.Command(opener, url)
				break
			}
		}
	}
	if cmd == nil {
		return errors.New("no way to open a browser here")
	}
	return cmd.Start()
}
