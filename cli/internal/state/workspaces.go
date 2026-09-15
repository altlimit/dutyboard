package state

import (
	"errors"
	"os"
	"sync"
	"time"
)

var wsMu sync.Mutex

// Workspace is a linked folder: the board it works, and where its repository is on this machine.
type Workspace struct {
	Board    string `json:"board"`
	Path     string `json:"path"`
	LinkedAt int64  `json:"linked_at"`
}

// Workspaces reads workspaces.json.
func Workspaces() ([]Workspace, error) {
	wsMu.Lock()
	defer wsMu.Unlock()
	return readWorkspaces()
}

func readWorkspaces() ([]Workspace, error) {
	var out []Workspace
	err := readJSON(Path("workspaces.json"), &out)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return out, err
}

// SetWorkspace records that board is worked from path, replacing any folder it had before.
func SetWorkspace(board, path string) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	list, err := readWorkspaces()
	if err != nil {
		return err
	}
	kept := list[:0]
	for _, w := range list {
		if w.Board != board {
			kept = append(kept, w)
		}
	}
	kept = append(kept, Workspace{Board: board, Path: path, LinkedAt: time.Now().Unix()})
	return WriteJSON(Path("workspaces.json"), kept, 0o600)
}

// RemoveWorkspace forgets a board's folder.
func RemoveWorkspace(board string) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	list, err := readWorkspaces()
	if err != nil {
		return err
	}
	kept := list[:0]
	for _, w := range list {
		if w.Board != board {
			kept = append(kept, w)
		}
	}
	return WriteJSON(Path("workspaces.json"), kept, 0o600)
}

// RunRecord is what the daemon remembers about a duty it has worked, across restarts: which agent
// holds it, which conversation to resume, and how often a session has stopped without finishing.
type RunRecord struct {
	Board    string `json:"board"`
	Agent    string `json:"agent"`
	Session  string `json:"session"`
	Attempts int    `json:"attempts"`
	// Repos are the board's other repositories the duty has opened a worktree of.
	Repos []string `json:"repos,omitempty"`
}

var runsMu sync.Mutex

// RunRecords reads state.json.
func RunRecords() (map[string]RunRecord, error) {
	runsMu.Lock()
	defer runsMu.Unlock()
	return readRuns()
}

func readRuns() (map[string]RunRecord, error) {
	out := map[string]RunRecord{}
	err := readJSON(Path("state.json"), &out)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	return out, err
}

// SaveRunRecord writes one duty's record; a nil record deletes it.
func SaveRunRecord(duty string, rec *RunRecord) error {
	runsMu.Lock()
	defer runsMu.Unlock()
	all, err := readRuns()
	if err != nil {
		all = map[string]RunRecord{}
	}
	if rec == nil {
		delete(all, duty)
	} else {
		all[duty] = *rec
	}
	return WriteJSON(Path("state.json"), all, 0o600)
}
