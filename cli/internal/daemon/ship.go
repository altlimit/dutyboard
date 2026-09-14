package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/deploy"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// watchDeploy follows the CI run a landed duty triggers, off the session's lane: a deploy that
// takes twenty minutes should not hold a slot another duty could use.
//
// Passing, it notes the run on the duty. Failing, it files an immediate blocker to fix it, with the
// failing log in the brief, spawned by the duty — so the next thing this board does is repair what
// just broke, and the thread says why.
func (d *Daemon) watchDeploy(ctx context.Context, run *Run, v board.BoardView, spec worktree.Spec, commit string) {
	if v.Profile == nil || commit == "" {
		return
	}
	method, workflow := v.Profile.Deploy.Method, v.Profile.Deploy.Workflow
	if method != "ci" && method != "ci-dispatch" {
		return
	}
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		note := func(msg string) {
			if err := d.api.Checkpoint(ctx, run.Board, run.DutyID, run.Agent, "note", msg, "", false); err != nil {
				d.log.Printf("noting the deploy on %s: %v", run.DutyID, err)
			}
		}
		short := commit
		if len(short) > 12 {
			short = short[:12]
		}
		if workflow == "" {
			note(fmt.Sprintf("CI deploys %s, but the board's profile names no workflow, so the runner did not watch it.", short))
			return
		}
		if !deploy.Available(ctx, spec.Repo) {
			note(fmt.Sprintf("CI (%s) deploys %s; not watched, because %v.", workflow, short, deploy.ErrNoGH))
			return
		}
		base := spec.Base
		if base == "" {
			base = worktree.DefaultBranch(ctx, spec.Repo, worktree.Remote(ctx, spec.Repo))
		}
		if method == "ci-dispatch" {
			if err := deploy.Dispatch(ctx, spec.Repo, workflow, base); err != nil {
				note(fmt.Sprintf("Could not start %s for %s: %v", workflow, short, err))
				return
			}
			time.Sleep(5 * time.Second) // a dispatched run takes a moment to be listed
		}
		result, err := deploy.Watch(ctx, spec.Repo, workflow, commit, method == "ci-dispatch", 60*time.Minute)
		if ctx.Err() != nil {
			return
		}
		if err != nil && result == nil {
			note(fmt.Sprintf("Did not see %s finish for %s: %v", workflow, short, err))
			return
		}
		if result.Conclusion == "success" {
			note(fmt.Sprintf("Deployed: %s passed for %s — %s", workflow, short, result.URL))
			return
		}
		logTail := deploy.FailedLog(ctx, spec.Repo, result.ID, 2400)
		brief := fmt.Sprintf("%s finished %s for %s, which %q landed. Run: %s\n\nFix what broke so the deploy passes, then integrate as usual.\n\nFailing steps (tail):\n```\n%s\n```",
			workflow, orDefault(result.Conclusion, result.Status), short, run.Title, result.URL, logTail)
		id, err := d.api.Enqueue(ctx, run.Board, map[string]any{
			"title":      "Fix the failed deploy of " + short,
			"brief":      clip(brief, 3900),
			"priority":   "immediate_blocker",
			"spawned_by": run.DutyID,
			"agent_id":   run.Agent,
		})
		if err != nil {
			d.log.Printf("filing the failed deploy of %s: %v", short, err)
			return
		}
		note(fmt.Sprintf("%s failed for %s (%s). Filed %s to fix it.", workflow, short, result.URL, id))
	}()
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// altengineTools are offered to a session on a board whose profile deploys to altengine.
var altengineTools = []map[string]any{
	{
		"name":  "altengine_deploy_static",
		"title": "Publish a site to altengine",
		"description": "Publish a built folder from this worktree to an altengine static instance, and make it live. Only files the platform does not already have are uploaded. " +
			"Integrate first: deploy what landed, not an unmerged branch. Only the instances the board allows can be deployed to.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"dir":      map[string]any{"type": "string", "description": "The build output folder, relative to the worktree, e.g. 'build/web'."},
				"instance": map[string]any{"type": "string", "description": "The static instance."},
				"message":  map[string]any{"type": "string", "description": "A label, such as the commit."},
				"exclude": map[string]any{
					"type": "array", "items": map[string]any{"type": "string"},
					"description": "Glob patterns for files in the folder that must not ship, matched against the path inside the folder and the file name, e.g. [\"*.gz\", \"*.import\"].",
				},
			},
			"required": []string{"dir", "instance"},
		},
	},
	{
		"name":        "altengine_deploy_function",
		"title":       "Deploy a function to altengine",
		"description": "Deploy one self-contained ES module from this worktree as an altengine function, and activate it. Integrate first. Only the instances the board allows can be deployed to.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file":     map[string]any{"type": "string", "description": "The bundled module, relative to the worktree."},
				"instance": map[string]any{"type": "string", "description": "The functions instance."},
				"name":     map[string]any{"type": "string", "description": "The function's name."},
				"grants":   map[string]any{"type": "object", "description": "What it may reach, e.g. {\"datastore:orders\": \"write\"}. Omit to keep the current grants.", "additionalProperties": map[string]any{"type": "string"}},
			},
			"required": []string{"file", "instance", "name"},
		},
	},
}

func deploysToAltengine(v board.BoardView) bool {
	return v.Profile != nil && v.Profile.Deploy.Method == "altengine" && len(v.Profile.Deploy.AltengineInstances) > 0
}

// altengineDeploy runs one of the altengine tools for a session. The daemon holds the key; the
// session names only a folder or file in its own worktree and an instance the board allows.
func (d *Daemon) altengineDeploy(ctx context.Context, s *session, name string, args map[string]any) (any, error) {
	run := s.run
	v := d.view(run.Board)
	if !deploysToAltengine(v) {
		return nil, errors.New("this board's profile does not deploy to altengine")
	}
	instance, _ := args["instance"].(string)
	allowed := false
	for _, i := range v.Profile.Deploy.AltengineInstances {
		if i == instance {
			allowed = true
		}
	}
	if !allowed {
		return nil, fmt.Errorf("instance %q is not one this board may deploy to (%s)", instance, strings.Join(v.Profile.Deploy.AltengineInstances, ", "))
	}
	key, err := state.Credential(state.AltengineKey)
	if err != nil || key == "" {
		return nil, errors.New("this machine has no altengine key — its owner can store one by running `dutyboard --provision-only`, or deploy by hand")
	}
	client := altengine.New(d.opt.Config.Altengine, key)

	inWorktree := func(rel string) (string, error) {
		p := filepath.Join(run.Worktree, filepath.FromSlash(rel))
		if !within(p, run.Worktree) {
			return "", fmt.Errorf("%q is outside this duty's worktree", rel)
		}
		return p, nil
	}
	lock := d.lock("deploy:" + run.Board)
	if err := lock.Acquire(ctx, run.DutyID); err != nil {
		return nil, err
	}
	defer lock.Release(run.DutyID)

	switch name {
	case "altengine_deploy_static":
		dir, _ := args["dir"].(string)
		root, err := inWorktree(dir)
		if err != nil {
			return nil, err
		}
		if info, err := os.Stat(root); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("%s is not a folder — build it first", dir)
		}
		var exclude []string
		if list, ok := args["exclude"].([]any); ok {
			for _, v := range list {
				if s, ok := v.(string); ok && s != "" {
					exclude = append(exclude, s)
				}
			}
		}
		files, err := altengine.FilesUnderExcept(os.DirFS(root), ".", "", exclude)
		if err != nil {
			return nil, err
		}
		if len(files) == 0 {
			return nil, fs.ErrNotExist
		}
		message, _ := args["message"].(string)
		url, id, err := client.DeployStatic(ctx, instance, message, files)
		if err != nil {
			return nil, err
		}
		verified := verifyLive(ctx, url, id)
		return map[string]any{"url": url, "deployment_id": id, "files": len(files), "verified": verified}, nil
	case "altengine_deploy_function":
		file, _ := args["file"].(string)
		p, err := inWorktree(file)
		if err != nil {
			return nil, err
		}
		code, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		fn, _ := args["name"].(string)
		var grants map[string]string
		if g, ok := args["grants"]; ok {
			b, _ := json.Marshal(g)
			_ = json.Unmarshal(b, &grants)
		}
		res, err := client.DeployFunction(ctx, instance, fn, string(code), grants)
		if err != nil {
			return nil, err
		}
		return map[string]any{"instance": instance, "name": fn, "version": res.Version, "size_bytes": res.SizeBytes}, nil
	}
	return nil, fmt.Errorf("unknown tool %s", name)
}

// verifyLive asks the site whether the new deployment is what it serves, when it says.
func verifyLive(ctx context.Context, url, id string) string {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, url+"/", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "could not reach the site: " + err.Error()
	}
	res.Body.Close()
	if got := res.Header.Get("x-ae-deployment"); got != "" && got != id {
		return fmt.Sprintf("the site still serves %s", got)
	}
	return fmt.Sprintf("%d", res.StatusCode)
}
