package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/deploy"
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

// handleRequest works a board a person asked this machine for from the console: make its repository on
// GitHub when asked to, link it, then clone its repository into the board's folder under the projects
// root, where the daemon keeps it.
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
		made := ""
		if req.Kind == "create_repo" {
			url, err := d.createRepo(ctx, req)
			if err != nil {
				d.log.Printf("making the repository for %s: %v", req.ProjectID, err)
				_ = d.api.ReportRequest(ctx, req.RequestID, "failed", err.Error())
				return
			}
			d.log.Printf("%s: created %s", req.ProjectID, url)
			made = "created " + url + " and "
		}
		path, err := d.setUp(ctx, req)
		if err != nil {
			d.log.Printf("setting up %s: %v", req.ProjectID, err)
			_ = d.api.ReportRequest(ctx, req.RequestID, "failed", made+"could not set it up: "+err.Error())
			return
		}
		d.log.Printf("%s: cloned into %s", req.ProjectID, path)
		_ = d.api.ReportRequest(ctx, req.RequestID, "done", made+"cloned into "+path)
		d.Reload()
	}()
}

// createRepo makes the board's repository on GitHub with this machine's GitHub CLI, and tells the
// board, which takes it as its repository. It is made empty: the clone puts the first commit in it.
func (d *Daemon) createRepo(ctx context.Context, req board.Request) (string, error) {
	if req.Repo == nil || req.Repo.Name == "" {
		return "", fmt.Errorf("the request names no repository to make")
	}
	url, err := deploy.CreateRepo(ctx, req.Repo.Owner, req.Repo.Name, req.Repo.Description, req.Repo.Private)
	if err != nil {
		return "", err
	}
	if err := d.api.ReportRepo(ctx, req.RequestID, url); err != nil {
		return "", fmt.Errorf("created %s, but could not tell the board: %w — set it as the board's repository URL in its settings", url, err)
	}
	return url, nil
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
