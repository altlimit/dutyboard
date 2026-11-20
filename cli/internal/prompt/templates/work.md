{{- if .Resuming}}
You are resuming duty `{{.Duty.ID}}` in the same {{if .Files}}folder{{else}}worktree{{end}}{{if .Attempt}} (attempt {{.Attempt}}){{end}}. Your earlier progress is in the files and in the duty's thread (`duty_thread`). Pick up where it stopped.
{{- if .Duty.UnblockedContext}}

The question you parked on has been answered:
- You asked: {{.Duty.UnblockedContext.LastQuestion}}
- Answer: {{.Duty.UnblockedContext.HumanResolution}}

That answer is a decision, not a suggestion. If it turns out not to work in practice, say so on the board rather than keep at it.
{{- end}}
{{- else}}
Your duty is `{{.Duty.ID}}`.
{{- end}}

{{- if .Duty.Reopened}}

THIS DUTY CAME BACK. It was finished before ({{.Duty.Reopened.Times}} time(s)) and a person sent it back:
> {{.Duty.Reopened.Note}}

The last attempt claimed: {{.Duty.Reopened.PreviousOutcome}}
Read the note before the brief, and `duty_thread` before you change anything.
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
{{- with .Duty.Team}}{{with .Handoff}}

{{if .SentBack}}**{{.FromName}} reviewed this and sent it back.** These findings are what you fix now — every one — before handing it on again:{{else}}**{{.FromName}} handed this to you.** Their note is part of your brief:{{end}}

{{.Note}}

The earlier roles' work is already in this {{if $.Files}}folder{{else}}worktree{{end}}. Look at what is there{{if not $.Files}} (`git log` and the diff against the main branch){{end}} and at `duty_thread` before changing anything; do not start over.
{{- with .Checks}}

This machine ran the project's tests (`{{.Command}}`) on commit `{{.Commit}}` as it was handed to you, and they passed. Do not run the whole suite again unless the work changes after that commit: spend the time on what tests cannot tell you. Landing runs them once more after rebasing.
{{- end}}
{{- end}}
{{- if .Role.Reviews}}
{{- if eq .Risk "high"}}

**This duty is high risk.** Review it line by line, not by sampling: who may call each changed path and what stops everyone else, every input from outside, what happens to stored data when it fails half-way, secrets, and the paths nobody tested. Exercise it end to end yourself.
{{- else if eq .Risk "low"}}

This duty is low risk: check that it does what was asked and breaks nothing next to it. Do not audit beyond the change.
{{- end}}
{{- end}}{{end}}

{{- if or .Duty.SourceNoteIDs .Duty.SourceNoteID}}

This duty was suggested from notes {{if .Duty.SourceNoteIDs}}{{range .Duty.SourceNoteIDs}}`{{.}}` {{end}}{{else}}`{{.Duty.SourceNoteID}}`{{end}}and approved by a person. Read ALL those notes with `duty_get`, their threads with `duty_thread` and their files with `duty_attachments` for the source context. The approved duty's brief and human answer define the work; other suggestions on the note are separate duties.
{{- end}}

{{- if .Check}}

Its schedule runs a check before waking anyone. The check, `{{.Duty.Check}}`, said:

```
{{.Check}}
```

That is why you were started: work from what it found.
{{- end}}

{{- if .Duty.Notes}}

People have written on this duty. Their notes are part of the brief, and a newer one wins over the brief where they disagree:
{{- range .Duty.Notes}}
- {{.From}}: {{.Message}}
{{- end}}
{{- end}}

{{- if and .Files .Files.Service}}
{{- if .Files.Inputs}}

The files that came with it are in `in/`: {{join .Files.Inputs ", "}}.
{{- end}}
{{- if .Files.Missing}} {{.Files.Missing}} more were still being uploaded when it started and are not there; if the task needs them, ask on the board.{{end}}

{{if .MustHandOff}}When it is done: check it in the account, then `duty_handoff` to the reviewer. Then stop.{{else}}When it is done: check it in the account, then `duty_complete` with an outcome summary naming what changed there. Then stop.{{end}}
{{- else if .Files}}

{{if .Files.Inputs}}The files that came with it are in `in/`: {{join .Files.Inputs ", "}}.{{else}}No files came with it.{{end}}
{{- if .Files.Missing}} {{.Files.Missing}} more were still being uploaded when it started and are not there; if the task needs them, ask on the board.{{end}}

{{if .MustHandOff}}When it is done: put what it produces in `out/`, check it, then `duty_handoff` to the reviewer. Then stop.{{else}}When it is done: put what it produces in `out/`, check it, then `duty_complete` with a specific outcome summary. Then stop.{{end}}
{{- else}}
{{- if .Duty.AttachmentCount}}

This duty has {{.Duty.AttachmentCount}} attachment(s). Read them with `duty_attachments` before anything else.
{{- end}}

{{if .MustHandOff}}When it is done: verify it, commit, then `duty_handoff` to the reviewer. Then stop.{{else if and .Duty.Team .Duty.Team.Role.Intake}}Hand it to the role that should work it with `duty_handoff`, or — only if it is trivial and safe — do it, verify it, commit, `duty_integrate`, then `duty_complete`. Then stop.{{else}}When it is done: verify it, commit, `duty_integrate`, then `duty_complete` with a specific outcome summary. Then stop.{{end}}
{{- end}}
