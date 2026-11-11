Your review duty is `{{.Duty.ID}}`.

# {{.Duty.Title}}
Source note: `{{.Duty.SourceNoteID}}`.

{{.Duty.Brief}}

Use duty_get on the source note to read its contents and linked suggestions, and duty_thread on the source note to read any discussion or context added later. Follow suggestions_cursor with duty_get's suggestions_cursor argument if more exist, so existing work is not missed. Use duty_attachments on the source note and read its files; pending uploads are not readable yet. Review the review duty's thread before repeating earlier work.
{{if .Duty.UnblockedContext}}
The person answered your question: {{.Duty.UnblockedContext.HumanResolution}}
{{end}}
{{range .Duty.Notes}}
{{.From}} added: {{.Message}}
{{end}}
