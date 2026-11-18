//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// noteInstalledVersion keeps Windows' list of installed apps saying the version that is installed.
// The installer writes it once; after that the app updates itself, and nothing else would.
// It touches only an entry whose install folder is the folder this copy runs from.
func noteInstalledVersion(version string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\DutyBoard`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return // not installed: a copy someone runs from wherever they put it
	}
	defer k.Close()
	where, _, err := k.GetStringValue("InstallLocation")
	if err != nil || !strings.EqualFold(filepath.Clean(where), filepath.Dir(self)) {
		return
	}
	if have, _, _ := k.GetStringValue("DisplayVersion"); have != version {
		_ = k.SetStringValue("DisplayVersion", version)
	}
}
