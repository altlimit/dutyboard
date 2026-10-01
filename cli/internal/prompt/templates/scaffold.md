Your duty is `{{.Duty.ID}}`: **this project is new — build its first version, and make this machine ready to work on it.** You are in a worktree of this machine's own clone of its repository, which holds nothing yet but a README.

1. Build the starting point the board describes — its type and description in `board_profile`, and the brief below:
   - Choose the stack. Use the one the board names (its `stack`, or its description) if it names one; otherwise the plainest current, well-supported choice for this kind of project. Put a question on the board (`needs_decision`, with the default you would pick) only when the description leaves out something that would be costly to change later.
   - Scaffold it with the stack's own generator where it has one, then make it do the smallest real thing the description asks for — not a placeholder.
   - Give it a test suite with at least one real test, a `.gitignore` for the stack, and a README that says how to run it and how to test it.
   - Keep it small: the board's later duties build the rest. Add no deploys, accounts or services nobody asked for.
   - Commit as you go.
{{template "ready" .}}
7. Run the whole test suite, then `duty_integrate` — this duty lands the project's first version — and `duty_complete` saying what you built and on what stack, what is installed where, and what you recorded.

{{- if .Hints}}

# What this kind of project usually needs

{{.Hints}}
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
