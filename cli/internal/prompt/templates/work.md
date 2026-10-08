{{- if .Resuming}}
You are resuming duty `{{.Duty.ID}}` in the same {{if .Files}}folder{{else}}worktree{{end}}{{if .Attempt}} (attempt {{.Attempt}}){{end}}. Your earlier progress is in the files and in the duty's thread (`duty_thread`). Pick up where it stopped.
{{- if .Duty.UnblockedContext}}

The question you parked on has been answered:
- You asked: {{.Duty.UnblockedContext.LastQuestion}}
- Answer: {{.Duty.UnblockedContext.HumanResolution}}

That answer is a decision, not a suggestion.
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

{{- if .Files}}

{{if .Files.Inputs}}The files that came with it are in `in/`: {{join .Files.Inputs ", "}}.{{else}}No files came with it.{{end}}
{{- if .Files.Missing}} {{.Files.Missing}} more were still being uploaded when it started and are not there; if the task needs them, ask on the board.{{end}}

When it is done: put what it produces in `out/`, check it, then `duty_complete` with a specific outcome summary. Then stop.
{{- else}}
{{- if .Duty.AttachmentCount}}

This duty has {{.Duty.AttachmentCount}} attachment(s). Read them with `duty_attachments` before anything else.
{{- end}}

When it is done: verify it, commit, `duty_integrate`, then `duty_complete` with a specific outcome summary. Then stop.
{{- end}}
