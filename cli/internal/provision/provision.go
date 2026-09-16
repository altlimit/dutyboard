// Package provision takes an altengine organization — or a local emulator — to a working DutyBoard,
// or finds the one already there and brings it up to this version.
//
// Every step is idempotent, so provisioning and upgrading are the same run: an instance that exists
// is left alone, an index that exists is not duplicated, and the function and console are simply
// deployed again. What an API key cannot do on the hosted platform (older platforms refuse to
// create auth and channel instances, whose signing secrets are the service's to mint) is printed as
// a checklist, and the run waits and re-checks rather than exiting with "run this again".
package provision

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	}
}

// retiredOrigins are origins no console is served from any more, taken off a deployment's CORS and
// auth lists when it gets a console of its own. dutyboard.com is only a marketing site: allowing it
// would let a page there call a deployment it has no business reaching.
var retiredOrigins = []string{"https://www.dutyboard.com", "https://dutyboard.com"}

// PushHosts are the browsers' push services, which the function must reach to send a notification to
// a device with no console open — and nothing else. Kept in step with PUSH_HOSTS in
// functions/src/webpush.js.
var PushHosts = []string{"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"}

// Map is the names by service, as config.json keeps them.
func (n Names) Map() map[string]string {
	return map[string]string{
		"functions": n.Functions, "datastore": n.Datastore, "auth": n.Auth,
		"channel": n.Channel, "blob": n.Blob, "search": n.Search, "static": n.Static,
	}
}

// grants is the function's blast radius, and nothing wider — the grants it has always had: delete
// sits above write for the datastore and blob, and nothing here needs more than write on the rest.
func (n Names) grants() map[string]string {
	return map[string]string{
		"datastore:" + n.Datastore: "full",
		"auth:" + n.Auth:           "write",
		"channel:" + n.Channel:     "write",
		"blob:" + n.Blob:           "full",
		"search:" + n.Search:       "full",
	}
}

// secrets are the env overrides the deployed function needs to find instances that are not named
// the way its defaults assume.
func (n Names) secrets() map[string]string {
	d := NamesFor("dutyboard")
	out := map[string]string{}
	add := func(key, have, want string) {
		if have != want {
			out[key] = have
		}
	}
	add("DUTYBOARD_DATASTORE", n.Datastore, d.Datastore)
	add("DUTYBOARD_AUTH", n.Auth, d.Auth)
	add("DUTYBOARD_CHANNEL", n.Channel, d.Channel)
	add("DUTYBOARD_BLOB", n.Blob, d.Blob)
	add("DUTYBOARD_SEARCH", n.Search, d.Search)
	return out
}

// Options configure one run.
type Options struct {
	Client *altengine.Client
	Assets *assets.Bundle
	UI     *ui.UI
	// Instance picks a deployment (by its functions instance) or names a new one, instead of asking.
	Instance string
	// Origins are console origins to allow besides the deployed console's own — the dev server's,
	// locally.
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

// Deployment is a DutyBoard already running in the organization.
type Deployment struct {
	Names   Names
	URL     string
	Version string
	// ConsoleURL is where its function says the console was last published, if it says.
	ConsoleURL string
}

// Run provisions or upgrades.
func Run(ctx context.Context, o Options) (*Result, error) {
	if o.Client.Local() {
		return runLocal(ctx, o)
	}
	return runHosted(ctx, o)
}

func runHosted(ctx context.Context, o Options) (*Result, error) {
	c, u := o.Client, o.UI
	u.Step("Checking the altengine key")
	who, err := c.Whoami(ctx)
	if err != nil {
		return nil, err
	}
	u.OK("organization %q", who.Org.Name)

	inv, err := c.ListInstances(ctx)
	if err != nil {
		return nil, err
	}
	found := Detect(ctx, c, inv)
	names, existing, err := choose(u, inv, found, o.Instance)
	if err != nil {
		return nil, err
	}
	res := &Result{Org: who.Org.Name, Names: names, Version: o.Assets.Version, Created: existing == nil}
	if existing != nil {
		// A deployment made before consoles had a site of their own published it under /app on the
		// static instance named like its functions instance. That site is kept, so its URL does not
		// change; the console just moves to its root.
		if _, ok := inv.Find("static", names.Functions); ok {
			if deployed, label, err := c.StaticLive(ctx, names.Functions); err == nil && deployed && strings.HasPrefix(label, consoleLabel) {
				names.Static, res.Names.Static = names.Functions, names.Functions
			}
		}
	}

	u.Step("Instances")
	_, staticExisted := inv.Find("static", names.Static)
	if inv, err = ensureInstances(ctx, c, u, inv, names); err != nil {
		return nil, err
	}

	u.Step("Configuration")
	if err := configureData(ctx, c, u, o.Assets, names, names.Datastore, names.Channel); err != nil {
		return nil, err
	}
	var access map[string]any
	if err := o.Assets.JSON("access.json", &access); err != nil {
		return nil, err
	}
	if err := c.SetAuthRules(ctx, names.Auth, map[string]any{"datastore:" + names.Datastore: access["datastore:dutyboard"]}); err != nil {
		return nil, fmt.Errorf("applying the access rules: %w", err)
	}
	u.OK("access rules on %s", names.Auth)

	u.Step("Function")
	if res.APIURL, err = deployFunction(ctx, c, u, o.Assets, names); err != nil {
		return nil, err
	}

	u.Step("Console")
	manual := false
	authID := ""
	if i, ok := inv.Find("auth", names.Auth); ok {
		authID = i.ID
	}
	live, err := "", error(nil)
	if reason := consoleBlocked(ctx, c, names.Static, staticExisted); reason != "" {
		err = errConsoleSkipped
		u.Warn("not publishing the console to static %q: %s", names.Static, reason)
		u.Say("  Serve the console yourself: build app/ and publish app/dist with a config.js (see README).")
	} else {
		live, err = deployConsole(ctx, c, o.Assets, names, authID, res.APIURL)
	}
	switch {
	case errors.Is(err, errConsoleSkipped):
	case errors.Is(err, altengine.ErrNoStatic):
		u.Warn("this altengine does not host static sites — serve the console yourself (see README)")
	case err != nil:
		return nil, err
	default:
		res.ConsoleURL = live + "/"
		u.OK("console live at %s", res.ConsoleURL)
	}

	origins := append([]string{}, o.Origins...)
	var drop []string
	if res.ConsoleURL != "" {
		origins = append(origins, originOf(res.ConsoleURL))
		// Only once the new console is up: dropping the old origins first could leave nothing that
		// signs in.
		drop = append(drop, retiredOrigins...)
		if existing != nil && existing.ConsoleURL != "" {
			drop = append(drop, originOf(existing.ConsoleURL))
		}
		// The static site named like the deployment, when it is not this console, is dutyboard.com's
		// own or another site that is no console of this deployment's: its altengine address goes too.
		if names.Static != names.Functions {
			if i, ok := inv.Find("static", names.Functions); ok && i.Slug != "" {
				drop = append(drop, "https://"+i.Slug+"-web.altengine.app")
			}
		}
	}
	if err := allowOrigins(ctx, c, u, names, origins, drop, existing == nil, o.Assets); err != nil {
		return nil, err
	}
	if res.ConsoleURL != "" {
		// Kept in the deployment's own datastore rather than as a function secret: hosted, secrets
		// are only written from a signed-in altengine console, never with an API key. /health reads it
		// back, which is how a machine being paired says where to approve it.
		if err := c.PutDocument(ctx, names.Datastore, "settings", "deployment", map[string]any{"console_url": res.ConsoleURL}); err != nil {
			u.Warn("could not record the console's address with the deployment (%v)", err)
		} else {
			u.OK("console address recorded with the deployment")
		}
	}
	if secrets := names.secrets(); len(secrets) > 0 {
		if err := c.SetFunctionSecrets(ctx, names.Functions, secrets); err != nil {
			u.Warn("could not set the function's secrets (%v) — this altengine only takes them in its console", err)
			u.Say("  In the altengine console, on functions instance %q → Secrets, add these with exposure env:", names.Functions)
			for _, k := range sortedKeys(secrets) {
				u.Say("    %s = %s", k, secrets[k])
			}
			manual = true
		} else {
			u.OK("function secrets: %s", strings.Join(sortedKeys(secrets), ", "))
		}
	}

	if err := verify(ctx, u, res); err != nil {
		return res, err
	}
	if manual {
		u.Warn("the function cannot find its instances until those secrets are set")
	}
	return res, nil
}

// Detect finds every DutyBoard in the organization: a function named `board` whose /health says so.
// Its grants name the instances it actually uses, whatever they are called.
func Detect(ctx context.Context, c *altengine.Client, inv altengine.Inventory) []Deployment {
	var out []Deployment
	for _, fi := range inv["functions"] {
		fns, err := c.ListFunctions(ctx, fi.Name)
		if err != nil {
			continue
		}
		for _, f := range fns {
			if f.Name != FunctionName || f.URL == "" {
				continue
			}
			h, err := Health(ctx, f.URL)
			if err != nil || h.Service != "dutyboard" {
				continue
			}
			n := NamesFor(fi.Name)
			for grant := range f.Grants {
				service, name, _ := strings.Cut(grant, ":")
				switch service {
				case "datastore":
					n.Datastore = name
				case "auth":
					n.Auth = name
				case "channel":
					n.Channel = name
				case "blob":
					n.Blob = name
				case "search":
					n.Search = name
				}
			}
			out = append(out, Deployment{Names: n, URL: f.URL, Version: h.Version, ConsoleURL: h.ConsoleURL})
		}
	}
	return out
}

// HealthInfo is a DutyBoard function's /health.
type HealthInfo struct {
	OK         bool   `json:"ok"`
	Service    string `json:"service"`
	Version    string `json:"version"`
	Machines   bool   `json:"machines"`
	ConsoleURL string `json:"console_url"`
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

func choose(u *ui.UI, inv altengine.Inventory, found []Deployment, instance string) (Names, *Deployment, error) {
	if instance != "" {
		for i := range found {
			if found[i].Names.Functions == instance {
				u.Say("using the DutyBoard on functions instance %q (v%s)", instance, found[i].Version)
				return found[i].Names, &found[i], nil
			}
		}
		return NamesFor(instance), nil, nil
	}
	if len(found) > 0 {
		opts := make([]string, 0, len(found)+1)
		for _, d := range found {
			opts = append(opts, fmt.Sprintf("Use %s (v%s at %s)", d.Names.Functions, d.Version, d.URL))
		}
		opts = append(opts, "Provision a new DutyBoard")
		u.Step("Found %d DutyBoard deployment(s)", len(found))
		pick, err := u.Choose("Which one?", opts, 0)
		if err != nil {
			return Names{}, nil, err
		}
		if pick < len(found) {
			return found[pick].Names, &found[pick], nil
		}
	}
	prefix, err := u.Ask("Name for the new deployment's instances", freePrefix(inv))
	if err != nil {
		return Names{}, nil, err
	}
	return NamesFor(prefix), nil, nil
}

// freePrefix is `dutyboard`, or the first `dutyboard-N` none of whose instances exist yet.
func freePrefix(inv altengine.Inventory) string {
	for n := 1; ; n++ {
		p := "dutyboard"
		if n > 1 {
			p = fmt.Sprintf("dutyboard-%d", n)
		}
		taken := false
		for service, name := range NamesFor(p).Map() {
			if _, ok := inv.Find(service, name); ok {
				taken = true
			}
		}
		if !taken {
			return p
		}
	}
}

func ensureInstances(ctx context.Context, c *altengine.Client, u *ui.UI, inv altengine.Inventory, n Names) (altengine.Inventory, error) {
	order := []struct{ service, name string }{
		{"auth", n.Auth}, {"channel", n.Channel}, {"datastore", n.Datastore}, {"functions", n.Functions},
		{"blob", n.Blob}, {"search", n.Search}, {"static", n.Static},
	}
	var manual []string
	for _, want := range order {
		if _, ok := inv.Find(want.service, want.name); ok {
			u.Say("%-10s %s — already there", want.service, want.name)
			continue
		}
		err := c.CreateInstance(ctx, want.service, want.name)
		if errors.Is(err, altengine.ErrConsoleOnly) {
			manual = append(manual, fmt.Sprintf("create the %s instance %q", want.service, want.name))
			u.Warn("%-10s %s — this altengine only creates it in the console", want.service, want.name)
			continue
		}
		if err != nil {
			return nil, err
		}
		u.OK("%-10s %s — created", want.service, want.name)
	}
	refreshed, err := c.ListInstances(ctx)
	if err != nil {
		return nil, err
	}
	if len(manual) == 0 {
		return refreshed, nil
	}

	u.Say("")
	u.Say("Left to do in the altengine console (https://console.altengine.net):")
	for _, m := range manual {
		u.Say("  • %s", m)
	}
	if !u.Interactive {
		return nil, fmt.Errorf("%d instance(s) must be created in the console first; run this again afterwards", len(manual))
	}
	u.Note("waiting for them — this re-checks every 5 seconds (Ctrl+C to stop)")
	for {
		missing := 0
		for _, want := range order {
			if _, ok := refreshed.Find(want.service, want.name); !ok {
				missing++
			}
		}
		if missing == 0 {
			u.OK("all instances are there")
			return refreshed, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Second):
		}
		if refreshed, err = c.ListInstances(ctx); err != nil {
			return nil, err
		}
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
		presence = map[string]any{"presence": true, "publishRateLimit": 0, "connectRateLimit": 0}
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
	d, err := c.DeployFunction(ctx, n.Functions, FunctionName, string(code), n.grants(), schedules())
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

var errConsoleSkipped = errors.New("console not published")

// consoleLabel prefixes every deployment the provisioner publishes, which is how it later tells its
// own site from someone else's.
const consoleLabel = "dutyboard v"

// consoleBlocked says why the console must not be published to this static instance, or "" when it
// may. A static deploy REPLACES the whole site, and a static instance named like a DutyBoard can be
// serving much more than the console — dutyboard.com's own instance serves the marketing site too.
// So an instance that already existed is only written to when what it serves now was published by
// this program, or when it serves nothing at all.
func consoleBlocked(ctx context.Context, c *altengine.Client, instance string, existed bool) string {
	if !existed {
		return ""
	}
	deployed, message, err := c.StaticLive(ctx, instance)
	switch {
	case err != nil:
		return fmt.Sprintf("could not read what it is serving (%v)", err)
	case !deployed:
		return ""
	case strings.HasPrefix(message, consoleLabel):
		return ""
	default:
		return fmt.Sprintf("it serves a site this program did not publish (%q)", message)
	}
}

// ConsoleConfig is the site's /config.js: where this console points. See app/src/config.js.
func ConsoleConfig(altengineURL string, n Names, authID, apiURL string) []byte {
	cfg := map[string]string{
		"baseUrl":   altengineURL,
		"auth":      authID,
		"datastore": n.Datastore,
		"channel":   n.Channel,
		"functions": n.Functions,
		"api":       apiURL,
		"fn":        FunctionName,
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return []byte("// Written by the dutyboard provisioner: where this console points.\nwindow.DUTYBOARD_CONFIG = " + string(b) + ";\n")
}

func deployConsole(ctx context.Context, c *altengine.Client, a *assets.Bundle, n Names, authID, apiURL string) (string, error) {
	if authID == "" {
		// Hosted sign-in carries no key, so the console addresses auth by id; a name would 404.
		return "", fmt.Errorf("could not find the id of auth instance %q", n.Auth)
	}
	files, err := altengine.FilesUnder(a.FS(), "console", "")
	if err != nil {
		return "", fmt.Errorf("reading the console: %w", err)
	}
	out := files[:0]
	for _, f := range files {
		if f.Path != "/config.js" {
			out = append(out, f)
		}
	}
	out = append(out, altengine.StaticFile{Path: "/config.js", Data: ConsoleConfig(c.BaseURL, n, authID, apiURL)})
	if b, err := a.ReadFile("agent.md"); err == nil {
		out = append(out, altengine.StaticFile{Path: "/agent.md", Data: b})
	}
	// Consoles used to live under /app, and links to them — a bookmark, a pairing link — carry the
	// route after the #. Send those to the same route at the root.
	out = append(out, altengine.StaticFile{
		Path: "/app/index.html",
		Data: []byte(`<!doctype html><meta charset="utf-8"><title>DutyBoard</title><script>location.replace("../" + location.hash)</script><a href="../">DutyBoard</a>`),
	})
	url, _, err := c.DeployStatic(ctx, n.Static, consoleLabel+a.Version, out)
	return url, err
}

// allowOrigins adds the console's origins to the function's CORS list and the auth instance's
// allowed origins, keeping whatever was already there, and makes sure the sign-up form collects the
// name every duty is stamped with.
//
// drop are origins to take off both lists — ones no console is served from any more — unless they
// are also being added.
func allowOrigins(ctx context.Context, c *altengine.Client, u *ui.UI, n Names, origins, drop []string, fresh bool, a *assets.Bundle) error {
	if len(origins) == 0 {
		return nil
	}
	fnCfg, err := c.GetConfig(ctx, "functions", n.Functions)
	if err != nil {
		return err
	}
	have := stringList(fnCfg["corsOrigins"])
	cors := mergeStrings(without(have, drop, origins), origins)
	for _, gone := range removed(have, cors) {
		u.OK("function CORS: removed %s, which serves no console", gone)
	}
	hosts := mergeStrings(stringList(fnCfg["allowedHosts"]), PushHosts)
	if err := c.SetFunctionSettings(ctx, n.Functions, cors, hosts); err != nil {
		return fmt.Errorf("function CORS: %w", err)
	}
	u.OK("function CORS: %s", strings.Join(cors, ", "))
	u.OK("function may reach: %s (push notifications)", strings.Join(hosts, ", "))

	var signup map[string]any
	if err := a.JSON("signup.json", &signup); err != nil {
		return err
	}
	authCfg, err := c.GetConfig(ctx, "auth", n.Auth)
	if err != nil {
		return err
	}
	settings, _ := authCfg["settings"].(map[string]any)
	if settings == nil {
		settings = map[string]any{}
	}
	authOrigins := mergeStrings(without(stringList(settings["allowedOrigins"]), drop, origins), origins)
	settings["allowedOrigins"] = authOrigins
	changes := map[string]any{"settings": settings}
	if fresh {
		// A new deployment has no accounts, and the first person to sign up becomes the first owner.
		// An existing one keeps whatever its owner decided about sign-up.
		settings["allowSignup"] = true
		changes["signup"] = signup
	}
	if err := c.PatchConfig(ctx, "auth", n.Auth, changes); err != nil {
		u.Warn("could not update auth %q (%v)", n.Auth, err)
		u.Say("  In the altengine console, on auth %q: add %s to its allowed origins,", n.Auth, strings.Join(origins, ", "))
		u.Say("  and make its sign-up form collect the fields in backend/signup.json (email and name).")
		return nil
	}
	if settings["allowSignup"] == false {
		u.Warn("sign-up is off on %q — only existing accounts can sign in", n.Auth)
	}
	u.OK("auth origins: %s", strings.Join(authOrigins, ", "))
	return nil
}

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

func originOf(raw string) string {
	p, err := url.Parse(raw)
	if err != nil {
		return strings.TrimRight(raw, "/")
	}
	return p.Scheme + "://" + p.Host
}

func stringList(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// without is have less anything in drop, except what keep names.
func without(have, drop, keep []string) []string {
	out := []string{}
	for _, s := range have {
		gone := false
		for _, d := range drop {
			gone = gone || s == d
		}
		for _, k := range keep {
			gone = gone && s != k
		}
		if !gone {
			out = append(out, s)
		}
	}
	return out
}

// removed is what was in before and is not in after.
func removed(before, after []string) []string {
	var out []string
	for _, b := range before {
		found := false
		for _, a := range after {
			found = found || a == b
		}
		if !found {
			out = append(out, b)
		}
	}
	return out
}

func mergeStrings(have, add []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range append(have, add...) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
