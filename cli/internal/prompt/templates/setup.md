Your duty is `{{.Duty.ID}}`: **make this machine ready to work on the project.** You are in a worktree of this machine's own clone of it.

1. Work out everything the project needs to build, run and test: engine or SDK, runtimes, package managers, test tools, export templates. Read the repository (manifests, lockfiles, CI workflows, READMEs) and `board_profile`.
2. This is an ordinary developer machine. Use what it already has: the tools listed in your system prompt first, then PATH and the usual install locations.
3. Download what is missing into `$DUTYBOARD_TOOLS/<name>/<version>/` from the official source, and register it with `tools_register` — that is how every later session on this machine finds it, so nothing is downloaded twice. The project's own package managers (`npm ci`, `pip install` into a venv, and so on) are fine as usual. Only something that needs admin rights or a person to accept a licence goes on the board, as `needs_decision` with the exact command to run.
4. Prove each tool works by running it (for example its `--version`); register any tool you found already installed too, with its path.
5. Record what you established with `board_profile_propose`:
   - `toolchain`: every tool the project needs, with versions;
   - `test_command`: the command that runs the whole test suite from the project root, if you found one;
   - `test_command` and `prep` are run with bash from the worktree root (Git Bash on Windows), so write them as bash: `cd tests/e2e && npm ci`, not `pushd`/`cmd` or PowerShell syntax;
   - `worktree`: `prep` (what makes a fresh checkout ready, e.g. `npm ci`), `prep_inputs` (the lockfiles that mean prep must run again), `cache` (expensive ignored folders worth reusing, e.g. `node_modules`), and `copy` (files git does not carry that the project needs to run, e.g. `.env`). Those files are copied into every worktree from `{{.LocalDir}}` on this machine; if one is not there, ask on the board for a person to put it there — never invent a secret;
   - `deploy`: how the project ships — `ci` if a workflow in `.github/workflows` deploys on push to the default branch, `ci-dispatch` if a deploy workflow only runs on `workflow_dispatch`, `command` for a deploy script, `none` if nothing deploys.
   - this board's other repositories, if the system prompt lists any, are already open: do the same for each, and record its `test_command` and `worktree` under `repos` in `board_profile_propose`, by name;
6. Only the project's needs go on the board. What this session was or was not allowed to run is the runner's configuration, not the project's: work around a refused command and leave it out of what you record and raise.
7. This duty normally changes nothing in the repository: `duty_integrate` will report nothing to integrate, which is success. Then `duty_complete` saying what is installed where and what you recorded.

{{- if .Hints}}

# Where to start, for this kind of project

A starting point to confirm against the repository, not a list to install from:

{{.Hints}}
{{- end}}
{{- if .Detected}}

# What the daemon read from .github/workflows

{{.Detected}}. Confirm it against what the workflow actually runs before recording `deploy`.
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
