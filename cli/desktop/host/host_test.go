package host

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAMachineThatWasNeverSetUpIsUnpairedAndStartsNothing(t *testing.T) {
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	t.Setenv("DUTYBOARD_NO_KEYRING", "1")
	h := New("test")
	var seen []State
	h.OnChange = func(s Snapshot) { seen = append(seen, s.State) }
	h.Start()
	if got := h.Snapshot().State; got != Unpaired {
		t.Fatalf("state = %q, want %q", got, Unpaired)
	}
	if len(seen) != 1 || seen[0] != Unpaired {
		t.Fatalf("changes = %v, want one, to unpaired", seen)
	}
	h.Pause() // nothing is running: must not block
}

func TestWhatTheDaemonLogsIsKeptByLineInTheFileAndForTheWindow(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DUTYBOARD_HOME", home)
	h := New("test")
	var live []string
	h.OnLog = func(l string) { live = append(live, l) }
	w := h.writer()
	// As a logger writes: whole lines, but nothing promises one line per call.
	for _, chunk := range []string{"one\ntw", "o\r\n", "\n", "three"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if got := strings.Join(h.Logs(), "|"); got != "one|two" {
		t.Fatalf("kept %q, want the two finished lines", got)
	}
	if strings.Join(live, "|") != "one|two" {
		t.Fatalf("sent %q to the window", live)
	}
	file, err := os.ReadFile(filepath.Join(home, "logs", "daemon.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(file) != "one\ntwo\r\n\nthree" {
		t.Fatalf("the file holds %q, want every byte written", file)
	}

	for i := 0; i < keepLines+50; i++ {
		_, _ = w.Write([]byte("x\n"))
	}
	if n := len(h.Logs()); n != keepLines {
		t.Fatalf("kept %d lines, want the last %d", n, keepLines)
	}
}

func TestTheProjectsFolderIsAFullPathAndIsMade(t *testing.T) {
	if _, err := Folder("projects"); err == nil {
		t.Fatal("a relative path was accepted")
	}
	if _, err := Folder("  "); err == nil {
		t.Fatal("no path was accepted")
	}
	want := filepath.Join(t.TempDir(), "a", "b")
	got, err := Folder(want + string(filepath.Separator))
	if err != nil || got != want {
		t.Fatalf("Folder = %q, %v; want %q", got, err, want)
	}
	if fi, err := os.Stat(want); err != nil || !fi.IsDir() {
		t.Fatalf("the folder was not made: %v", err)
	}
}

func TestChangingTheProjectsFolderIsKeptAndShown(t *testing.T) {
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	t.Setenv("DUTYBOARD_NO_KEYRING", "1")
	h := New("test")
	want := filepath.Join(t.TempDir(), "work")
	if err := h.SetProjects(want); err != nil {
		t.Fatal(err)
	}
	if got := h.Snapshot().Projects; got != want {
		t.Fatalf("shown as %q, want %q", got, want)
	}
	if got := New("test").Snapshot().Projects; got != want {
		t.Fatalf("after a restart it is %q, want %q", got, want)
	}
}
