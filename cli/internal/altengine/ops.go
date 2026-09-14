package altengine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"
)

// Instance is one service instance as the control plane lists it.
type Instance struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Slug labels the public hostname of instances served from a subdomain (functions, blob,
	// static). It is not the name.
	Slug string `json:"slug"`
}

// Inventory is every instance in the organization, by service.
type Inventory map[string][]Instance

// Find returns the instance of service named name.
func (inv Inventory) Find(service, name string) (Instance, bool) {
	for _, i := range inv[service] {
		if i.Name == name {
			return i, true
		}
	}
	return Instance{}, false
}

// Whoami is the organization and principal a hosted key acts as.
type Whoami struct {
	Org struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"org"`
}

// Whoami asks the hosted control plane who this key is.
func (c *Client) Whoami(ctx context.Context) (*Whoami, error) {
	var w Whoami
	return &w, c.Tool(ctx, "whoami", nil, &w)
}

// ListInstances is the hosted inventory, or the emulator's (read from its admin API, which
// answers per service).
func (c *Client) ListInstances(ctx context.Context) (Inventory, error) {
	if !c.Local() {
		inv := Inventory{}
		return inv, c.Tool(ctx, "list_instances", nil, &inv)
	}
	// Only these three have an admin listing: functions, blob and search instances come into being
	// on first use, and asking the admin API for them falls through to the emulator's own web UI.
	inv := Inventory{}
	for _, service := range []string{"auth", "datastore", "channel"} {
		var out struct {
			Instances []Instance `json:"instances"`
		}
		if err := c.Do(ctx, http.MethodGet, "/admin/"+service, nil, &out); err != nil {
			return nil, fmt.Errorf("listing the emulator's %s instances: %w", service, err)
		}
		inv[service] = out.Instances
	}
	return inv, nil
}

// ErrConsoleOnly is the platform saying a person has to create this instance in the console.
var ErrConsoleOnly = errors.New("must be created in the console")

// CreateInstance creates service/name. An instance that already exists is success.
func (c *Client) CreateInstance(ctx context.Context, service, name string) error {
	if c.Local() {
		err := c.Do(ctx, http.MethodPost, "/admin/"+service, map[string]any{"name": name}, nil)
		if IsStatus(err, 409) {
			return nil
		}
		return err
	}
	err := c.Tool(ctx, "create_instance", map[string]any{"service": service, "name": name}, nil)
	var te *ToolError
	if errors.As(err, &te) {
		msg := strings.ToLower(te.Message)
		if strings.Contains(msg, "already exists") {
			return nil
		}
		if strings.Contains(msg, "must be created in the console") {
			return fmt.Errorf("%s '%s': %w", service, name, ErrConsoleOnly)
		}
	}
	return err
}

// PatchConfig merges top-level fields into an instance's config. Locally the emulator's admin
// API addresses instances by id, so the caller passes the id there.
func (c *Client) PatchConfig(ctx context.Context, service, instance string, changes map[string]any) error {
	if c.Local() {
		return c.Do(ctx, http.MethodPut, fmt.Sprintf("/admin/%s/%s/config", service, Esc(instance)), map[string]any{"config": changes}, nil)
	}
	return c.Tool(ctx, "patch_instance_config", map[string]any{"service": service, "instance": instance, "changes": changes}, nil)
}

// GetConfig reads an instance's config (hosted).
func (c *Client) GetConfig(ctx context.Context, service, instance string) (map[string]any, error) {
	var out struct {
		Config map[string]any `json:"config"`
	}
	if err := c.Tool(ctx, "get_instance_config", map[string]any{"service": service, "instance": instance}, &out); err != nil {
		return nil, err
	}
	if out.Config == nil {
		out.Config = map[string]any{}
	}
	return out.Config, nil
}

// CreateIndex declares a datastore index. Creating one that exists is not an error.
func (c *Client) CreateIndex(ctx context.Context, datastore, collection string, fields []string, unique bool) error {
	p := fmt.Sprintf("/v1/datastore/%s/ns/_default/col/%s/indexes", Esc(datastore), Esc(collection))
	if c.Local() {
		// The admin API wants the instance id; callers pass it as `datastore` locally.
		p = fmt.Sprintf("/admin/datastore/%s/namespaces/_default/collections/%s/indexes", Esc(datastore), Esc(collection))
	}
	err := c.Do(ctx, http.MethodPost, p, map[string]any{"fields": fields, "unique": unique}, nil)
	if IsStatus(err, 409) {
		return nil
	}
	return err
}

// SetAuthRules replaces an auth instance's row-level access config.
func (c *Client) SetAuthRules(ctx context.Context, auth string, access map[string]any) error {
	return c.Tool(ctx, "auth_set_rules", map[string]any{"instance": auth, "access": access}, nil)
}

// Function is one deployed function.
type Function struct {
	Name          string            `json:"name"`
	URL           string            `json:"url"`
	Grants        map[string]string `json:"grants"`
	ActiveVersion int               `json:"active_version"`
}

// ListFunctions lists a functions instance. URLs come back absolute, whichever plane answered.
func (c *Client) ListFunctions(ctx context.Context, instance string) ([]Function, error) {
	var out struct {
		Functions []Function `json:"functions"`
	}
	if err := c.Do(ctx, http.MethodGet, "/v1/functions/"+Esc(instance), nil, &out); err != nil {
		return nil, err
	}
	for i, f := range out.Functions {
		// The emulator answers a path; it has no per-instance hosts.
		if strings.HasPrefix(f.URL, "/") {
			out.Functions[i].URL = c.BaseURL + f.URL
		}
	}
	return out.Functions, nil
}

// Deploy is the answer to a function deploy.
type Deploy struct {
	Version   int `json:"version"`
	SizeBytes int `json:"size_bytes"`
}

// DeployFunction deploys and activates one function.
func (c *Client) DeployFunction(ctx context.Context, instance, name, code string, grants map[string]string) (*Deploy, error) {
	var out Deploy
	err := c.Do(ctx, http.MethodPost, "/v1/functions/"+Esc(instance)+"/deploy", map[string]any{
		"name": name, "code": code, "grants": grants, "activate": true,
	}, &out)
	return &out, err
}

// SetFunctionSettings sets a functions instance's CORS origins and outbound allowlist.
func (c *Client) SetFunctionSettings(ctx context.Context, instance string, cors []string) error {
	settings := map[string]any{"corsOrigins": cors, "allowedHosts": []string{}}
	if c.Local() {
		return c.Do(ctx, http.MethodPut, "/v1/functions/"+Esc(instance)+"/settings", settings, nil)
	}
	return c.PatchConfig(ctx, "functions", instance, settings)
}

// SetFunctionSecrets adds or replaces env-exposure secrets on a functions instance, keeping every
// secret already there. The platform REPLACES the whole map, and values cannot be read back — an
// entry sent without a value keeps the stored one, which is how the rest survive.
func (c *Client) SetFunctionSecrets(ctx context.Context, instance string, values map[string]string) error {
	var listed struct {
		Secrets []struct {
			Name   string `json:"name"`
			Egress bool   `json:"egress"`
		} `json:"secrets"`
	}
	p := "/v1/functions/" + Esc(instance) + "/secrets"
	if err := c.Do(ctx, http.MethodGet, p, nil, &listed); err != nil {
		return err
	}
	body := map[string]any{}
	for _, s := range listed.Secrets {
		body[s.Name] = map[string]any{"egress": s.Egress}
	}
	for k, v := range values {
		body[k] = map[string]any{"value": v, "egress": false}
	}
	return c.Do(ctx, http.MethodPut, p, body, nil)
}

// StaticFile is one file of a site.
type StaticFile struct {
	Path string // "/app/index.html"
	Data []byte
	hash string
}

// StaticLive answers what a static instance is serving: whether it has any deployment at all, and
// the label of the live one. Read leniently — the listing is only asked so that a site somebody else
// published is not overwritten, and a shape this does not recognise is reported as an error, which
// the caller treats as "leave it alone".
func (c *Client) StaticLive(ctx context.Context, instance string) (deployed bool, liveMessage string, err error) {
	var out map[string]any
	if err := c.Tool(ctx, "static_list_deployments", map[string]any{"instance": instance, "limit": 25}, &out); err != nil {
		return false, "", err
	}
	list, ok := out["deployments"].([]any)
	if !ok {
		return false, "", fmt.Errorf("unrecognised deployment listing for static %q", instance)
	}
	if len(list) == 0 {
		return false, "", nil
	}
	liveID := ""
	for _, k := range []string{"live", "active", "active_deployment_id", "live_deployment_id", "current"} {
		if v, ok := out[k].(string); ok && v != "" {
			liveID = v
		}
	}
	for _, raw := range list {
		d, _ := raw.(map[string]any)
		id, _ := d["id"].(string)
		if id == "" {
			id, _ = d["deployment_id"].(string)
		}
		isLive := (liveID != "" && id == liveID) || d["live"] == true || d["active"] == true || d["is_live"] == true
		if isLive {
			msg, _ := d["message"].(string)
			return true, msg, nil
		}
	}
	return true, "", fmt.Errorf("could not tell which deployment of static %q is live", instance)
}

// ErrNoStatic is an altengine with no website hosting: the emulator, or a platform that predates it.
var ErrNoStatic = errors.New("this altengine does not host static sites")

// DeployStatic publishes files to a static instance and activates the deployment, uploading only
// what the platform does not already have. Answers the live URL.
//
// The three calls deploy-site.mjs makes: the manifest, the missing files straight to storage, then
// activation — a pointer move, so a half-finished upload is a deployment nobody points at rather
// than a broken site.
func (c *Client) DeployStatic(ctx context.Context, instance, message string, files []StaticFile) (url, deploymentID string, err error) {
	manifest := map[string]any{}
	byHash := map[string]*StaticFile{}
	for i := range files {
		sum := sha256.Sum256(files[i].Data)
		files[i].hash = hex.EncodeToString(sum[:])
		manifest[files[i].Path] = map[string]any{"hash": files[i].hash, "size": len(files[i].Data)}
		byHash[files[i].hash] = &files[i]
	}
	var created struct {
		DeploymentID string   `json:"deployment_id"`
		Uploads      []upload `json:"uploads"`
		Cursor       string   `json:"cursor"`
	}
	base := "/v1/static/" + Esc(instance) + "/deployments"
	err = c.Do(ctx, http.MethodPost, base, map[string]any{"files": manifest, "message": message}, &created)
	if IsStatus(err, 501) || (IsStatus(err, 404) && strings.Contains(errorBody(err), "data-plane endpoint")) {
		return "", "", ErrNoStatic
	}
	if err != nil {
		return "", "", err
	}

	uploads, cursor := created.Uploads, created.Cursor
	for {
		if err := putAll(ctx, c.HTTP, uploads, func(h string) *StaticFile { return byHash[h] }); err != nil {
			return "", "", err
		}
		if cursor == "" {
			break
		}
		var page struct {
			Uploads []upload `json:"uploads"`
			Cursor  string   `json:"cursor"`
		}
		if err := c.Do(ctx, http.MethodGet, fmt.Sprintf("%s/%s/uploads?cursor=%s", base, Esc(created.DeploymentID), Esc(cursor)), nil, &page); err != nil {
			return "", "", err
		}
		uploads, cursor = page.Uploads, page.Cursor
	}

	var live struct {
		URL string `json:"url"`
	}
	if err := c.Do(ctx, http.MethodPost, fmt.Sprintf("%s/%s/activate", base, Esc(created.DeploymentID)), nil, &live); err != nil {
		return "", "", err
	}
	return strings.TrimRight(live.URL, "/"), created.DeploymentID, nil
}

func errorBody(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Body
	}
	return ""
}

// upload is one presigned PUT the platform asks for.
type upload struct {
	PathHash        string            `json:"path_hash"`
	UploadURL       string            `json:"upload_url"`
	Method          string            `json:"method"`
	RequiredHeaders map[string]string `json:"required_headers"`
}

// putAll sends uploads a few at a time. Errors are collected rather than aborting mid-flight: an
// unactivated deployment is harmless, and the next run reuses every file that did land.
func putAll(ctx context.Context, hc *http.Client, uploads []upload, file func(string) *StaticFile) error {
	const parallel = 8
	jobs := make(chan upload)
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	for w := 0; w < parallel; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for u := range jobs {
				if err := putOne(ctx, hc, u, file); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for _, u := range uploads {
		jobs <- u
	}
	close(jobs)
	wg.Wait()
	return firstErr
}

func putOne(ctx context.Context, hc *http.Client, u upload, file func(string) *StaticFile) error {
	f := file(u.PathHash)
	if f == nil {
		return fmt.Errorf("the platform asked for a file this deploy does not have (%.12s) — run it again", u.PathHash)
	}
	method := u.Method
	if method == "" {
		method = http.MethodPut
	}
	req, err := http.NewRequestWithContext(ctx, method, u.UploadURL, bytes.NewReader(f.Data))
	if err != nil {
		return err
	}
	for k, v := range u.RequiredHeaders {
		// Signed into the URL, and set from the body length by the transport.
		if strings.EqualFold(k, "content-length") {
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("uploading %s: %w", f.Path, err)
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("uploading %s: %s", f.Path, res.Status)
	}
	return nil
}

// FilesUnder reads every file under dir in fsys into StaticFiles published under prefix.
func FilesUnder(fsys fs.FS, dir, prefix string) ([]StaticFile, error) {
	return FilesUnderExcept(fsys, dir, prefix, nil)
}

// FilesUnderExcept is FilesUnder leaving out every file a pattern matches. A pattern is a path.Match
// glob, tried against the file's path under dir and against its name alone — so "*.gz" leaves out
// every .gz at any depth and "debug/*" one folder. A skipped file is never read.
func FilesUnderExcept(fsys fs.FS, dir, prefix string, exclude []string) ([]StaticFile, error) {
	for _, pat := range exclude {
		if _, err := path.Match(pat, ""); err != nil {
			return nil, fmt.Errorf("exclude pattern %q: %w", pat, err)
		}
	}
	var out []StaticFile
	err := fs.WalkDir(fsys, dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, dir), "/")
		for _, pat := range exclude {
			if ok, _ := path.Match(pat, rel); ok {
				return nil
			}
			if ok, _ := path.Match(pat, path.Base(rel)); ok {
				return nil
			}
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		out = append(out, StaticFile{Path: path.Join("/", prefix, rel), Data: data})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}
