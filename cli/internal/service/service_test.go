package service

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestWindowsLauncherQuotesPathsWithSpaces(t *testing.T) {
	got := windowsLauncher(`C:\Program Files\alt\dutyboard.exe`, `C:\Users\a b\DutyBoard\logs\daemon.log`)
	want := `shell.Run "cmd /c """"C:\Program Files\alt\dutyboard.exe"" >> ""C:\Users\a b\DutyBoard\logs\daemon.log"" 2>&1""", 0, False`
	if !strings.Contains(got, want) {
		t.Fatalf("launcher:\n%s\nwant a line:\n%s", got, want)
	}
}

func TestCronFallbackReplacesItsOwnLineAndKeepsTheRest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("crontab is a unix fallback")
	}
	dir := t.TempDir()
	table := filepath.Join(dir, "table")
	fake := "#!/bin/sh\nif [ \"$1\" = -l ]; then [ -f " + table + " ] && cat " + table + " || exit 1; else cat > " + table + "; fi\n"
	if err := os.WriteFile(filepath.Join(dir, "crontab"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(table, []byte("0 3 * * * backup.sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	t.Setenv("DUTYBOARD_HOME", filepath.Join(dir, "home it's"))
	started := filepath.Join(dir, "started")
	exe := filepath.Join(dir, "dutyboard")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho \"$@\" > "+started+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "daemon.log")

	for i := 0; i < 2; i++ {
		if err := installCron(exe, "/usr/bin:/bin", logPath); err != nil {
			t.Fatal(err)
		}
	}
	lines := crontabLines()
	if len(lines) != 2 || lines[0] != "0 3 * * * backup.sh" || !strings.HasPrefix(lines[1], "*/5 * * * * PATH='/usr/bin:/bin' DUTYBOARD_HOME='") || !strings.Contains(lines[1], `it'\''s`) {
		t.Fatalf("crontab after installing twice:\n%s", strings.Join(lines, "\n"))
	}
	if !cronInstalled() {
		t.Fatal("the installed line is not recognised")
	}
	for i := 0; i < 50; i++ {
		if b, err := os.ReadFile(started); err == nil && strings.TrimSpace(string(b)) == "--no-service" {
			break
		}
		if i == 49 {
			t.Fatal("the daemon was not started now as well")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := removeCron(); err != nil {
		t.Fatal(err)
	}
	if lines := crontabLines(); len(lines) != 1 || cronInstalled() {
		t.Fatalf("removing left:\n%s", strings.Join(lines, "\n"))
	}
}
