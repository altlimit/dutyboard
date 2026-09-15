package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/runner"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// boardMCPServers are the MCP servers a board's sessions get on this machine, with this machine's
// secrets filled in, and a line for each one it cannot give them: a secret not set here, or a
// command not installed. A server that cannot start is left out rather than handed to a session
// that would find it broken halfway through a duty.
func (d *Daemon) boardMCPServers(v board.BoardView) (servers []runner.MCPServer, missing []string) {
	if v.Profile == nil {
		return nil, nil
	}
	for _, s := range v.Profile.MCPServers {
		var unset []string
		values := map[string]string{}
		for _, name := range s.Secrets {
			val, err := state.Credential(state.MCPSecret(v.ProjectID, s.Name, name))
			if err != nil || val == "" {
				unset = append(unset, name)
				continue
			}
			values[name] = val
		}
		if len(unset) > 0 {
			missing = append(missing, fmt.Sprintf("MCP server %q needs %s on this machine — run `dutyboard --mcp-secrets`", s.Name, strings.Join(unset, ", ")))
			continue
		}
		if agentName(v) == "cursor" && s.URL != "" && len(s.Secrets) > 0 {
			missing = append(missing, fmt.Sprintf("MCP server %q is a URL that needs a secret, which a Cursor session could only be given written into its worktree — it is left out of Cursor sessions", s.Name))
			continue
		}
		if s.Command != "" && !d.commandExists(s.Command) {
			missing = append(missing, fmt.Sprintf("MCP server %q runs `%s`, which is not installed on this machine", s.Name, s.Command))
			continue
		}
		out := runner.MCPServer{Name: s.Name, Command: s.Command, Args: s.Args, URL: s.URL, Tools: s.Tools, Secrets: values}
		if s.URL == "" {
			out.Env = s.Env
		}
		servers = append(servers, out)
	}
	return servers, missing
}

// commandExists looks a server's command up the way a session will find it: on PATH, or among the
// tools registered on this machine.
func (d *Daemon) commandExists(command string) bool {
	if strings.ContainsAny(command, `/\`) {
		_, err := os.Stat(command)
		return err == nil
	}
	if _, err := exec.LookPath(command); err == nil {
		return true
	}
	for _, t := range d.tools.List() {
		if t.Missing {
			continue
		}
		for _, name := range []string{command, command + ".exe", command + ".cmd"} {
			if fi, err := os.Stat(filepath.Join(t.Path, name)); err == nil && !fi.IsDir() {
				return true
			}
		}
	}
	return false
}
