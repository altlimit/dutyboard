package provision

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/assets"
	"github.com/altlimit/dutyboard/cli/internal/ui"
)

// fakeHosted is a hosted altengine as far as the provisioner can tell: MCP control tools, the /v1
// data plane, presigned uploads and a function that answers /health. It records what it was asked,
// so a test can assert on the platform's end state rather than on the provisioner's log.
type fakeHosted struct {
	mu          sync.Mutex
	srv         *httptest.Server
	inv         altengine.Inventory
	consoleOnly map[string]bool
	configs     map[string]map[string]any // "service/instance" → config
	rules       map[string]any
	indexes     int
	functions   map[string]map[string]string // instance → grants of its board function
	deployed    map[string]int
	secrets     map[string]map[string]any // instance → name → {value?, egress}
	uploads     map[string][]byte
	manifest    map[string]string // path → hash
	version     string
	liveLabels  map[string]string         // static instance → the message of its live deployment
	staticSites map[string]int            // static instance → deployments made to it
	documents   map[string]map[string]any // "datastore/collection/key" → data
	noSecrets   bool                      // secrets are console-only, as on hosted altengine
}

func newFake(t *testing.T, version string) *fakeHosted {
	f := &fakeHosted{
		inv:         altengine.Inventory{},
		consoleOnly: map[string]bool{},
		configs:     map[string]map[string]any{},
		functions:   map[string]map[string]string{},
		deployed:    map[string]int{},
		secrets:     map[string]map[string]any{},
		uploads:     map[string][]byte{},
		liveLabels:  map[string]string{},
		staticSites: map[string]int{},
		documents:   map[string]map[string]any{},
		version:     version,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHosted) add(service, name string) {
	f.inv[service] = append(f.inv[service], altengine.Instance{ID: "id-" + service + "-" + name, Name: name})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func toolOK(w http.ResponseWriter, id any, result any) {
	b, _ := json.Marshal(result)
	writeJSON(w, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": string(b)}}, "structuredContent": result,
	}})
}

func toolErr(w http.ResponseWriter, id any, msg string) {
	writeJSON(w, map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": msg}}, "isError": true,
	}})
}

func (f *fakeHosted) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	p := r.URL.Path
	switch {
	case p == "/mcp":
		var msg struct {
			ID     any `json:"id"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &msg)
		a := msg.Params.Arguments
		str := func(k string) string { s, _ := a[k].(string); return s }
		switch msg.Params.Name {
		case "whoami":
			toolOK(w, msg.ID, map[string]any{"org": map[string]any{"name": "acme"}})
		case "list_instances":
			toolOK(w, msg.ID, f.inv)
		case "create_instance":
			if f.consoleOnly[str("service")] {
				toolErr(w, msg.ID, "INVALID_ARGUMENT: "+str("service")+" instances must be created in the console")
				return
			}
			f.add(str("service"), str("name"))
			toolOK(w, msg.ID, map[string]any{"ok": true})
		case "patch_instance_config":
			key := str("service") + "/" + str("instance")
			if f.configs[key] == nil {
				f.configs[key] = map[string]any{}
			}
			for k, v := range a["changes"].(map[string]any) {
				f.configs[key][k] = v
			}
			toolOK(w, msg.ID, map[string]any{"changed": true})
		case "get_instance_config":
			cfg := f.configs[str("service")+"/"+str("instance")]
			if cfg == nil {
				cfg = map[string]any{}
			}
			toolOK(w, msg.ID, map[string]any{"config": cfg})
		case "static_list_deployments":
			list := []any{}
			if label := f.liveLabels[fmt.Sprint(a["instance"])]; label != "" {
				list = append(list, map[string]any{"id": "dep0", "message": label, "live": true})
			}
			toolOK(w, msg.ID, map[string]any{"deployments": list})
		case "auth_set_rules":
			f.rules = a["access"].(map[string]any)
			toolOK(w, msg.ID, map[string]any{"ok": true})
		default:
			toolErr(w, msg.ID, "unknown tool "+msg.Params.Name)
		}
	case strings.HasPrefix(p, "/v1/datastore/") && strings.HasSuffix(p, "/documents"):
		parts := strings.Split(p, "/") // "" v1 datastore <ds> ns _default col <col> documents
		var req struct {
			Documents []struct {
				Key  string         `json:"key"`
				Data map[string]any `json:"data"`
			} `json:"documents"`
		}
		_ = json.Unmarshal(body, &req)
		for _, d := range req.Documents {
			f.documents[parts[3]+"/"+parts[7]+"/"+d.Key] = d.Data
		}
		writeJSON(w, map[string]any{"keys": []string{}})
	case f.noSecrets && strings.HasPrefix(p, "/v1/functions/") && strings.HasSuffix(p, "/secrets"):
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error":{"code":"NOT_FOUND","message":"no such data-plane endpoint"}}`)
	case strings.HasPrefix(p, "/v1/datastore/") && strings.HasSuffix(p, "/indexes"):
		f.indexes++
		writeJSON(w, map[string]any{"ok": true})
	case strings.HasPrefix(p, "/v1/functions/") && strings.HasSuffix(p, "/deploy"):
		inst := strings.Split(p, "/")[3]
		var req struct {
			Grants map[string]string `json:"grants"`
		}
		_ = json.Unmarshal(body, &req)
		f.functions[inst] = req.Grants
		f.deployed[inst]++
		writeJSON(w, map[string]any{"version": f.deployed[inst], "size_bytes": 1234})
	case strings.HasPrefix(p, "/v1/functions/") && strings.HasSuffix(p, "/secrets"):
		inst := strings.Split(p, "/")[3]
		if r.Method == http.MethodGet {
			list := []any{}
			for name, s := range f.secrets[inst] {
				list = append(list, map[string]any{"name": name, "egress": s.(map[string]any)["egress"]})
			}
			writeJSON(w, map[string]any{"secrets": list})
			return
		}
		next := map[string]any{}
		_ = json.Unmarshal(body, &next)
		for name, raw := range next {
			entry := raw.(map[string]any)
			if _, has := entry["value"]; !has {
				// No value means keep the stored one — the contract SetFunctionSecrets relies on.
				entry["value"] = f.secrets[inst][name].(map[string]any)["value"]
			}
		}
		f.secrets[inst] = next
		writeJSON(w, map[string]any{"ok": true})
	case strings.HasPrefix(p, "/v1/functions/"):
		inst := strings.Split(p, "/")[3]
		fns := []any{}
		if g, ok := f.functions[inst]; ok {
			fns = append(fns, map[string]any{"name": "board", "url": f.srv.URL + "/fnhost/" + inst + "/board", "grants": g})
		}
		writeJSON(w, map[string]any{"functions": fns})
	case strings.HasPrefix(p, "/fnhost/") && strings.HasSuffix(p, "/health"):
		writeJSON(w, map[string]any{"ok": true, "service": "dutyboard", "version": f.version, "machines": true})
	case strings.HasPrefix(p, "/v1/static/") && strings.HasSuffix(p, "/deployments"):
		var req struct {
			Files map[string]struct {
				Hash string `json:"hash"`
			} `json:"files"`
		}
		_ = json.Unmarshal(body, &req)
		f.staticSites[strings.Split(p, "/")[3]]++
		f.manifest = map[string]string{}
		uploads := []any{}
		for path, file := range req.Files {
			f.manifest[path] = file.Hash
			uploads = append(uploads, map[string]any{"path_hash": file.Hash, "upload_url": f.srv.URL + "/upload/" + file.Hash, "method": "PUT"})
		}
		writeJSON(w, map[string]any{"deployment_id": "dep1", "uploads": uploads, "cursor": ""})
	case strings.HasPrefix(p, "/v1/static/") && strings.HasSuffix(p, "/activate"):
		writeJSON(w, map[string]any{"url": f.srv.URL + "/site/"})
	case strings.HasPrefix(p, "/upload/"):
		f.uploads[strings.TrimPrefix(p, "/upload/")] = body
		w.WriteHeader(http.StatusOK)
	default:
		http.Error(w, "no route "+p, http.StatusNotFound)
	}
}

func (f *fakeHosted) file(t *testing.T, path string) string {
	t.Helper()
	hash, ok := f.manifest[path]
	if !ok {
		t.Fatalf("%s was not in the static deployment", path)
	}
	return string(f.uploads[hash])
}

func testAssets(t *testing.T, version string) *assets.Bundle {
	t.Helper()
	dir := t.TempDir()
	repo := filepath.Join("..", "..", "..")
	files := map[string]string{
		"VERSION":            version,
		"function/bundle.js": "export default { fetch() {} }",
		"console/index.html": "<!doctype html><script src=\"config.js\"></script>",
		"console/config.js":  "window.DUTYBOARD_CONFIG = null;",
		"agent.md":           "# Working from DutyBoard",
	}
	for _, name := range []string{"indexes.json", "access.json", "signup.json"} {
		b, err := os.ReadFile(filepath.Join(repo, "backend", name))
		if err != nil {
			t.Fatal(err)
		}
		files["backend/"+name] = string(b)
	}
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := assets.FromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func hosted(url string) *altengine.Client {
	c := altengine.New(url, "ak_test")
	c.Hosted = true
	return c
}

func quietUI() *ui.UI { return &ui.UI{Out: &bytes.Buffer{}} }

func TestHostedFromNothing(t *testing.T) {
	f := newFake(t, "9.9.9")
	f.add("functions", "unrelated")
	f.secrets["dutyboard"] = map[string]any{"OTHER": map[string]any{"value": "keep me", "egress": true}}

	res, err := Run(context.Background(), Options{
		Client: hosted(f.srv.URL),
		Assets: testAssets(t, "9.9.9"),
		UI:     quietUI(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Names != NamesFor("dutyboard") || res.Names.Static != "dutyboard-console" {
		t.Fatalf("expected a new deployment named dutyboard, got %+v", res)
	}
	for service, name := range NamesFor("dutyboard").Map() {
		if _, ok := f.inv.Find(service, name); !ok {
			t.Errorf("%s instance %q was not created", service, name)
		}
	}
	if f.indexes == 0 {
		t.Error("no indexes were declared")
	}
	if f.functions["dutyboard"]["datastore:dutyboard"] != "full" || f.functions["dutyboard"]["auth:dutyboard-auth"] != "write" {
		t.Errorf("function grants are wrong: %v", f.functions["dutyboard"])
	}
	if _, ok := f.rules["datastore:dutyboard"]; !ok {
		t.Errorf("access rules were not applied for the datastore: %v", f.rules)
	}
	if f.configs["channel/dutyboard-live"]["presence"] != true {
		t.Error("channel presence was not turned on")
	}

	cfg := f.file(t, "/config.js")
	if !strings.Contains(cfg, `"auth": "id-auth-dutyboard-auth"`) || !strings.Contains(cfg, `"api": "`+res.APIURL+`"`) {
		t.Errorf("console config does not point at this deployment:\n%s", cfg)
	}
	if strings.Contains(cfg, "= null") {
		t.Error("the build's placeholder config.js was deployed instead of the generated one")
	}
	if f.file(t, "/agent.md") == "" {
		t.Error("agent.md was not published")
	}

	if res.ConsoleURL != f.srv.URL+"/site/" {
		t.Errorf("console URL = %q", res.ConsoleURL)
	}
	if b, _ := json.Marshal(f.configs["functions/dutyboard"]["allowedHosts"]); !strings.Contains(string(b), "fcm.googleapis.com") || !strings.Contains(string(b), "web.push.apple.com") {
		t.Errorf("the function cannot reach the push services: %s", b)
	}
	cors := f.configs["functions/dutyboard"]["corsOrigins"]
	if b, _ := json.Marshal(cors); !strings.Contains(string(b), f.srv.URL) {
		t.Errorf("the console's origin is not in the function's CORS list: %s", b)
	}
	auth := f.configs["auth/dutyboard-auth"]
	if auth["settings"].(map[string]any)["allowSignup"] != true || auth["signup"] == nil {
		t.Errorf("a fresh deployment should open sign-up and set the sign-up form: %v", auth)
	}

	secrets := f.secrets["dutyboard"]
	if secrets["OTHER"].(map[string]any)["value"] != "keep me" {
		t.Errorf("an existing secret was lost: %v", secrets)
	}
	if got := f.documents["dutyboard/settings/deployment"]["console_url"]; got != res.ConsoleURL {
		t.Errorf("the console's address was not recorded with the deployment: %v", f.documents)
	}
	if _, ok := secrets["DUTYBOARD_DATASTORE"]; ok {
		t.Error("default instance names should not need override secrets")
	}
}

func TestHostedUpgradesWhatIsThere(t *testing.T) {
	f := newFake(t, "9.9.9")
	for service, name := range map[string]string{
		"functions": "board-prod", "datastore": "custom-ds", "auth": "custom-auth", "channel": "custom-live",
		"blob": "custom-files", "search": "custom-search", "static": "board-prod",
	} {
		f.add(service, name)
	}
	f.functions["board-prod"] = map[string]string{
		"datastore:custom-ds": "full", "auth:custom-auth": "write", "channel:custom-live": "write",
		"blob:custom-files": "full", "search:custom-search": "full",
	}
	f.configs["auth/custom-auth"] = map[string]any{"settings": map[string]any{"allowSignup": false, "allowedOrigins": []any{"https://old.example"}}}
	f.configs["functions/board-prod"] = map[string]any{"corsOrigins": []any{"https://old.example"}}

	c := hosted(f.srv.URL)
	found := Detect(context.Background(), c, f.inv)
	if len(found) != 1 || found[0].Names.Datastore != "custom-ds" {
		t.Fatalf("detection should read instance names from the grants, got %+v", found)
	}

	res, err := Run(context.Background(), Options{Client: c, Assets: testAssets(t, "9.9.9"), UI: quietUI(), Instance: "board-prod"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Created {
		t.Error("an existing deployment was treated as new")
	}
	if _, ok := f.inv.Find("datastore", "board-prod"); ok {
		t.Error("a datastore was created under the functions name instead of using the one it has")
	}
	auth := f.configs["auth/custom-auth"]
	settings := auth["settings"].(map[string]any)
	if settings["allowSignup"] != false {
		t.Error("an existing deployment's sign-up setting was changed")
	}
	if b, _ := json.Marshal(settings["allowedOrigins"]); !strings.Contains(string(b), "https://old.example") || !strings.Contains(string(b), f.srv.URL) {
		t.Errorf("auth origins should keep the old one and add the console's: %s", b)
	}
	if b, _ := json.Marshal(f.configs["functions/board-prod"]["corsOrigins"]); !strings.Contains(string(b), "https://old.example") {
		t.Errorf("CORS lost an existing origin: %s", b)
	}
	if f.secrets["board-prod"]["DUTYBOARD_DATASTORE"].(map[string]any)["value"] != "custom-ds" {
		t.Errorf("the function needs to be told its non-default datastore: %v", f.secrets["board-prod"])
	}
}

func TestHostedCarriesOnWhenSecretsAreConsoleOnly(t *testing.T) {
	f := newFake(t, "9.9.9")
	f.noSecrets = true
	f.add("functions", "board-prod")
	f.functions["board-prod"] = map[string]string{"datastore:custom-ds": "full", "auth:dutyboard-auth": "write"}
	out := &bytes.Buffer{}
	res, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: &ui.UI{Out: out}, Instance: "board-prod"})
	if err != nil {
		t.Fatalf("secrets the platform only takes in its console should be listed, not fail the run: %v", err)
	}
	if res.ConsoleURL == "" || !strings.Contains(out.String(), "DUTYBOARD_DATASTORE = custom-ds") {
		t.Errorf("expected the console published and the secret to set by hand spelled out:\n%s", out)
	}
}

func TestHostedConsoleOnlyInstancesNeedAPerson(t *testing.T) {
	f := newFake(t, "9.9.9")
	f.consoleOnly["auth"] = true
	_, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI()})
	if err == nil || !strings.Contains(err.Error(), "console") {
		t.Fatalf("expected a refusal naming the console, got %v", err)
	}
}

func TestHostedWaitsForTheNewVersionToBeServed(t *testing.T) {
	verifyWithin, verifyEvery = 2*time.Second, 50*time.Millisecond
	f := newFake(t, "1.0.0")
	// The edge answers the old version for a moment after activation, then the new one.
	go func() {
		time.Sleep(300 * time.Millisecond)
		f.mu.Lock()
		f.version = "9.9.9"
		f.mu.Unlock()
	}()
	if _, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI()}); err != nil {
		t.Fatalf("a version that appears shortly after deploying should pass: %v", err)
	}
}

func TestHostedRefusesADeployThatDidNotTake(t *testing.T) {
	verifyWithin, verifyEvery = 300*time.Millisecond, 50*time.Millisecond
	f := newFake(t, "1.0.0") // the function keeps answering an old version
	_, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI()})
	if err == nil || !strings.Contains(err.Error(), "did not take") {
		t.Fatalf("expected the version check to fail, got %v", err)
	}
}

func TestFreePrefixSkipsTakenNames(t *testing.T) {
	inv := altengine.Inventory{"auth": {{Name: "dutyboard-auth"}}}
	if got := freePrefix(inv); got != "dutyboard-2" {
		t.Fatalf("freePrefix = %q, want dutyboard-2", got)
	}
}

func TestHostedNeverOverwritesASiteItDidNotPublish(t *testing.T) {
	f := newFake(t, "9.9.9")
	for service, name := range NamesFor("dutyboard").Map() {
		f.add(service, name)
	}
	f.add("static", "dutyboard")
	f.liveLabels["dutyboard"] = "a1b2c3d" // what deploy-site.mjs labels a marketing-site deploy with
	res, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI(), Instance: "dutyboard"})
	if err != nil {
		t.Fatal(err)
	}
	if f.staticSites["dutyboard"] != 0 || res.ConsoleURL == "" {
		t.Fatalf("the console should go to a site of its own, not over one this program did not make: %v", f.staticSites)
	}
	if f.staticSites["dutyboard-console"] != 1 {
		t.Fatalf("the console was not published to dutyboard-console: %v", f.staticSites)
	}
}

func TestHostedKeepsAConsoleSiteItMadeBefore(t *testing.T) {
	f := newFake(t, "9.9.9")
	for service, name := range NamesFor("dutyboard").Map() {
		if service != "static" {
			f.add(service, name)
		}
	}
	f.add("static", "dutyboard") // where consoles were published, under /app, before they had a site of their own
	f.functions["dutyboard"] = map[string]string{"datastore:dutyboard": "full", "auth:dutyboard-auth": "write"}
	f.liveLabels["dutyboard"] = "dutyboard v9.9.8"
	res, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI(), Instance: "dutyboard"})
	if err != nil {
		t.Fatal(err)
	}
	if f.staticSites["dutyboard"] != 1 || res.Names.Static != "dutyboard" {
		t.Fatalf("a console this program published before should be upgraded in place: %v", f.staticSites)
	}
	if _, ok := f.inv.Find("static", "dutyboard-console"); ok {
		t.Error("a second console site was created")
	}
	if !strings.Contains(f.file(t, "/app/index.html"), "location.hash") {
		t.Error("old /app links are not sent on to the console at the root")
	}
}

func TestHostedTakesDutyboardComOffTheOrigins(t *testing.T) {
	f := newFake(t, "9.9.9")
	for service, name := range NamesFor("dutyboard").Map() {
		f.add(service, name)
	}
	f.inv["static"] = nil
	f.add("static", "dutyboard-console")
	f.configs["auth/dutyboard-auth"] = map[string]any{"settings": map[string]any{"allowedOrigins": []any{"https://www.dutyboard.com", "https://mine.example"}}}
	f.configs["functions/dutyboard"] = map[string]any{"corsOrigins": []any{"https://www.dutyboard.com", "https://mine.example"}}
	if _, err := Run(context.Background(), Options{Client: hosted(f.srv.URL), Assets: testAssets(t, "9.9.9"), UI: quietUI(), Instance: "dutyboard"}); err != nil {
		t.Fatal(err)
	}
	for _, list := range []any{f.configs["functions/dutyboard"]["corsOrigins"], f.configs["auth/dutyboard-auth"]["settings"].(map[string]any)["allowedOrigins"]} {
		b, _ := json.Marshal(list)
		if strings.Contains(string(b), "dutyboard.com") || !strings.Contains(string(b), "https://mine.example") || !strings.Contains(string(b), f.srv.URL) {
			t.Errorf("origins should lose dutyboard.com, keep the rest, and gain the console: %s", b)
		}
	}
}
