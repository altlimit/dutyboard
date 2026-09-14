package service

import (
	"strings"
	"testing"
)

func TestWindowsLauncherQuotesPathsWithSpaces(t *testing.T) {
	got := windowsLauncher(`C:\Program Files\alt\dutyboard.exe`, `C:\Users\a b\DutyBoard\logs\daemon.log`)
	want := `shell.Run "cmd /c """"C:\Program Files\alt\dutyboard.exe"" >> ""C:\Users\a b\DutyBoard\logs\daemon.log"" 2>&1""", 0, False`
	if !strings.Contains(got, want) {
		t.Fatalf("launcher:\n%s\nwant a line:\n%s", got, want)
	}
}
