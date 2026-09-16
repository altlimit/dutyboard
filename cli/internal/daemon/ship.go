package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// deployKey is the key projects are deployed with: the deploy key, else — on a machine set up before
// there was one — the provisioning key, if it was kept.
func deployKey() string {
	if k, err := state.Credential(state.DeployKey); err == nil && k != "" {
		return k
	}
	k, _ := state.Credential(state.AltengineKey)
	return k
}

type accessCheck struct {
	at     time.Time
	notice string
}

// accessTTL is how long an answer about the deploy key stands. A reload — which setting a key
// sends — forgets them all.
const accessTTL = 30 * time.Minute

// deployNotice checks, before any duty gets as far as deploying, that this machine's deploy key can
// deploy to every instance the board allows, and says what to fix when it cannot.
func (d *Daemon) deployNotice(ctx context.Context, v board.BoardView) string {
	if !deploysToAltengine(v) {
		return ""
	}
	targets := v.Profile.Deploy.Targets()
	key := deployKey()
	if key == "" {
		names := make([]string, len(targets))
		for i, t := range targets {
			names[i] = t.Describe()
		}
		return fmt.Sprintf("this board deploys to altengine (%s), and this machine has no deploy key — run `dutyboard --deploy-key` here", strings.Join(names, ", "))
	}
	client := altengine.New(d.opt.Config.Altengine, key)
	if client.Local() {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	var notices []string
	for _, t := range targets {
		id := hex.EncodeToString(sum[:8]) + "/" + t.Kind + "/" + t.Instance
		d.mu.Lock()
		c, ok := d.access[id]
		d.mu.Unlock()
		if !ok || time.Since(c.at) > accessTTL {
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := client.CanDeploy(cctx, t.Kind, t.Instance)
			cancel()
			c = accessCheck{at: time.Now()}
			if err != nil {
				c.notice = err.Error()
			}
			d.mu.Lock()
			d.access[id] = c
			d.mu.Unlock()
		}
		if c.notice != "" {
			notices = append(notices, c.notice)
		}
	}
	if len(notices) == 0 {
		return ""
	}
	return strings.Join(notices, "; ") + " — then run `dutyboard --deploy-key` if the key itself changes"
}

// deployRefused is a deploy the platform would not take from this machine's key. It is the machine
// owner's to fix, so the owner is told where they look, and the session is told how to park the duty
// so that answering it is the whole of what a person does afterwards.
func (d *Daemon) deployRefused(run *Run, instance, why string) error {
	d.mu.Lock()
	d.access = map[string]accessCheck{}
	d.mu.Unlock()
	d.reportSoon(run.Board)
	name := d.opt.Config.MachineName
	if name == "" {
		name = "this machine"
	}
	return fmt.Errorf("the runner could not deploy to %q with this machine's deploy key: %s. "+
		"Its owner has been told on the Machines page. Do not look for another way to deploy. Park this duty: duty_checkpoint with set_status \"needs_decision\" "+
		"and the question \"The work has landed but is not deployed: the deploy key on %s cannot deploy to %s. Fix the key's access (or run `dutyboard --deploy-key` there), then answer this to deploy.\" — and stop",
		instance, why, name, instance)
}

func deploysToAltengine(v board.BoardView) bool {
	return v.Profile != nil && v.Profile.Deploy.Method == "altengine" && len(v.Profile.Deploy.Targets()) > 0
}

// deploysAs says whether a board allows deploying as kind ("static" or "functions") at all.
func deploysAs(v board.BoardView, kind string) bool {
	if !deploysToAltengine(v) {
		return false
	}
	for _, t := range v.Profile.Deploy.Targets() {
		if t.Kind == "" || t.Kind == kind {
			return true
		}
	}
	return false
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
	kind := "static"
	if name == "altengine_deploy_function" {
		kind = "functions"
	}
	allowed := false
	var mayDeploy []string
	for _, t := range v.Profile.Deploy.Targets() {
		if t.Kind == "" || t.Kind == kind {
			mayDeploy = append(mayDeploy, t.Instance)
			if t.Instance == instance {
				allowed = true
			}
		}
	}
	if !allowed {
		return nil, fmt.Errorf("%q is not a %s instance this board may deploy to (it may deploy %s to: %s)", instance, kind, kind, strings.Join(mayDeploy, ", "))
	}
	key := deployKey()
	if key == "" {
		return nil, d.deployRefused(run, instance, "this machine has no altengine deploy key")
	}
	client := altengine.New(d.opt.Config.Altengine, key)

	// A path in the main worktree, or — absolute — in one of the duty's worktrees of the board's other
	// repositories.
	inWorktree := func(rel string) (string, error) {
		roots := []string{run.Worktree}
		for _, name := range run.openRepos() {
			if r, ok := findRepo(v, name); ok {
				roots = append(roots, d.wt.PathOf(d.repoSpec(ctx, run.Board, run.DutyID, r)))
			}
		}
		p := filepath.FromSlash(rel)
		if !filepath.IsAbs(p) {
			p = filepath.Join(run.Worktree, p)
		}
		for _, root := range roots {
			if within(p, root) {
				return p, nil
			}
		}
		return "", fmt.Errorf("%q is outside this duty's worktrees", rel)
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
		if altengine.IsStatus(err, 401) || altengine.IsStatus(err, 403) {
			return nil, d.deployRefused(run, instance, err.Error())
		}
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
		// nil: a board deploying its own project's function must not touch whatever schedules
		// that function has — they are the project's, not ours.
		res, err := client.DeployFunction(ctx, instance, fn, string(code), grants, nil)
		if altengine.IsStatus(err, 401) || altengine.IsStatus(err, 403) {
			return nil, d.deployRefused(run, instance, err.Error())
		}
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
