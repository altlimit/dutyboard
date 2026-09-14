// Package tools is this machine's memory of what is installed for its projects.
//
// A setup session finds what a project needs — Godot 4.7.1, Node 22, export templates — installs
// what is missing into the tools folder, and registers each one here. Every later session gets the
// registered tools on its PATH, their variables in its environment, and a line each in its system
// prompt telling it to use them rather than download another copy. The registry is per machine, not
// per board: two projects that need the same Godot share one install.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// Tool is one registered install.
type Tool struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	// Path is the folder holding the tool's executables; it goes on PATH.
	Path string `json:"path"`
	// Env are variables a session needs to find the tool (GODOT_BIN, ANDROID_HOME, …).
	Env    map[string]string `json:"env,omitempty"`
	Source string            `json:"source,omitempty"`
	SHA256 string            `json:"sha256,omitempty"`
	// Verify is a command that succeeds only when the tool works, e.g. `godot --version`.
	Verify     string `json:"verify"`
	VerifiedAt int64  `json:"verified_at,omitempty"`
	Missing    bool   `json:"missing,omitempty"`
}

// Registry is tools/registry.json.
type Registry struct {
	mu    sync.Mutex
	path  string
	Tools []Tool `json:"tools"`
}

// Dir is the tools folder: ~/.dutyboard/tools.
func Dir() string { return state.Path("tools") }

// Load reads the registry; a missing file is an empty one.
func Load() (*Registry, error) {
	r := &Registry{path: filepath.Join(Dir(), "registry.json")}
	b, err := os.ReadFile(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	return r, json.Unmarshal(b, r)
}

func (r *Registry) save() error { return state.WriteJSON(r.path, r, 0o644) }

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,59}$`)
var envRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// Register verifies a tool and records it, replacing an earlier entry of the same name and version.
func (r *Registry) Register(ctx context.Context, t Tool) (string, error) {
	t.Name = strings.ToLower(strings.TrimSpace(t.Name))
	if !nameRe.MatchString(t.Name) {
		return "", fmt.Errorf("tool name %q must be lowercase letters, digits, '.', '_' or '-'", t.Name)
	}
	if !filepath.IsAbs(t.Path) {
		return "", fmt.Errorf("path must be the absolute folder holding the tool's executables")
	}
	if info, err := os.Stat(t.Path); err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder on this machine", t.Path)
	}
	for k := range t.Env {
		if !envRe.MatchString(k) || k == "PATH" {
			return "", fmt.Errorf("environment variable %q is not allowed", k)
		}
	}
	if strings.TrimSpace(t.Verify) == "" {
		return "", errors.New("verify is required: a command that succeeds only when the tool works")
	}
	out, err := r.run(ctx, t)
	if err != nil {
		return out, fmt.Errorf("`%s` failed, so the tool is not registered: %w", t.Verify, err)
	}
	t.VerifiedAt, t.Missing = time.Now().Unix(), false

	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.Tools[:0]
	for _, have := range r.Tools {
		if !(have.Name == t.Name && have.Version == t.Version) {
			kept = append(kept, have)
		}
	}
	r.Tools = append(kept, t)
	sort.Slice(r.Tools, func(i, j int) bool { return r.Tools[i].Name < r.Tools[j].Name })
	return out, r.save()
}

func (r *Registry) run(ctx context.Context, t Tool) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	env := []string{"PATH=" + t.Path + string(os.PathListSeparator) + os.Getenv("PATH")}
	for k, v := range t.Env {
		env = append(env, k+"="+v)
	}
	out, err := worktree.Shell(ctx, t.Path, t.Verify, env)
	if len(out) > 2000 {
		out = out[:2000]
	}
	return out, err
}

// VerifyAll runs every tool's verify command, marking the ones that no longer work. Answers the
// names of those that went missing.
func (r *Registry) VerifyAll(ctx context.Context) []string {
	r.mu.Lock()
	snapshot := append([]Tool(nil), r.Tools...)
	r.mu.Unlock()
	var missing []string
	for i, t := range snapshot {
		_, err := r.run(ctx, t)
		snapshot[i].Missing = err != nil
		if err != nil {
			missing = append(missing, t.Name+" "+t.Version)
		} else {
			snapshot[i].VerifiedAt = time.Now().Unix()
		}
	}
	r.mu.Lock()
	r.Tools = snapshot
	_ = r.save()
	r.mu.Unlock()
	return missing
}

// List answers the registered tools.
func (r *Registry) List() []Tool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Tool(nil), r.Tools...)
}

// SessionEnv is what a session's environment gains: the tools folder, every working tool's folder
// on PATH, and their variables.
func (r *Registry) SessionEnv() []string {
	tools := r.List()
	env := []string{"DUTYBOARD_TOOLS=" + Dir()}
	var path []string
	for _, t := range tools {
		if t.Missing {
			continue
		}
		path = append(path, t.Path)
		for k, v := range t.Env {
			env = append(env, k+"="+v)
		}
	}
	if len(path) > 0 {
		env = append(env, "PATH="+strings.Join(append(path, os.Getenv("PATH")), string(os.PathListSeparator)))
	}
	return env
}

// Describe is one line per working tool, for a system prompt.
func (r *Registry) Describe() string {
	var lines []string
	for _, t := range r.List() {
		if t.Missing {
			continue
		}
		line := fmt.Sprintf("- %s %s in `%s`", t.Name, t.Version, t.Path)
		if t.Verify != "" {
			line += fmt.Sprintf(" (check: `%s`)", t.Verify)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}
