Your duty is `{{.Duty.ID}}`: **make this machine ready to work on the project.** You are in a worktree of this machine's own clone of it.

1. Work out everything the project needs to build, run and test: engine or SDK, runtimes, package managers, test tools, export templates. Read the repository (manifests, lockfiles, CI workflows, READMEs) and `board_profile`.
{{template "ready" .}}
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
