// Package host runs the dutyboard daemon inside another process — the desktop app — and says what
// it is doing. It has no window and no Wails in it, so it builds and tests anywhere the CLI does.
package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/daemon"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// State is what the machine is doing, as the app shows it.
type State string

const (
	Unpaired State = "unpaired" // no machine key or no board address yet: setup has not been done
	Starting State = "starting"
	Working  State = "working"
	Paused   State = "paused"   // stopped by the person, in this app
	Stopping State = "stopping" // sessions are being given time to finish
	External State = "external" // another dutyboard (the CLI's service) holds this home
	Failed   State = "failed"
)

// Snapshot is the machine at one moment.
type Snapshot struct {
	State   State  `json:"state"`
	Error   string `json:"error,omitempty"`
	Machine string `json:"machine,omitempty"`
	Console string `json:"console,omitempty"`
	Server  string `json:"server,omitempty"`
	Home    string `json:"home"`
	// Projects is the folder this machine keeps its boards' repositories in.
	Projects string `json:"projects"`
	Version  string `json:"version"`
	Since    int64  `json:"since"` // when it entered this state, unix seconds
}

// Revoked is what a machine is told when its DutyBoard no longer knows it.
const Revoked = "This machine was removed from its DutyBoard in the console. Connect it again to carry on."

const keepLines = 500

// Host owns one daemon at a time.
type Host struct {
	Version  string
	OnChange func(Snapshot) // called on every change of state; may be nil
	OnLog    func(string)   // called with each line the daemon logs; may be nil

	mu     sync.Mutex
	snap   Snapshot
	d      *daemon.Daemon
	done   chan struct{} // closed when the running daemon has returned
	lines  []string
	logf   *os.File
	paused bool
}

// New is a host that has not started anything.
func New(version string) *Host {
	h := &Host{Version: version, snap: Snapshot{State: Paused, Home: state.Home(), Version: version, Since: time.Now().Unix()}}
	if cfg, err := state.LoadConfig(); err == nil {
		h.snap.Projects = daemon.ProjectsRoot(cfg)
	}
	return h
}

// Folder is path as a folder this machine can keep projects in: absolute, and there — made if it was
// not. A relative path is refused rather than resolved, because what it would be relative to is
// wherever the app happened to be started from.
func Folder(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("choose a folder")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%s is not a full path", path)
	}
	path = filepath.Clean(path)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", fmt.Errorf("that folder cannot be used: %w", err)
	}
	return path, nil
}

// SetProjects moves where this machine keeps its boards' repositories, and restarts the daemon if
// it is running, since the folder is read when it starts. Nothing is moved: the boards are cloned
// again in the new folder as they are next worked, and what is in the old one stays there.
func (h *Host) SetProjects(path string) error {
	path, err := Folder(path)
	if err != nil {
		return err
	}
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	if daemon.ProjectsRoot(cfg) == path {
		return nil
	}
	cfg.ProjectsRoot = path
	if err := cfg.Save(); err != nil {
		return err
	}
	h.mu.Lock()
	h.snap.Projects = path
	running := h.d != nil
	h.mu.Unlock()
	if running {
		h.Pause()
		h.Start()
		return nil
	}
	h.set(h.Snapshot().State, h.Snapshot().Error)
	return nil
}

// Snapshot is the current state.
func (h *Host) Snapshot() Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snap
}

// Logs are the most recent lines the daemon logged, oldest first.
func (h *Host) Logs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.lines...)
}

func (h *Host) set(s State, errText string) {
	h.mu.Lock()
	h.snap.State, h.snap.Error, h.snap.Since = s, errText, time.Now().Unix()
	snap := h.snap
	cb := h.OnChange
	h.mu.Unlock()
	if cb != nil {
		cb(snap)
	}
}

// Start runs the daemon if this machine is paired and nothing else holds the home. It returns once
// the daemon is running or has been found unable to; the work itself goes on in the background.
func (h *Host) Start() {
	h.mu.Lock()
	if h.d != nil {
		h.mu.Unlock()
		return
	}
	h.paused = false
	h.mu.Unlock()

	cfg, err := state.LoadConfig()
	if err != nil {
		h.set(Failed, err.Error())
		return
	}
	h.mu.Lock()
	h.snap.Machine, h.snap.Console, h.snap.Server = cfg.MachineName, cfg.Console, cfg.Server
	h.snap.Projects = daemon.ProjectsRoot(cfg)
	h.mu.Unlock()

	key, _ := state.Credential(state.MachineKey)
	if key == "" || cfg.Server == "" {
		h.set(Unpaired, "")
		return
	}
	// One daemon per home: run/daemon.json is a single file. A CLI install's service is the other
	// holder there can be, and taking over from it is the person's decision, not this function's.
	if localmcp.Running() {
		h.set(External, "")
		return
	}
	h.set(Starting, "")

	d, err := daemon.New(daemon.Options{Version: h.Version, Config: cfg, Key: key, Out: h.writer()})
	if err != nil {
		h.set(Failed, err.Error())
		return
	}
	done := make(chan struct{})
	h.mu.Lock()
	h.d, h.done = d, done
	h.mu.Unlock()
	h.set(Working, "")

	go func() {
		err := d.Run(context.Background())
		h.mu.Lock()
		h.d, h.done = nil, nil
		paused := h.paused
		h.mu.Unlock()
		close(done)
		// Revoked is said two ways. A poll that is refused returns ErrRevoked; told over the live
		// channel, the daemon forgets its key and stops, and returns nothing. Either way the key is gone.
		key, _ := state.Credential(state.MachineKey)
		switch {
		case errors.Is(err, daemon.ErrRevoked), key == "":
			h.set(Unpaired, Revoked)
		case err != nil:
			h.set(Failed, err.Error())
		case paused:
			h.set(Paused, "")
		default:
			// Stopped from outside this app: `dutyboard --stop`, over the local control channel.
			h.set(Paused, "stopped from another dutyboard command on this machine")
		}
	}()
}

// Pause stops the daemon and waits for it. The duties it held are resumed by the next Start.
func (h *Host) Pause() {
	h.mu.Lock()
	d, done := h.d, h.done
	h.paused = true
	h.mu.Unlock()
	if d == nil {
		return
	}
	h.set(Stopping, "")
	d.Stop()
	<-done
}

// TakeOver stops whatever other dutyboard holds this home, then starts this one.
func (h *Host) TakeOver() error {
	c, err := localmcp.Dial()
	if err == nil {
		err = c.Stop(30 * time.Second)
		c.Close()
		if err != nil {
			return err
		}
	}
	h.Start()
	return nil
}

// Busy is how many agent sessions are running now; none when the machine is not working at all.
func (h *Host) Busy() int {
	h.mu.Lock()
	d := h.d
	h.mu.Unlock()
	if d == nil {
		return 0
	}
	return d.Busy()
}

// Note puts a line of the app's own in the machine's log, with what the daemon writes there.
func (h *Host) Note(line string) {
	_, _ = h.writer().Write([]byte(time.Now().Format("2006/01/02 15:04:05") + " " + line + "\n"))
}

func (h *Host) writer() io.Writer {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.logf == nil {
		p := state.Path("logs", "daemon.log")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err == nil {
			h.logf, _ = os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		}
	}
	return &lineWriter{h: h}
}

// lineWriter keeps what the daemon logs: in its file, in memory for the window, and to OnLog.
type lineWriter struct {
	h   *Host
	buf []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	h := w.h
	h.mu.Lock()
	if h.logf != nil {
		_, _ = h.logf.Write(p)
	}
	w.buf = append(w.buf, p...)
	var fresh []string
	for {
		i := strings.IndexByte(string(w.buf), '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:i]), "\r")
		w.buf = w.buf[i+1:]
		if line != "" {
			fresh = append(fresh, line)
		}
	}
	h.lines = append(h.lines, fresh...)
	if n := len(h.lines); n > keepLines {
		h.lines = append([]string(nil), h.lines[n-keepLines:]...)
	}
	cb := h.OnLog
	h.mu.Unlock()
	if cb != nil {
		for _, l := range fresh {
			cb(l)
		}
	}
	return len(p), nil
}
