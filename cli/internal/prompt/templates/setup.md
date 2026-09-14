Your duty is `{{.Duty.ID}}`: **make this machine ready to work on the project.** The project is linked from `{{.ProjectRoot}}`; you are in a worktree of it.

1. Work out everything the project needs to build, run and test: engine or SDK, runtimes, package managers, test tools, export templates. Read the repository (manifests, lockfiles, CI workflows, READMEs) and `board_profile`.
2. Check what this machine already has: PATH, the usual install locations, and the tools listed in your system prompt.
3. Install what is missing into the dutyboard tools folder (`$DUTYBOARD_TOOLS`), one folder per tool and version, from official sources only, verifying checksums where they are published. Never use sudo or a system package manager. Anything that needs admin rights or a licence acceptance goes on the board as `needs_decision`, with the exact command a person should run.
4. Prove each tool works by running it (for example its `--version`).
5. Record what you established with `board_profile_propose`:
   - `toolchain`: every tool the project needs, with versions;
   - `test_command`: the command that runs the whole test suite from the project root, if you found one;
   - `worktree`: `prep` (what makes a fresh checkout ready, e.g. `npm ci`), `prep_inputs` (the lockfiles that mean prep must run again), `cache` (expensive ignored folders worth reusing, e.g. `node_modules`), and `copy` (untracked files in `{{.ProjectRoot}}` the project needs to run, e.g. `.env` — ask before listing anything that looks like a secret);
   - `deploy`: how the project ships — `ci` if a workflow in `.github/workflows` deploys on push to the default branch, `ci-dispatch` if a deploy workflow only runs on `workflow_dispatch`, `command` for a deploy script, `none` if nothing deploys.
6. This duty normally changes nothing in the repository: `duty_integrate` will report nothing to integrate, which is success. Then `duty_complete` saying what is installed where and what you recorded.

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
