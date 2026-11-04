package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/deploy"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/setup"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/tools"
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
	ask := d.me != nil && d.me.Machine.RemoteSetup == "ask" && !d.accepted[req.RequestID]
	if ask {
		d.held[req.RequestID] = req
	}
	d.mu.Unlock()
	if ask {
		d.log.Printf("working %q was requested from the console; this machine is set to ask — run `dutyboard` here to accept", req.ProjectID)
		return
	}
	d.work(ctx, req)
}

// Accept is a person at this machine agreeing to a setup request: one already held is worked now,
// and one not yet seen is worked when it arrives.
func (d *Daemon) Accept(id string) {
	d.mu.Lock()
	d.accepted[id] = true
	req, held := d.held[id]
	delete(d.held, id)
	ctx := d.ctx
	d.mu.Unlock()
	if held && ctx != nil {
		d.log.Printf("accepted on this machine: working %q", req.ProjectID)
		d.work(ctx, req)
	}
}

// work carries a request out, in the background.
func (d *Daemon) work(ctx context.Context, req board.Request) {
	if req.Kind == "install_tool" || req.Kind == "sign_in" {
		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			d.workTool(ctx, req)
		}()
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
		done := "cloned into " + path
		if v := d.view(req.ProjectID); v.Files() {
			done = "ready: its duties are worked in folders under " + path
		}
		d.log.Printf("%s: %s", req.ProjectID, done)
		_ = d.api.ReportRequest(ctx, req.RequestID, "done", made+done)
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
	if v.Files() {
		// Nothing to clone: each of its duties gets a folder of its own when it starts.
		return filepath.Join(d.wt.Root, v.ProjectID), nil
	}
	return d.ensureClone(ctx, v)
}

// workTool installs a tool or signs in to one, as the machine's owner asked from the console, then
// checks the machine again so its checklist says how it went.
func (d *Daemon) workTool(ctx context.Context, req board.Request) {
	label := setup.Label(req.Tool)
	_ = d.api.ReportRequest(ctx, req.RequestID, "running", "")
	var err error
	done := ""
	switch req.Kind {
	case "install_tool":
		d.log.Printf("installing %s, as asked from the console", label)
		var dir string
		if dir, err = setup.Install(ctx, req.Tool, tools.Dir(), logWriter{d.log}); err == nil {
			d.addToolPath(dir)
			done = "installed " + label
			if st := d.agentStatus(ctx, req.Tool); st != nil && !st.Installed {
				err = fmt.Errorf("the installer finished, but %s is still not found in %s", label, dir)
			}
		}
	case "sign_in":
		d.log.Printf("signing in to %s, as asked from the console", label)
		show := func(p setup.Prompt) {
			if err := d.api.ReportPrompt(ctx, req.RequestID, p); err != nil {
				d.log.Printf("telling the console how to sign in to %s: %v", label, err)
			}
		}
		if err = setup.SignIn(ctx, req.Tool, show, func(ctx context.Context) (string, error) { return d.awaitInput(ctx, req.RequestID) }); err == nil {
			done = "signed in to " + label
		}
	}
	// Whatever happened, the next look at this machine asks again.
	runner.ForgetChecks()
	d.mu.Lock()
	d.ghCheckedAt = time.Time{}
	d.readiness.due = true
	d.mu.Unlock()
	if err != nil {
		d.log.Printf("%s: %v", label, err)
		_ = d.api.ReportRequest(ctx, req.RequestID, "failed", err.Error())
	} else {
		d.log.Printf("%s", done)
		_ = d.api.ReportRequest(ctx, req.RequestID, "done", done)
	}
	d.wake()
}

// agentStatus is an agent's status by its key, or nil for a tool that is not an agent.
func (d *Daemon) agentStatus(ctx context.Context, tool string) *runner.Status {
	if tool == "gh" {
		return nil
	}
	a, err := runner.For(tool)
	if err != nil {
		return nil
	}
	runner.ForgetChecks()
	st := a.Status(ctx)
	return &st
}

// addToolPath puts a folder an install put a command in on this daemon's PATH — which every session
// it starts inherits — and keeps it for the next start.
func (d *Daemon) addToolPath(dir string) {
	if dir == "" {
		return
	}
	prependPath(dir)
	d.mu.Lock()
	added := d.opt.Config.AddToolPath(dir)
	d.mu.Unlock()
	if !added {
		return
	}
	// The file, not d.opt.Config, which may be older than what another dutyboard invocation saved.
	if cfg, err := state.LoadConfig(); err == nil {
		cfg.AddToolPath(dir)
		if err := cfg.Save(); err != nil {
			d.log.Printf("remembering %s: %v", dir, err)
		}
	}
}

// prependPath puts dir first on this process's PATH, once.
func prependPath(dir string) {
	path := os.Getenv("PATH")
	for _, p := range filepath.SplitList(path) {
		if p == dir {
			return
		}
	}
	_ = os.Setenv("PATH", dir+string(os.PathListSeparator)+path)
}

// awaitInput waits for the value a person pastes back for a sign-in: told by the machine's channel,
// or found by asking, every few seconds.
func (d *Daemon) awaitInput(ctx context.Context, requestID string) (string, error) {
	ch := make(chan struct{}, 1)
	d.mu.Lock()
	d.inputs[requestID] = ch
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.inputs, requestID)
		d.mu.Unlock()
	}()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		me, err := d.api.Me(ctx)
		if err == nil {
			for _, r := range me.Requests {
				if r.RequestID == requestID && r.Input != "" {
					if err := d.api.TakeInput(ctx, requestID); err != nil {
						d.log.Printf("clearing what was pasted for %s: %v", requestID, err)
					}
					return r.Input, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ch:
		case <-t.C:
		}
	}
}

// inputArrived is the machine's channel saying a person pasted something for a sign-in.
func (d *Daemon) inputArrived(requestID string) {
	d.mu.Lock()
	ch := d.inputs[requestID]
	d.mu.Unlock()
	if ch != nil {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
