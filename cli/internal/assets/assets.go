// Package assets is what the provisioner deploys: the built function, the console, the agent
// protocol, and the backend declarations (indexes, access rules, sign-up form).
//
// Three places they can come from, all presented as one file layout:
//
//	function/bundle.js
//	console/...            the built console (index.html, assets/, config.js)
//	agent.md
//	llms.txt               optional
//	backend/{indexes,access,signup}.json
//	VERSION
//
//   - Embedded: a release binary carries them (scripts/stage-cli-assets.mjs copies them into web/
//     before GoReleaser builds). No Node, npm or sitegen on the machine that provisions.
//   - A source checkout: `--source <repo>`, or found by walking up from the working directory.
//     This is how `npm run setup` deploys what is in the working tree.
//   - Downloaded: a `go install` build has nothing embedded, so it fetches `dutyboard-web_<v>.tar.gz`
//     from the matching GitHub release and checks it against the release's checksums.txt.
package assets

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

//go:embed all:web
var embedded embed.FS

// Bundle is one set of assets and the version they were built as.
type Bundle struct {
	Version string
	Source  string // "embedded", a directory, or a release URL — for messages only
	fsys    fs.FS
}

// Embedded returns the assets compiled into this binary, or false when it has none.
func Embedded() (*Bundle, bool) {
	sub, err := fs.Sub(embedded, "web")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, "function/bundle.js"); err != nil {
		return nil, false
	}
	v, _ := fs.ReadFile(sub, "VERSION")
	return &Bundle{Version: strings.TrimSpace(string(v)), Source: "embedded", fsys: sub}, true
}

// FromDir reads an unpacked asset layout (a downloaded release, already extracted).
func FromDir(dir string) (*Bundle, error) {
	fsys := os.DirFS(dir)
	if _, err := fs.Stat(fsys, "function/bundle.js"); err != nil {
		return nil, fmt.Errorf("%s is not a DutyBoard asset folder: %w", dir, err)
	}
	v, _ := fs.ReadFile(fsys, "VERSION")
	return &Bundle{Version: strings.TrimSpace(string(v)), Source: dir, fsys: fsys}, nil
}

// FromSource reads a DutyBoard checkout: the function must have been built (npm run build:fn), and
// the console too if it is to be deployed (npm run build:app).
func FromSource(repo string) (*Bundle, error) {
	pkg, err := os.ReadFile(filepath.Join(repo, "package.json"))
	if err != nil {
		return nil, fmt.Errorf("%s is not a DutyBoard checkout: %w", repo, err)
	}
	var meta struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.Unmarshal(pkg, &meta) != nil || meta.Name != "dutyboard" {
		return nil, fmt.Errorf("%s is not a DutyBoard checkout (package.json names '%s')", repo, meta.Name)
	}
	if _, err := os.Stat(filepath.Join(repo, "functions", "dist", "bundle.js")); err != nil {
		return nil, fmt.Errorf("the function is not built in %s — run `npm run build:fn` first", repo)
	}
	return &Bundle{
		Version: meta.Version,
		Source:  repo,
		fsys: routed{
			"function/bundle.js": filepath.Join(repo, "functions", "dist", "bundle.js"),
			"console":            filepath.Join(repo, "public", "app"),
			"agent.md":           filepath.Join(repo, "agent", "OPERATING.md"),
			"llms.txt":           filepath.Join(repo, "public", "llms.txt"),
			"backend":            filepath.Join(repo, "backend"),
		},
	}, nil
}

// FindSource walks up from dir looking for a DutyBoard checkout.
func FindSource(dir string) (string, bool) {
	for {
		if b, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil && strings.Contains(string(b), `"name": "dutyboard"`) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// ReadFile reads one asset.
func (b *Bundle) ReadFile(name string) ([]byte, error) { return fs.ReadFile(b.fsys, name) }

// Has reports whether an optional asset is there.
func (b *Bundle) Has(name string) bool {
	_, err := fs.Stat(b.fsys, name)
	return err == nil
}

// FS is the whole layout.
func (b *Bundle) FS() fs.FS { return b.fsys }

// JSON decodes a backend declaration.
func (b *Bundle) JSON(name string, out any) error {
	raw, err := b.ReadFile(path.Join("backend", name))
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// routed maps the top of the asset layout onto paths in a checkout. A key is either a file or a
// directory; everything below a directory key is read from below its path.
type routed map[string]string

func (r routed) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	if name == "." {
		return nil, &fs.PathError{Op: "open", Path: name, Err: errors.New("the checkout layout has no root listing")}
	}
	for key, target := range r {
		if name == key {
			return os.Open(target)
		}
		if strings.HasPrefix(name, key+"/") {
			return os.Open(filepath.Join(target, filepath.FromSlash(strings.TrimPrefix(name, key+"/"))))
		}
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

// Stat lets fs.Stat and fs.WalkDir work without opening and reading.
func (r routed) Stat(name string) (fs.FileInfo, error) {
	f, err := r.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Stat()
}

// ReadDir lets fs.WalkDir descend into a routed directory.
func (r routed) ReadDir(name string) ([]fs.DirEntry, error) {
	for key, target := range r {
		if name == key {
			return os.ReadDir(target)
		}
		if strings.HasPrefix(name, key+"/") {
			return os.ReadDir(filepath.Join(target, filepath.FromSlash(strings.TrimPrefix(name, key+"/"))))
		}
	}
	return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
}
