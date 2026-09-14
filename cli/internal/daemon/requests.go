package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// ProjectsRoot is where setups requested from the console put projects: config.json's
// projects_root, else ~/dutyboard.
func ProjectsRoot(cfg *state.Config) string {
	if cfg.ProjectsRoot != "" {
		return cfg.ProjectsRoot
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "dutyboard")
	}
	return "dutyboard"
}

// handleRequest sets up a board a person asked this machine for from the console: clone its
// repository into the projects folder (or use what is already there) and link it. Never anywhere
// outside the projects folder, whatever the request says.
func (d *Daemon) handleRequest(ctx context.Context, req board.Request) {
	d.mu.Lock()
	if d.requests[req.RequestID] {
		d.mu.Unlock()
		return
	}
	d.requests[req.RequestID] = true
	ask := d.me != nil && d.me.Machine.RemoteSetup == "ask"
	d.mu.Unlock()
	if ask {
		d.log.Printf("setup of %q was requested from the console; this machine is set to ask — run `dutyboard` in its folder to accept", req.ProjectID)
		return
	}

	go func() {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		_ = d.api.ReportRequest(ctx, req.RequestID, "running", "")
		path, err := d.setUp(ctx, req)
		if err != nil {
			d.log.Printf("setting up %s: %v", req.ProjectID, err)
			_ = d.api.ReportRequest(ctx, req.RequestID, "failed", err.Error())
			return
		}
		d.log.Printf("%s: set up at %s", req.ProjectID, path)
		_ = d.api.ReportRequest(ctx, req.RequestID, "done", "linked at "+path)
		d.Reload()
	}()
}

func (d *Daemon) setUp(ctx context.Context, req board.Request) (string, error) {
	root, err := filepath.Abs(ProjectsRoot(d.opt.Config))
	if err != nil {
		return "", err
	}
	name := req.Path
	if name == "" {
		name = req.ProjectID
	}
	target := filepath.Join(root, filepath.FromSlash(name))
	if !within(target, root) || target == root {
		return "", fmt.Errorf("%q is not a folder inside %s", name, root)
	}

	if top, err := worktree.Toplevel(ctx, target); err == nil && filepath.Clean(top) == filepath.Clean(target) {
		// Already cloned — someone set this up before, or cloned it by hand.
	} else if _, statErr := os.Stat(target); statErr == nil {
		return "", fmt.Errorf("%s exists and is not a git repository; move it or choose another folder", target)
	} else {
		if req.RepoURL == "" {
			return "", errors.New("the board has no repository URL in its profile, so there is nothing to clone")
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			return "", err
		}
		cmd := exec.CommandContext(ctx, "git", "clone", "--quiet", req.RepoURL, target)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("cloning %s: %v: %s", req.RepoURL, err, strings.TrimSpace(string(out)))
		}
	}
	if _, err := d.api.Link(ctx, req.ProjectID, target); err != nil {
		return "", err
	}
	return target, state.SetWorkspace(req.ProjectID, target)
}
