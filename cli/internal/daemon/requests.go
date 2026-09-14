package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// ProjectsRoot is where this machine keeps the boards it works: config.json's projects_root, else
// ~/dutyboard.
func ProjectsRoot(cfg *state.Config) string {
	if cfg.ProjectsRoot != "" {
		return cfg.ProjectsRoot
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, "dutyboard")
	}
	return "dutyboard"
}

// handleRequest works a board a person asked this machine for from the console: link it, then clone
// its repository into the board's folder under the projects root, where the daemon keeps it.
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
		d.log.Printf("working %q was requested from the console; this machine is set to ask — run `dutyboard` here to accept", req.ProjectID)
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
		d.log.Printf("%s: cloned into %s", req.ProjectID, path)
		_ = d.api.ReportRequest(ctx, req.RequestID, "done", "cloned into "+path)
		d.Reload()
	}()
}

func (d *Daemon) setUp(ctx context.Context, req board.Request) (string, error) {
	if _, err := d.api.Link(ctx, req.ProjectID, d.boardDir(req.ProjectID)); err != nil {
		return "", err
	}
	if err := d.refresh(ctx); err != nil {
		return "", err
	}
	d.mu.Lock()
	v, ok := d.views[req.ProjectID]
	d.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("board %s did not appear among this machine's links", req.ProjectID)
	}
	return d.ensureClone(ctx, v)
}
