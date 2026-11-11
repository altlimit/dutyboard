Your review duty is `{{.Duty.ID}}`.

# {{.Duty.Title}}
Source notes: {{if .Duty.SourceNoteIDs}}{{range .Duty.SourceNoteIDs}}`{{.}}` {{end}}{{else}}`{{.Duty.SourceNoteID}}`{{end}}.

{{.Duty.Brief}}

Use duty_get on EVERY source note to read its contents and linked suggestions, and duty_thread on each note to read any discussion or context added later. Follow suggestions_cursor with duty_get's suggestions_cursor argument if more exist, so existing work is not missed. Use duty_attachments on each source note and read its files; pending uploads are not readable yet. Review the review duty's thread before repeating earlier work.
{{if .Duty.UnblockedContext}}
The person answered your question: {{.Duty.UnblockedContext.HumanResolution}}
{{end}}
{{range .Duty.Notes}}
{{.From}} added: {{.Message}}
{{end}}

Consider the notes together. Each duty_suggest must include source_note_ids for the 1–50 notes that support that proposal. Related notes can support one duty; one note can support several duties. Read all notes in this review before deciding what to suggest. Notes added afterward belong to the next review.
