// Package provision takes a local altengine emulator to a working DutyBoard, for development and
// the smoke tests, and reads any DutyBoard's /health.
//
// A hosted DutyBoard is not provisioned from here any more. It is deployed and upgraded from its
// manifest, by whoever opens the deploy link, as themselves — see scripts/build-deploy.mjs and
// app.DeployLink. Nothing on a machine holds an altengine key to do it.
//
// The emulator keeps this path until it can deploy the manifest too; the instance names, grants,
// indexes and settings here are the manifest's, and must stay in step with it.
package provision

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/assets"
	"github.com/altlimit/dutyboard/cli/internal/ui"
)

// FunctionName is what the function is deployed as. Not `api`: hosted altengine reserves it.
const FunctionName = "board"

// Names are one deployment's instances.
type Names struct {
	Functions string `json:"functions"`
	Datastore string `json:"datastore"`
	Auth      string `json:"auth"`
	Channel   string `json:"channel"`
	Blob      string `json:"blob"`
	Search    string `json:"search"`
	Static    string `json:"static"`
	// Tasks holds the queue webhooks are delivered from. Empty when this altengine has no tasks
	// service: everything else works, and a token's webhook cannot be set.
	Tasks string `json:"tasks"`
}

// NamesFor is the naming convention a new deployment uses: `dutyboard`, `dutyboard-auth`, …
//
// The console gets a static site of its own, `<prefix>-console`, and is the whole of it. Not
// `<prefix>`: a static instance named like the product is the likeliest to be serving something
// else — dutyboard.com's own marketing site is one — and a console never shares a site.
func NamesFor(prefix string) Names {
	return Names{
		Functions: prefix,
		Datastore: prefix,
		Auth:      prefix + "-auth",
		Channel:   prefix + "-live",
		Blob:      prefix + "-files",
		Search:    prefix + "-search",
		Static:    prefix + "-console",
		Tasks:     prefix + "-tasks",
	}
}

// WebhookQueue is the queue a token's webhook deliveries wait on. Kept in step with WEBHOOK_QUEUE in
// functions/src/webhooks.js.
const WebhookQueue = "webhooks"

// PushHosts are the browsers' push services, which the function must reach to send a notification to
// a device with no console open — and nothing else. Kept in step with PUSH_HOSTS in
// functions/src/webpush.js.
var PushHosts = []string{"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"}

// Map is the names by service, as config.json keeps them.
func (n Names) Map() map[string]string {
	return map[string]string{
		"functions": n.Functions, "datastore": n.Datastore, "auth": n.Auth,
		"channel": n.Channel, "blob": n.Blob, "search": n.Search, "static": n.Static, "tasks": n.Tasks,
	}
}

// grants is the function's blast radius, and nothing wider — the grants it has always had: delete
// sits above write for the datastore and blob, and nothing here needs more than write on the rest.
func (n Names) grants() map[string]string {
	g := map[string]string{
		"datastore:" + n.Datastore: "full",
		"auth:" + n.Auth:           "write",
		"channel:" + n.Channel:     "write",
		"blob:" + n.Blob:           "full",
		"search:" + n.Search:       "full",
	}
	// Write is adding a task; the queue's settings are the provisioner's, not the function's.
	if n.Tasks != "" {
		g["tasks:"+n.Tasks] = "write"
	}
	return g
}

// preamble is the line deployed in front of the bundle that tells the function which instances are
// its own: the ones grants() names. It used to be env secrets, set only when the names were not the
// defaults — and hosted, secrets cannot be written with an API key, so every deployment not named
// `dutyboard` came up looking for `dutyboard-auth` and failed every signed-in call. Written into the
// code it travels with the grants, in the same request, and needs nothing from a person.
func (n Names) preamble() string {
	b, _ := json.Marshal(map[string]string{
		"datastore": n.Datastore, "auth": n.Auth, "channel": n.Channel, "blob": n.Blob, "search": n.Search,
	})
	return "globalThis.__DUTYBOARD_INSTANCES__ = " + string(b) + ";\n"
}

// Options configure one run.
type Options struct {
	Client *altengine.Client
	Assets *assets.Bundle
	UI     *ui.UI
	// Instance names the deployment (its functions instance); "" is `dutyboard`.
	Instance string
	// Origins are console origins to allow besides the dev server's.
	Origins []string
}

// Result is what a run leaves behind.
type Result struct {
	Org        string
	Names      Names
	APIURL     string // the function, e.g. https://k3x9-fn.altengine.app/board
	ConsoleURL string // e.g. https://k3x9.altengine.app/
	Version    string
	Created    bool // a new deployment rather than an existing one
}

// ErrHosted is the answer to provisioning anything but an emulator: a hosted DutyBoard is deployed
// from its manifest link instead.
var ErrHosted = errors.New("a hosted DutyBoard is deployed from its link, not provisioned from a machine")

// Run provisions or upgrades the DutyBoard on a local emulator.
func Run(ctx context.Context, o Options) (*Result, error) {
	if !o.Client.Local() {
		return nil, ErrHosted
	}
	return runLocal(ctx, o)
}

// HealthInfo is a DutyBoard function's /health.
type HealthInfo struct {
	OK         bool   `json:"ok"`
	Service    string `json:"service"`
	Version    string `json:"version"`
	Machines   bool   `json:"machines"`
	ConsoleURL string `json:"console_url"`
	// App is the deployment's name in altengine when it was deployed from the manifest: what an
	// upgrade link names, so it updates this deployment and no other. Empty for one provisioned.
	App string `json:"app"`
}

// Health reads a DutyBoard function's /health.
func Health(ctx context.Context, apiURL string) (*HealthInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(apiURL, "/")+"/health", nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s/health: %s", apiURL, res.Status)
	}
	var h HealthInfo
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return &h, json.Unmarshal(body, &h)
}

// ensureTasks makes the tasks instance webhooks are queued on, and answers its name — or "" when it
// cannot be had. Not in ensureInstances, because it is not required: an altengine without the
// service, or a key that may not create it, leaves a DutyBoard that works in every other way, so
// this warns rather than stopping the run.
func ensureTasks(ctx context.Context, c *altengine.Client, u *ui.UI, inv altengine.Inventory, name string) string {
	if _, ok := inv.Find("tasks", name); ok {
		u.Say("%-10s %s — already there", "tasks", name)
		return name
	}
	if err := c.CreateInstance(ctx, "tasks", name); err != nil {
		u.Warn("%-10s %s — not created (%v); token webhooks stay off until it exists", "tasks", name, err)
		return ""
	}
	u.OK("%-10s %s — created", "tasks", name)
	return name
}

// webhookQueue creates or updates the queue webhook deliveries wait on. It has no target of its own:
// each task names the URL of the token it is for, and the platform POSTs it there, signed with the
// tasks instance's secret. `ref` is how the control plane addresses the tasks instance: its name
// hosted, its id locally. Answers the instance's name when the queue is in place, else "".
//
// The retries are the queue's: ten attempts, from ten seconds apart to an hour, for at most a day.
// A receiver down longer than that has missed those events; /duty/changes still has them.
func webhookQueue(ctx context.Context, c *altengine.Client, u *ui.UI, n Names, ref string) string {
	if n.Tasks == "" {
		return ""
	}
	settings := map[string]any{
		"mode":            "push",
		"target":          nil,
		"retry":           map[string]any{"maxAttempts": 10, "minBackoffSeconds": 10, "maxBackoffSeconds": 3600, "maxAgeSeconds": 86400},
		"maxConcurrent":   10,
		"deadlineSeconds": 30,
	}
	err := c.EnsureQueue(ctx, ref, WebhookQueue, settings)
	if err != nil {
		// A platform that will not take a null target keeps whatever the queue had: every task names
		// its own, so a default is never used.
		delete(settings, "target")
		err = c.EnsureQueue(ctx, ref, WebhookQueue, settings)
	}
	if err != nil {
		// Making or changing a queue needs Full on instances, which nothing else here does. A queue an
		// earlier run made with such a key still delivers: an upgrade with a narrower key must not
		// turn webhooks off because it could not touch the queue's settings.
		if ok, lerr := c.HasQueue(ctx, ref, WebhookQueue); lerr == nil && ok {
			u.Warn("tasks queue %s/%s is there, but its settings could not be updated (%v) — token webhooks stay on as it is", n.Tasks, WebhookQueue, err)
			return n.Tasks
		}
		u.Warn("tasks queue %s/%s: %v — token webhooks stay off", n.Tasks, WebhookQueue, err)
		if strings.Contains(err.Error(), "PERMISSION_DENIED") {
			u.Say("Making the webhooks queue needs Full on the tasks instance %s — once; later upgrades can use Write.", n.Tasks)
		}
		return ""
	}
	u.OK("tasks queue %s/%s delivers token webhooks, signed with %s's secret", n.Tasks, WebhookQueue, n.Tasks)
	return n.Tasks
}

// recordWebhooks tells the function which tasks instance its queue is on, where it reads it
// (settings/webhooks): hosted, a function secret cannot be written with an API key. "" turns
// webhooks off.
func recordWebhooks(ctx context.Context, c *altengine.Client, u *ui.UI, n Names, tasks string) {
	if err := c.PutDocument(ctx, n.Datastore, "settings", "webhooks", map[string]any{"tasks_instance": tasks}); err != nil {
		u.Warn("could not record the webhook settings with the deployment (%v) — token webhooks stay off", err)
	}
}

// configureData applies datastore settings, channel presence and the declared indexes. `datastore`
// and `channel` are how the control plane addresses them: names hosted, ids locally.
func configureData(ctx context.Context, c *altengine.Client, u *ui.UI, a *assets.Bundle, n Names, datastore, channel string) error {
	if err := c.PatchConfig(ctx, "datastore", datastore, map[string]any{"autoId": "uuid", "autoIndex": true}); err != nil {
		return fmt.Errorf("datastore settings: %w", err)
	}
	// Presence is how the console knows a machine is online, and how a parked duty knows whether
	// the machine holding its worktree is still there to resume it.
	presence := map[string]any{"presence": true}
	if c.Local() {
		// No limit is null, as the hosted service spells it; an emulator refuses the 0 older ones took.
		presence = map[string]any{"presence": true, "publishRateLimit": nil, "connectRateLimit": nil}
	}
	if err := c.PatchConfig(ctx, "channel", channel, presence); err != nil {
		return fmt.Errorf("channel presence: %w", err)
	}
	u.OK("datastore settings, channel presence")

	var decl map[string]json.RawMessage
	if err := a.JSON("indexes.json", &decl); err != nil {
		return err
	}
	collections := sortedKeys(decl)
	count := 0
	for _, col := range collections {
		if strings.HasPrefix(col, "_") {
			continue
		}
		var specs []struct {
			Fields []string `json:"fields"`
			Unique bool     `json:"unique"`
		}
		if err := json.Unmarshal(decl[col], &specs); err != nil {
			return fmt.Errorf("indexes.json %s: %w", col, err)
		}
		for _, s := range specs {
			if err := c.CreateIndex(ctx, datastore, col, s.Fields, s.Unique); err != nil {
				return fmt.Errorf("index %s(%s): %w", col, strings.Join(s.Fields, ","), err)
			}
			count++
		}
	}
	u.OK("%d indexes declared on %s", count, n.Datastore)
	return nil
}

func deployFunction(ctx context.Context, c *altengine.Client, u *ui.UI, a *assets.Bundle, n Names) (string, error) {
	code, err := a.ReadFile("function/bundle.js")
	if err != nil {
		return "", err
	}
	d, err := c.DeployFunction(ctx, n.Functions, FunctionName, n.preamble()+string(code), n.grants(), schedules(), subRequests)
	if err != nil {
		return "", fmt.Errorf("deploying the function: %w", err)
	}
	fns, err := c.ListFunctions(ctx, n.Functions)
	if err != nil {
		return "", err
	}
	for _, f := range fns {
		if f.Name == FunctionName && f.URL != "" {
			u.OK("%s v%d (%d KiB) at %s", FunctionName, d.Version, d.SizeBytes/1024, f.URL)
			return strings.TrimRight(f.URL, "/"), nil
		}
	}
	return "", fmt.Errorf("deployed, but the functions listing does not say where %q answers", FunctionName)
}

// schedules is the function's own clock: the one thing on a board that has to happen when nobody
// is at a keyboard and no machine is awake. Recurring duties are filed by whichever tick reaches
// an occurrence first — this, or a machine's poll — and the occurrence can only be filed once, so
// having both is belt and braces rather than a duplicate.
//
// Every minute, because a person who asks for 9am means 9am. The run costs one indexed query that
// usually finds nothing.
func schedules() []string { return []string{"* * * * *"} }

// subRequests is how many calls one run of the board function may make to the services it is
// granted. The platform's default is 50, and a machine's poll asks a handful per board it works —
// so one working eight boards ran out part way and every poll failed. A machine works at most 25
// boards; this leaves the poll, and the clock's tick, room several times over.
const subRequests = 500

// verify waits for the function to report the version just deployed. Activation is not instant
// everywhere: hosted, the edge goes on answering from the previous version for a little while, so a
// single read straight after deploying can see the old one. It fails only if the new version never
// appears.
func verify(ctx context.Context, u *ui.UI, res *Result) error {
	u.Step("Checking it")
	deadline := time.Now().Add(verifyWithin)
	var last *HealthInfo
	var lastErr error
	for {
		h, err := Health(ctx, res.APIURL)
		last, lastErr = h, err
		if err == nil && h.Version == res.Version {
			if !h.Machines {
				return fmt.Errorf("the function answers but cannot pair machines — it is older than this program")
			}
			u.OK("DutyBoard v%s answers at %s", h.Version, res.APIURL)
			return nil
		}
		if time.Now().After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(verifyEvery):
		}
	}
	if lastErr != nil {
		return fmt.Errorf("the function does not answer /health: %w", lastErr)
	}
	return fmt.Errorf("the function still reports v%s, not v%s, after %s — the deploy did not take", last.Version, res.Version, verifyWithin)
}

// How long verify waits for a new version to be served, and how often it asks. Variables, so a test
// can shorten them.
var (
	verifyWithin = 90 * time.Second
	verifyEvery  = 3 * time.Second
)

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
