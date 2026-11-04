// Package readiness is what this machine has of the things duties need from it: the agents, signed
// in; the GitHub CLI; a commit author; a deploy key; the secrets its boards' MCP servers name.
//
// It is machine-wide, not per board. The terminal prints it after setting the machine up, and the
// daemon reports it to the console, which shows it as the machine's checklist. A board's own blocking
// problem — a clone that fails, say — stays on that board.
package readiness

import (
	"context"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// States of an item.
const (
	OK      = "ok"      // ready
	Todo    = "todo"    // not ready: Detail says why, Fix how
	Unknown = "unknown" // could not tell
)

// Actions the console may ask this machine to take on an item.
const (
	ActionInstall = "install"
	ActionSignIn  = "sign_in"
)

// Item is one line of the checklist.
type Item struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	State string `json:"state"`
	// Needed is true when a board this machine works needs it; Boards names them.
	Needed bool     `json:"needed"`
	Boards []string `json:"boards,omitempty"`
	Detail string   `json:"detail,omitempty"`
	// Fix is the command that puts it right, run on this machine.
	Fix string `json:"fix,omitempty"`
	// Actions are what the console can ask this machine to do about it.
	Actions []string `json:"actions,omitempty"`
}

// Report is the whole checklist.
type Report struct {
	Items     []Item `json:"items"`
	CheckedAt int64  `json:"checked_at"`
}

// Todo are the items a board this machine works is waiting on.
func (r Report) Todo() []Item {
	var out []Item
	for _, it := range r.Items {
		if it.Needed && it.State == Todo {
			out = append(out, it)
		}
	}
	return out
}

// Check builds the report for the boards this machine works. It asks the agents' CLIs, which is slow,
// so they are asked at once.
func Check(ctx context.Context, linked []board.BoardView) Report {
	var (
		wg     sync.WaitGroup
		agents []runner.Status
		gh     Item
		git    Item
	)
	wg.Add(3)
	go func() { defer wg.Done(); agents = runner.All(ctx) }()
	go func() { defer wg.Done(); gh = ghItem(ctx) }()
	go func() { defer wg.Done(); git = gitItem(ctx) }()
	wg.Wait()

	var items []Item
	for _, s := range agents {
		it := agentItem(s)
		for _, b := range linked {
			name := ""
			if b.Runner != nil {
				name = b.Runner.Agent
			}
			if name == "" {
				name = runner.DefaultAgent
			}
			if name == s.Agent {
				it.Boards = append(it.Boards, b.ProjectID)
			}
		}
		it.Needed = len(it.Boards) > 0
		items = append(items, it)
	}

	for _, b := range linked {
		if b.Profile == nil {
			continue
		}
		if b.Profile.Git.Mode == "pr" || b.Profile.Deploy.Method == "ci" || b.Profile.Deploy.Method == "ci-dispatch" {
			gh.Boards = append(gh.Boards, b.ProjectID)
		}
		if !b.Folder() && b.Profile.Git.AuthorName == "" {
			git.Boards = append(git.Boards, b.ProjectID)
		}
	}
	gh.Needed, git.Needed = len(gh.Boards) > 0, len(git.Boards) > 0
	items = append(items, gh, git)

	if it, ok := deployKeyItem(linked); ok {
		items = append(items, it)
	}
	if it, ok := mcpSecretsItem(linked); ok {
		items = append(items, it)
	}

	// What a board is waiting on first, then the rest, each in the order above.
	sort.SliceStable(items, func(i, j int) bool { return rank(items[i]) < rank(items[j]) })
	return Report{Items: items, CheckedAt: time.Now().UnixMilli()}
}

func rank(it Item) int {
	switch {
	case it.Needed && it.State == Todo:
		return 0
	case it.Needed:
		return 1
	default:
		return 2
	}
}

func agentItem(s runner.Status) Item {
	it := Item{Key: s.Agent, Label: s.Label, Detail: s.Detail, Fix: s.Fix}
	switch {
	case !s.Installed:
		it.State, it.Actions = Todo, []string{ActionInstall}
	case s.SignedIn == nil:
		it.State, it.Detail = Unknown, "installed; this version cannot say whether it is signed in, so the first session will"
	case !*s.SignedIn:
		it.State, it.Actions = Todo, []string{ActionSignIn}
	default:
		it.State, it.Detail = OK, "installed and signed in"
	}
	return it
}

func ghItem(ctx context.Context) Item {
	it := Item{Key: "gh", Label: "GitHub CLI"}
	if _, err := exec.LookPath("gh"); err != nil {
		it.State, it.Actions = Todo, []string{ActionInstall}
		it.Detail = "not installed (https://cli.github.com) — boards that open pull requests or watch CI need it, and so does making a board's repository"
		return it
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "gh", "auth", "status")
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1")
	if err := cmd.Run(); err != nil {
		it.State, it.Actions = Todo, []string{ActionSignIn}
		it.Detail = "installed, not signed in"
		it.Fix = "gh auth login && gh auth setup-git"
		return it
	}
	it.State, it.Detail = OK, "signed in"
	// Without this, git clones private repositories over https with no credentials at all.
	out, _ := exec.CommandContext(cctx, "git", "config", "--global", "--get-regexp", `^credential\..*helper$`).Output()
	if !strings.Contains(string(out), "gh auth git-credential") {
		it.Detail = "signed in; git does not use it for https repositories yet"
		it.Fix = "gh auth setup-git"
	}
	return it
}

func gitItem(ctx context.Context) Item {
	it := Item{Key: "git", Label: "Commit author"}
	if _, err := exec.LookPath("git"); err != nil {
		it.State, it.Detail, it.Fix = Todo, "git is not installed on this machine", "install git"
		return it
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "git", "var", "GIT_COMMITTER_IDENT")
	cmd.Dir = os.TempDir() // outside any repository, so only this machine's own config counts
	out, err := cmd.Output()
	if err != nil {
		it.State = Todo
		it.Detail = "git on this machine has no commit author — boards that set none of their own cannot commit"
		it.Fix = `git config --global user.name "Your Name" && git config --global user.email you@example.com`
		return it
	}
	ident := strings.TrimSpace(string(out))
	if i := strings.Index(ident, ">"); i > 0 {
		ident = ident[:i+1]
	}
	it.State, it.Detail = OK, ident
	return it
}

func deployKeyItem(linked []board.BoardView) (Item, bool) {
	it := Item{Key: "deploy_key", Label: "altengine deploy key"}
	for _, b := range linked {
		if b.Profile != nil && b.Profile.Deploy.Method == "altengine" {
			it.Boards = append(it.Boards, b.ProjectID)
		}
	}
	if len(it.Boards) == 0 {
		return it, false
	}
	it.Needed = true
	if k, _ := state.Credential(state.DeployKey); k != "" {
		it.State, it.Detail = OK, "set on this machine"
		return it, true
	}
	if k, _ := state.Credential(state.AltengineKey); k != "" {
		it.State, it.Detail = OK, "using the key DutyBoard was provisioned with — a narrower deploy key is safer"
		it.Fix = "dutyboard --deploy-key"
		return it, true
	}
	// A secret: typed on the machine, never sent through the board.
	it.State, it.Detail, it.Fix = Todo, "not set — boards that deploy to altengine cannot", "dutyboard --deploy-key"
	return it, true
}

func mcpSecretsItem(linked []board.BoardView) (Item, bool) {
	it := Item{Key: "mcp_secrets", Label: "MCP server secrets"}
	var missing []string
	seen := map[string]bool{}
	for _, b := range linked {
		if b.Profile == nil {
			continue
		}
		for _, s := range b.Profile.MCPServers {
			for _, name := range s.Secrets {
				if !seen[b.ProjectID] {
					seen[b.ProjectID] = true
					it.Boards = append(it.Boards, b.ProjectID)
				}
				if v, _ := state.Credential(state.MCPSecret(b.ProjectID, s.Name, name)); v == "" {
					missing = append(missing, b.ProjectID+"/"+s.Name+" "+name)
				}
			}
		}
	}
	if len(it.Boards) == 0 {
		return it, false
	}
	it.Needed = true
	if len(missing) == 0 {
		it.State, it.Detail = OK, "all set on this machine"
		return it, true
	}
	it.State, it.Fix = Todo, "dutyboard --mcp-secrets"
	it.Detail = "not set on this machine: " + strings.Join(missing, ", ")
	return it, true
}
