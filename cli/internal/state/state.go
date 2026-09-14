// Package state is what the program keeps on this machine: where its folders are, its config, and
// its credentials.
//
//	~/.dutyboard/                    %LOCALAPPDATA%\DutyBoard on Windows; DUTYBOARD_HOME overrides
//	  config.json                    which DutyBoard, this machine's identity, limits
//	  credentials.json               only when the OS keyring is unavailable (0600)
//	  workspaces.json                linked folders
//	  tools/  worktrees/  logs/  run/  cache/
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// Home is the program's own folder.
func Home() string {
	if h := os.Getenv("DUTYBOARD_HOME"); h != "" {
		return h
	}
	if runtime.GOOS == "windows" {
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "DutyBoard")
		}
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return ".dutyboard"
	}
	return filepath.Join(h, ".dutyboard")
}

// Path joins parts under Home.
func Path(parts ...string) string { return filepath.Join(append([]string{Home()}, parts...)...) }

// Config is config.json.
type Config struct {
	// Server is the DutyBoard function this machine is paired with, e.g.
	// https://k3x9-fn.altengine.app/board.
	Server string `json:"server,omitempty"`
	// Console is where people approve pairings and file duties.
	Console string `json:"console,omitempty"`
	// Altengine is the API origin the deployment lives on, kept for upgrades.
	Altengine string `json:"altengine,omitempty"`
	// Instances names the deployment's instances, by service, kept for upgrades.
	Instances map[string]string `json:"instances,omitempty"`

	MachineID   string `json:"machine_id,omitempty"`
	MachineName string `json:"machine_name,omitempty"`
	AgentPrefix string `json:"agent_prefix,omitempty"`

	// ProjectsRoot is the only folder a setup requested from the console may clone into.
	ProjectsRoot string `json:"projects_root,omitempty"`
}

// LoadConfig reads config.json; a missing file is an empty config.
func LoadConfig() (*Config, error) {
	var c Config
	err := readJSON(Path("config.json"), &c)
	if errors.Is(err, os.ErrNotExist) {
		return &c, nil
	}
	return &c, err
}

// Save writes config.json.
func (c *Config) Save() error { return WriteJSON(Path("config.json"), c, 0o600) }

func readJSON(p string, out any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// WriteJSON writes v to p atomically: a crash mid-write leaves the old file, never half of a new one.
func WriteJSON(p string, v any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
