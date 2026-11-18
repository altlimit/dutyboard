package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"

	"github.com/altlimit/dutyboard/cli/desktop/host"
	"github.com/altlimit/dutyboard/cli/internal/app"
)

// The release asset an update is: the app itself, as one file. Its checksum is the file beside it.
const (
	updateRepository = "altlimit/dutyboard"
	updateAsset      = "DutyBoard-Desktop.exe"
	updateChecksum   = updateAsset + ".sha256"
)

// hiddenEnv tells the app it is being started again after an update that nobody asked for by hand,
// and so should come back the way it was: in the tray, with no window.
const hiddenEnv = "DUTYBOARD_DESKTOP_HIDDEN"

func init() {
	application.RegisterEvent[UpdateStatus]("update:status")
}

// UpdateStatus is where the app stands with its own updates.
type UpdateStatus struct {
	// Enabled is false for a build that does not update itself: one with no release version.
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`   // "", checking, current, downloading, ready, error
	Version string `json:"version"` // the update's version, once one is found
	Error   string `json:"error"`
	// Waiting is a downloaded update holding off because agents are working: installing it restarts
	// the app, and a restart stops their sessions.
	Waiting bool `json:"waiting"`
}

// Updates keeps the app up to date by itself.
//
// It finds a newer release, downloads it, and checks it twice: its SHA-256 against the release's, and
// its code signature against this app's own — the update must be signed by whoever signed what is
// running. Then it installs it when no agent session would be interrupted, or at once when asked.
// The swap itself, with its rollback, is Wails'.
type Updates struct {
	app     *application.App
	h       *host.Host
	visible func() bool

	mu     sync.Mutex
	st     UpdateStatus
	busy   bool // a check or download is under way
	wakeup chan struct{}
}

var releaseVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// start begins checking: shortly after launch, then a few times a day.
func (u *Updates) start() {
	// The app an update replaced stays beside the new one, renamed, because Windows will not delete a
	// program while it runs. It is not running now.
	if self, err := os.Executable(); err == nil {
		if old, _ := filepath.Glob(self + ".old.*"); len(old) > 0 {
			for _, f := range old {
				_ = os.Remove(f)
			}
		}
	}
	version := strings.TrimPrefix(app.Version, "v")
	if !releaseVersion.MatchString(version) {
		return // a development build: there is no release to compare it with
	}
	noteInstalledVersion(version)
	gh, err := github.New(github.Config{
		Repository: updateRepository,
		// For testing against a stand-in for GitHub; empty is GitHub itself.
		BaseURL: os.Getenv("DUTYBOARD_UPDATE_API"),
		AssetMatcher: func(_ updater.CheckRequest, assets []github.ReleaseAsset) int {
			for i, a := range assets {
				if a.Name == updateAsset {
					return i
				}
			}
			return -1
		},
		ChecksumAsset: updateChecksum,
	})
	if err != nil {
		return
	}
	if err := u.app.Updater.Init(updater.Config{CurrentVersion: version, Providers: []updater.Provider{gh}, Window: updater.WindowNone}); err != nil {
		u.h.Note("updates are off: " + err.Error())
		return
	}
	u.wakeup = make(chan struct{}, 1)
	u.set(func(s *UpdateStatus) { s.Enabled = true })
	go func() {
		wait := 20 * time.Second
		for {
			select {
			case <-time.After(wait):
			case <-u.wakeup:
			}
			u.check(context.Background())
			wait = 6 * time.Hour
		}
	}()
	go u.installWhenIdle()
}

func (u *Updates) set(change func(*UpdateStatus)) UpdateStatus {
	u.mu.Lock()
	change(&u.st)
	u.st.Waiting = u.st.State == "ready" && u.h.Busy() > 0
	st := u.st
	u.mu.Unlock()
	u.app.Event.Emit("update:status", st)
	return st
}

// Status is where updates stand.
func (u *Updates) Status() UpdateStatus {
	return u.set(func(*UpdateStatus) {})
}

// Check looks for an update now, and answers what it found.
func (u *Updates) Check(ctx context.Context) UpdateStatus {
	u.check(ctx)
	return u.Status()
}

func (u *Updates) check(ctx context.Context) {
	u.mu.Lock()
	if !u.st.Enabled || u.busy || u.st.State == "ready" {
		u.mu.Unlock()
		return
	}
	u.busy = true
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.busy = false; u.mu.Unlock() }()

	fail := func(what string, err error) {
		u.set(func(s *UpdateStatus) { s.State, s.Error = "error", what+": "+err.Error() })
	}
	u.set(func(s *UpdateStatus) { s.State, s.Error = "checking", "" })
	rel, err := u.app.Updater.Check(ctx)
	if err != nil {
		fail("could not check for updates", err)
		return
	}
	if rel == nil {
		u.set(func(s *UpdateStatus) { s.State = "current" })
		return
	}
	u.set(func(s *UpdateStatus) { s.State, s.Version = "downloading", rel.Version })
	if err := u.app.Updater.DownloadAndInstall(ctx); err != nil {
		if strings.Contains(err.Error(), "digest mismatch") {
			err = errors.New("what was downloaded does not match the release's checksum")
		}
		fail("DutyBoard "+rel.Version+" was not installed", err)
		return
	}
	// The download matched the release's checksum. That says it is the file the release holds, not
	// who made it — which is what its signature says.
	staged := u.app.Updater.DownloadedPath()
	if err := sameSigner(staged); err != nil {
		_ = os.Remove(staged) // nothing may install it now
		fail("DutyBoard "+rel.Version+" was not installed", err)
		return
	}
	u.h.Note("DutyBoard " + rel.Version + " is downloaded, and installs when no agent is working")
	u.set(func(s *UpdateStatus) { s.State = "ready" })
}

// installWhenIdle installs a downloaded update at the first moment nothing would be interrupted.
func (u *Updates) installWhenIdle() {
	for {
		time.Sleep(30 * time.Second)
		u.mu.Lock()
		ready := u.st.State == "ready"
		u.mu.Unlock()
		if !ready {
			continue
		}
		if u.h.Busy() > 0 {
			u.set(func(*UpdateStatus) {}) // says it is waiting
			continue
		}
		if err := u.restart(); err != nil && !errors.Is(err, updater.ErrRestartPending) {
			u.set(func(s *UpdateStatus) { s.State, s.Error = "error", "could not install the update: "+err.Error() })
			return
		}
		return
	}
}

// RestartNow installs a downloaded update at once, stopping whatever sessions are running; their
// duties are resumed when the app is back.
func (u *Updates) RestartNow() error {
	u.mu.Lock()
	ready := u.st.State == "ready"
	u.mu.Unlock()
	if !ready {
		return errors.New("no update is ready to install")
	}
	return u.restart()
}

func (u *Updates) restart() error {
	// The new app inherits this environment, so this is how it learns to stay out of the way.
	if u.visible != nil && !u.visible() {
		_ = os.Setenv(hiddenEnv, "1")
	} else {
		_ = os.Unsetenv(hiddenEnv)
	}
	u.h.Note("installing the update and restarting")
	if err := u.app.Updater.Restart(context.Background()); err != nil {
		return fmt.Errorf("%w", err)
	}
	return nil
}
