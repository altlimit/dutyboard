package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/daemon"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/provision"
	"github.com/altlimit/dutyboard/cli/internal/service"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// Start is `dutyboard` with no job flag. Run by a person, it is the checklist (setup.go): the
// deployment is current, the machine is paired, the repository it is run in is offered, dutyboard
// starts by itself and is this binary, and the console takes it from there. Run by a service or a
// supervisor, it pairs only with --server, and then works.
func Start(ctx context.Context, u *ui.UI, f Flags) error {
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	guided := u.Interactive && !f.Service
	key, _ := state.Credential(state.MachineKey)
	paired := key != "" && cfg.Server != ""
	if guided && paired {
		u.Step("Your DutyBoard")
		if err := checkDeployment(ctx, u, cfg, f); err != nil {
			return err
		}
	}
	if !paired {
		if key, err = pairMachine(ctx, u, cfg, f); err != nil {
			return err
		}
	} else if guided {
		u.OK("this machine is paired as %q", cfg.MachineName)
	}
	if f.Root != "" {
		cfg.ProjectsRoot = f.Root
		if err := cfg.Save(); err != nil {
			return err
		}
	}
	api := board.New(cfg.Server, key)
	api.Version = Version

	if guided {
		if err := offerLink(ctx, u, api); err != nil {
			return err
		}
	}

	if f.Service {
		return installService(u, cfg)
	}

	var accepted []string
	if guided {
		if accepted, err = acceptRequests(ctx, u, api); err != nil {
			return err
		}
	}

	if localmcp.Running() && (!guided || f.NoService) {
		if !u.Interactive {
			return nil // started by cron or a supervisor while one is running: nothing to do, and nothing to log
		}
		c, err := localmcp.Dial()
		if err == nil {
			defer c.Close()
			if err := c.Reload(); err == nil {
				for _, id := range accepted {
					_ = c.Accept(id)
				}
				u.OK("dutyboard is already running on this machine, and has picked up any change")
				return nil
			}
		}
	}

	if guided && !f.NoService {
		background, err := ensureService(u, cfg, accepted)
		if err != nil {
			return err
		}
		if background {
			showReadiness(ctx, u, api)
			handOff(u, cfg)
			return nil
		}
	}

	d, err := daemon.New(daemon.Options{Version: Version, Config: cfg, Key: key, Accepted: accepted})
	if err != nil {
		return err
	}
	if guided {
		showReadiness(ctx, u, api)
		handOff(u, cfg)
		u.Step("Working in this terminal")
	} else if cfg.Console != "" {
		u.Say("Your board: %s", cfg.Console)
	}
	u.Say("Working. Ctrl+C stops it; the duties it holds are resumed next time.")
	return d.Run(ctx)
}

// installService sets the daemon to start by itself and starts it, saying anything left to do.
func installService(u *ui.UI, cfg *state.Config) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Restarting is what running this again after an update means: the dutyboard already running is
	// the old binary, and starting another would only find it there and leave.
	if localmcp.Running() {
		u.Say("Stopping the dutyboard already running, to start this one…")
		if err := stopRunning(u, false); err != nil {
			return err
		}
	}
	inst, err := service.Install(exe)
	if err != nil {
		return fmt.Errorf("could not set dutyboard to start by itself: %w", err)
	}
	u.OK("set to start by itself, and started — follow it with: %s", inst.Logs)
	for _, n := range inst.Notes {
		u.Say("%s", n)
	}
	if cfg.Console != "" {
		u.Say("Put it on boards from your console: %s#/machines", strings.TrimRight(cfg.Console, "/")+"/")
	}
	return nil
}

// pairMachine connects this machine to a DutyBoard: an existing one by URL, or one it provisions
// first. Answers the machine key, stored.
//
// With --server it needs no terminal: it prints the code and the link, and waits for a person to
// approve it — so a server can be paired from a provisioning script or over plain SSH.
func pairMachine(ctx context.Context, u *ui.UI, cfg *state.Config, f Flags) (string, error) {
	if !u.Interactive && f.Server == "" && cfg.Server == "" {
		return "", errors.New("this machine is not paired with a DutyBoard yet — run `dutyboard` in a terminal, or `dutyboard --server <API URL>` to pair without one")
	}
	server := f.Server
	if server == "" {
		server = cfg.Server
	}
	if server == "" {
		pick, err := u.Choose("No DutyBoard connected.", []string{
			"Connect to an existing DutyBoard",
			"Set up my own on altengine (needs an altengine API key)",
		}, 0)
		if err != nil {
			return "", err
		}
		if pick == 1 {
			res, err := Provision(ctx, u, f)
			if err != nil {
				return "", err
			}
			server = res.APIURL
			if res.ConsoleURL != "" {
				cfg.Console = res.ConsoleURL
			}
		} else {
			u.Say("The API URL is on the console's Machines page, e.g. https://abc123-fn.altengine.app/board")
			server, err = u.Ask("DutyBoard API URL", "")
			if err != nil {
				return "", err
			}
		}
	}
	// Before the next question, not after it: an address that is not a DutyBoard is said so at once.
	if _, err := boardAt(ctx, server); err != nil {
		return "", err
	}
	name := f.Name
	if name == "" && !u.Interactive {
		name = defaultMachineName()
	}
	if name == "" {
		var err error
		if name, err = u.Ask("Name for this machine", defaultMachineName()); err != nil {
			return "", err
		}
	}
	paired, err := Pair(ctx, cfg, server, name, func(code, link string, minutes int) {
		u.Step("Approve this machine")
		if link != "" {
			u.Say("Open %s", link)
			openBrowser(link)
		} else {
			u.Say("Open your DutyBoard console — its site is on your static instance in the altengine console — go to Pair a machine, and enter the code.")
		}
		u.Say("Code: %s   (expires in %d minutes)", code, minutes)
	})
	if err != nil {
		return "", err
	}
	u.OK("paired as %q, for %s", paired.Name, paired.OwnerName)
	return paired.MachineKey, nil
}

// Pair connects this machine to the DutyBoard at server, under name, and keeps what that gives it:
// the machine key, and in cfg where the board and its console are. It asks nothing, so a terminal
// and a window can both use it. announce is told the code a person has to approve and the console
// link that approves it — empty when the board does not say where its console is — and Pair then
// waits until someone does, the code expires, or ctx ends.
func Pair(ctx context.Context, cfg *state.Config, server, name string, announce func(code, link string, minutes int)) (*board.Paired, error) {
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	health, err := boardAt(ctx, server)
	if err != nil {
		return nil, err
	}
	if name = strings.TrimSpace(name); name == "" {
		name = defaultMachineName()
	}
	api := board.New(server, "")
	p, err := api.StartPairing(ctx, name, runtime.GOOS, runtime.GOARCH, Version)
	if err != nil {
		return nil, err
	}
	console := health.ConsoleURL
	if console == "" {
		console = cfg.Console
	}
	link := ""
	if console != "" {
		// The console's routes are after the #, wherever the console itself is served.
		link = strings.TrimRight(console, "/") + "/#/pair?code=" + p.UserCode
	}
	announce(p.UserCode, link, p.ExpiresIn/60)
	paired, err := api.WaitForApproval(ctx, p)
	if err != nil {
		return nil, err
	}
	if err := state.SetCredential(state.MachineKey, paired.MachineKey); err != nil {
		return nil, fmt.Errorf("storing the machine key: %w", err)
	}
	cfg.Server, cfg.MachineID, cfg.MachineName, cfg.AgentPrefix = server, paired.MachineID, paired.Name, paired.AgentPrefix
	if console != "" {
		cfg.Console = console
	}
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	return paired, nil
}

// ErrNotBoard is an address that did not answer as a DutyBoard API.
var ErrNotBoard = errors.New("not a DutyBoard API")

// boardAt checks that server is a DutyBoard API that machines can be paired with.
func boardAt(ctx context.Context, server string) (*provision.HealthInfo, error) {
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	health, err := provision.Health(ctx, server)
	if err != nil || health.Service != "dutyboard" {
		return nil, fmt.Errorf("%s is %w (%v)", server, ErrNotBoard, err)
	}
	if !health.Machines {
		return nil, fmt.Errorf("the DutyBoard at %s (v%s) is too old to pair machines — upgrade it with `dutyboard --provision-only`", server, health.Version)
	}
	return health, nil
}

// ResolveBoard turns the address a person was given into a DutyBoard API address. That is the API
// address itself, or the console's — the one people actually have, since it is what they open — whose
// config.js names the API it was deployed next to. A console served by a dev server names none, and
// then there is nothing to find.
func ResolveBoard(ctx context.Context, address string) (string, error) {
	address = strings.TrimSpace(address)
	if _, err := boardAt(ctx, address); err == nil {
		return strings.TrimRight(address, "/"), nil
	} else if api, ok := consoleAPI(ctx, address); ok {
		if _, err := boardAt(ctx, api); err != nil {
			return "", err
		}
		return api, nil
	} else {
		return "", err
	}
}

var consoleConfig = regexp.MustCompile(`(?s)window\.DUTYBOARD_CONFIG\s*=\s*(\{.*\})\s*;`)

// consoleAPI reads the API address out of the config.js next to the console at address.
func consoleAPI(ctx context.Context, address string) (string, bool) {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", false
	}
	// Whatever page of the console was copied — its routes are after the # — config.js is beside index.html.
	u.Fragment, u.RawQuery = "", ""
	u.Path = strings.TrimSuffix(u.Path, "index.html")
	if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	u.Path += "config.js"
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", false
	}
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	m := consoleConfig.FindSubmatch(body)
	if m == nil {
		return "", false
	}
	var cfg struct {
		API string `json:"api"`
	}
	if json.Unmarshal(m[1], &cfg) != nil || cfg.API == "" {
		return "", false
	}
	return strings.TrimRight(cfg.API, "/"), true
}

// DefaultMachineName is what this machine is called when nobody names it: its hostname.
func DefaultMachineName() string { return defaultMachineName() }

func defaultMachineName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "machine"
	}
	if b, err := os.ReadFile("/proc/version"); err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft") {
		host += "-wsl"
	}
	return strings.ToLower(host)
}

// offerLink offers to work the repository the program was run in: on a board that already names
// that repository, or on a new board made from it. The folder itself is never used — the daemon
// clones the repository into its own projects folder, so this is only a way to find the board.
func offerLink(ctx context.Context, u *ui.UI, api *board.Client) error {
	wd, err := os.Getwd()
	if err != nil {
		return nil
	}
	top, err := worktree.Toplevel(ctx, wd)
	if err != nil {
		return nil // not in a repository: nothing to offer
	}
	if strings.HasPrefix(filepath.Clean(top), filepath.Clean(state.Path())) {
		return nil // inside the daemon's own clones and worktrees
	}
	remote := worktree.Remote(ctx, top)
	if remote == "" {
		u.Warn("%s has no remote. A board is worked from a repository URL, so push it somewhere this machine can clone from first.", top)
		return nil
	}
	out, err := exec.CommandContext(ctx, "git", "-C", top, "remote", "get-url", remote).Output()
	if err != nil {
		return nil
	}
	url := strings.TrimSpace(string(out))

	boards, err := api.Boards(ctx)
	if err != nil {
		return err
	}
	var matching []board.BoardView
	for _, b := range boards {
		if b.Profile != nil && sameRepo(b.Profile.RepoURL, url) {
			if b.Linked {
				return nil // already worked here
			}
			matching = append(matching, b)
		}
	}
	opts := []string{}
	for _, b := range matching {
		opts = append(opts, fmt.Sprintf("Work %s (%s) on this machine", b.Name, b.ProjectID))
	}
	opts = append(opts, "Create a board for this repository", "Not now")
	u.Step("%s", url)
	if len(matching) == 0 {
		u.Say("No board of yours names this repository. (To use an existing board, set its repository in the console.)")
	}
	pick, err := u.Choose("What should this machine do with it?", opts, len(opts)-2)
	if err != nil {
		return err
	}
	var projectID string
	switch {
	case pick == len(opts)-1:
		return nil
	case pick == len(opts)-2:
		if projectID, err = createBoard(ctx, u, api, top, url); err != nil {
			return err
		}
	default:
		projectID = matching[pick].ProjectID
	}
	linked, err := api.Link(ctx, projectID, "")
	if err != nil {
		return err
	}
	u.OK("this machine works %s; it clones the repository into its projects folder", projectID)
	if linked.SetupDutyID != "" {
		u.Say("First up: a setup duty that gets this machine ready for the project.")
	}
	return nil
}

var repoPath = regexp.MustCompile(`^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?/?$`)

// sameRepo compares repository URLs the way a person means them: git@github.com:a/b.git and
// https://github.com/a/b are the same repository.
func sameRepo(a, b string) bool {
	norm := func(u string) string {
		u = strings.ToLower(strings.TrimSpace(u))
		if m := repoPath.FindStringSubmatch(u); m != nil {
			return m[1] + "/" + m[2]
		}
		return u
	}
	return a != "" && norm(a) == norm(b)
}

var projectTypes = []struct{ key, label string }{
	{"game", "Game"}, {"website", "Website"}, {"webapp", "Web app"}, {"mobile", "Mobile app"},
	{"desktop", "Desktop app"}, {"api", "API / backend"}, {"cli-lib", "CLI or library"}, {"other", "Other"},
}

func createBoard(ctx context.Context, u *ui.UI, api *board.Client, repo, url string) (string, error) {
	name, err := u.Ask("Board name", filepath.Base(repo))
	if err != nil {
		return "", err
	}
	labels := make([]string, len(projectTypes))
	for i, t := range projectTypes {
		labels[i] = t.label
	}
	kind, err := u.Choose("What kind of project is it?", labels, -1)
	if err != nil {
		return "", err
	}
	profile := map[string]any{"type": projectTypes[kind].key}
	if projectTypes[kind].key == "other" {
		other, err := u.Ask("Describe the kind of project", "")
		if err != nil {
			return "", err
		}
		profile["type_other"] = other
	}
	desc, err := u.Ask("One line about it (optional)", "-")
	if err != nil {
		return "", err
	}
	if desc != "-" {
		profile["description"] = desc
	}
	profile["repo_url"] = url
	profile["default_branch"] = worktree.DefaultBranch(ctx, repo, worktree.Remote(ctx, repo))
	mode, err := u.Choose("When a duty is done, its work should be:", []string{
		"Pushed to " + profile["default_branch"].(string),
		"Squashed into one commit named for the duty, and pushed to " + profile["default_branch"].(string),
		"Opened as a pull request",
	}, 0)
	if err != nil {
		return "", err
	}
	profile["git"] = map[string]any{"mode": []string{"push", "squash", "pr"}[mode]}
	agents := []string{"Claude Code", "Codex", "Cursor"}
	agent, err := u.Choose("Which agent works its duties on this machine?", agents, 0)
	if err != nil {
		return "", err
	}
	parallelText, err := u.Ask("How many duties may run at once on this board", "1")
	if err != nil {
		return "", err
	}
	parallel, _ := strconv.Atoi(parallelText)
	if parallel < 1 {
		parallel = 1
	}
	id, err := api.CreateBoard(ctx, map[string]any{
		"name": name, "project_id": name, "profile": profile,
		"runner": map[string]any{"agent": []string{"claude-code", "codex", "cursor"}[agent], "parallel": parallel},
	})
	if err != nil {
		return "", err
	}
	u.OK("created board %q; its first duty writes the project's rules", id)
	return id, nil
}
