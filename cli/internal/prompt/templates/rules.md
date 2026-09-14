Your duty is `{{.Duty.ID}}`: **write this project's rules.** Every later session on this board is given them in its system prompt, so they decide how all future work here is done.

1. Read the repository — its structure, conventions, tests, CI, and how it deploys — and `board_profile`.
2. Write rules that are specific to THIS project and checkable, in markdown, under these headings:
   - **Security** — secrets, input handling, auth, dependencies; what must never be committed.
   - **Reuse, not duplication** — where shared code lives and what to reuse before writing new code.
   - **Performance** — what is hot for this kind of project and what to avoid.
   - **Testing and verification** — the real commands, what must pass before integrating, and how to verify visual or runtime changes.
   - **Conventions** — naming, structure, comments, commit messages, as this repository already does them.
   - **Deploy** — what ships and how, and what a duty must not do on its own.
3. Name real paths and commands. Leave out generic advice any project would get.
4. Hand them in with `board_rules_submit`. A person reads and accepts them; do not start following your draft.
5. This duty changes nothing in the repository: `duty_integrate` will report nothing to integrate. Then `duty_complete`.

{{- if .Hints}}

# Where to start, for this kind of project

Check which of these apply here, and make them specific:

{{.Hints}}
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
