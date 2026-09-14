package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/daemon"
	"github.com/altlimit/dutyboard/cli/internal/localmcp"
	"github.com/altlimit/dutyboard/cli/internal/provision"
	"github.com/altlimit/dutyboard/cli/internal/service"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
	"github.com/altlimit/dutyboard/cli/internal/worktree"
)

// Start is `dutyboard` with no job flag: pair if this machine is not paired, link the repository it
// is run in if that is not linked, then run the daemon — or hand the new link to the one already
// running.
func Start(ctx context.Context, u *ui.UI, f Flags) error {
	cfg, err := state.LoadConfig()
	if err != nil {
		return err
	}
	key, _ := state.Credential(state.MachineKey)
	if key == "" || cfg.Server == "" {
		if key, err = pairMachine(ctx, u, cfg, f); err != nil {
			return err
		}
	}
	if f.Root != "" {
		cfg.ProjectsRoot = f.Root
		if err := cfg.Save(); err != nil {
			return err
		}
	}
	api := board.New(cfg.Server, key)

	if u.Interactive {
		if err := offerLink(ctx, u, api); err != nil {
			return err
		}
	}

	if localmcp.Running() {
		c, err := localmcp.Dial()
		if err == nil {
			defer c.Close()
			if err := c.Reload(); err == nil {
				u.OK("dutyboard is already running on this machine, and has picked up any change")
				return nil
			}
		}
	}

	if u.Interactive && !f.NoService && !service.Installed() {
		yes, err := u.Confirm("Start dutyboard automatically when you log in?", true)
		if err != nil {
			return err
		}
		if yes {
			exe, _ := os.Executable()
			logs, err := service.Install(exe)
			if err == nil {
				u.OK("installed and started — follow it with: %s", logs)
				return nil
			}
			u.Warn("could not install the service (%v); running here instead", err)
		}
	}

	d, err := daemon.New(daemon.Options{Version: Version, Config: cfg, Key: key})
	if err != nil {
		return err
	}
	u.Say("Working. Ctrl+C stops it; the duties it holds are resumed next time.")
	return d.Run(ctx)
}

// pairMachine connects this machine to a DutyBoard: an existing one by URL, or one it provisions
// first. Answers the machine key, stored.
func pairMachine(ctx context.Context, u *ui.UI, cfg *state.Config, f Flags) (string, error) {
	if !u.Interactive {
		return "", errors.New("this machine is not paired with a DutyBoard yet — run `dutyboard` once in a terminal")
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
			server, err = u.Ask("DutyBoard API URL (the console shows it under Runners)", "")
			if err != nil {
				return "", err
			}
		}
	}
	server = strings.TrimRight(strings.TrimSpace(server), "/")
	health, err := provision.Health(ctx, server)
	if err != nil || health.Service != "dutyboard" {
		return "", fmt.Errorf("%s is not a DutyBoard API (%v)", server, err)
	}
	if !health.Machines {
		return "", fmt.Errorf("the DutyBoard at %s (v%s) is too old to pair machines — upgrade it with `dutyboard --provision-only`", server, health.Version)
	}

	name := f.Name
	if name == "" {
		if name, err = u.Ask("Name for this machine", defaultMachineName()); err != nil {
			return "", err
		}
	}
	api := board.New(server, "")
	p, err := api.StartPairing(ctx, name, runtime.GOOS, runtime.GOARCH, Version)
	if err != nil {
		return "", err
	}
	console := health.ConsoleURL
	if console == "" {
		console = cfg.Console
	}
	u.Step("Approve this machine")
	if console != "" {
		link := strings.TrimRight(console, "/") + "/#/pair?code=" + p.UserCode
		if !strings.Contains(console, "/app") {
			link = strings.TrimRight(console, "/") + p.VerifyPath + "?code=" + p.UserCode
		}
		u.Say("Open %s", link)
		openBrowser(link)
	} else {
		u.Say("Open your DutyBoard console, go to Pair a machine, and enter the code.")
	}
	u.Say("Code: %s   (expires in %d minutes)", p.UserCode, p.ExpiresIn/60)
	paired, err := api.WaitForApproval(ctx, p)
	if err != nil {
		return "", err
	}
	if err := state.SetCredential(state.MachineKey, paired.MachineKey); err != nil {
		return "", fmt.Errorf("storing the machine key: %w", err)
	}
	cfg.Server, cfg.MachineID, cfg.MachineName, cfg.AgentPrefix = server, paired.MachineID, paired.Name, paired.AgentPrefix
	if console != "" {
		cfg.Console = console
	}
	if err := cfg.Save(); err != nil {
		return "", err
	}
	u.OK("paired as %q, for %s", paired.Name, paired.OwnerName)
	return paired.MachineKey, nil
}

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

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		for _, opener := range []string{"wslview", "xdg-open"} {
			if _, err := exec.LookPath(opener); err == nil {
				cmd = exec.Command(opener, url)
				break
			}
		}
	}
	if cmd != nil {
		_ = cmd.Start()
	}
}

// offerLink links the repository the program was run in, when it is not linked yet.
func offerLink(ctx context.Context, u *ui.UI, api *board.Client) error {
	wd, err := os.Getwd()
	if err != nil {
		return nil
	}
	top, err := worktree.Toplevel(ctx, wd)
	if err != nil {
		return nil // not in a repository: nothing to link
	}
	top = filepath.Clean(top)
	if strings.HasPrefix(top, filepath.Clean(state.Path("worktrees"))) {
		return nil // a duty's own worktree
	}
	workspaces, err := state.Workspaces()
	if err != nil {
		return err
	}
	for _, w := range workspaces {
		if filepath.Clean(w.Path) == top {
			return nil
		}
	}

	boards, err := api.Boards(ctx)
	if err != nil {
		return err
	}
	opts := []string{}
	for _, b := range boards {
		label := fmt.Sprintf("%s (%s)", b.Name, b.ProjectID)
		if b.Linked {
			label += " — already linked to another folder here"
		}
		opts = append(opts, label)
	}
	opts = append(opts, "Create a new board for this repository", "Don't link this folder")
	u.Step("%s is not linked to a board", top)
	pick, err := u.Choose("Link it to:", opts, len(opts)-2)
	if err != nil {
		return err
	}
	var projectID string
	switch {
	case pick == len(opts)-1:
		return nil
	case pick == len(opts)-2:
		if projectID, err = createBoard(ctx, u, api, top); err != nil {
			return err
		}
	default:
		projectID = boards[pick].ProjectID
	}
	linked, err := api.Link(ctx, projectID, top)
	if err != nil {
		return err
	}
	if err := state.SetWorkspace(projectID, top); err != nil {
		return err
	}
	u.OK("linked %s to %s", top, projectID)
	if linked.SetupDutyID != "" {
		u.Say("First up: a setup duty that gets this machine ready for the project.")
	}
	return nil
}

var projectTypes = []struct{ key, label string }{
	{"game", "Game"}, {"website", "Website"}, {"webapp", "Web app"}, {"mobile", "Mobile app"},
	{"desktop", "Desktop app"}, {"api", "API / backend"}, {"cli-lib", "CLI or library"}, {"other", "Other"},
}

func createBoard(ctx context.Context, u *ui.UI, api *board.Client, repo string) (string, error) {
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
	remote := worktree.Remote(ctx, repo)
	if remote != "" {
		if url, err := exec.CommandContext(ctx, "git", "-C", repo, "remote", "get-url", remote).Output(); err == nil {
			profile["repo_url"] = strings.TrimSpace(string(url))
		}
	}
	profile["default_branch"] = worktree.DefaultBranch(ctx, repo, remote)
	mode, err := u.Choose("When a duty is done, its work should be:", []string{"Pushed to " + profile["default_branch"].(string), "Opened as a pull request"}, 0)
	if err != nil {
		return "", err
	}
	profile["git"] = map[string]any{"mode": []string{"push", "pr"}[mode]}
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
		"runner": map[string]any{"agent": "claude-code", "parallel": parallel},
	})
	if err != nil {
		return "", err
	}
	u.OK("created board %q; its first duty writes the project's rules", id)
	return id, nil
}
