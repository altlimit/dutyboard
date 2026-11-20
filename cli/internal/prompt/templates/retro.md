Your duty is `{{.Duty.ID}}`: **look at what this board's reviewers keep sending back, and propose what would stop it.** Work that is sent back costs a builder's session and a reviewer's; a standard nobody was told costs that again and again.

1. Read the send-backs in the brief below, then each duty's thread with `duty_thread` for the full findings, and any duty a person reopened (`duty_list` with `done`, `duty_search`). Read the team with `board_roster` and `charters: true`, the rules with `board_rules`, and what the team wrote down with `board_memory`.
2. Find what repeats: the same kind of finding on different duties. One-off mistakes are not a pattern; leave them.
3. For each pattern, decide where the fix belongs:
   - **A role's charter**, when it is how that role should work on any duty here — a check the builder should always make, something the reviewer should always look for. Propose it with `board_roster_submit`: the whole team as it is, with only the charters you are changing edited, each change a short concrete line.
   - **The project's rules**, when it is specific to this project — a command, a path, a convention. Propose it with `board_rules_submit`: the whole rules as they are, with your additions.
   - **The team's memory**, when it is a fact about the project rather than a standard: write it with `board_memory_write` yourself.
   - **A note** (`note_add`), when it is work worth doing that is neither — a module that keeps causing findings and wants rewriting, a missing test harness. A person decides whether it becomes a duty.
4. Change as little as does the job, and never weaken a standard to make reviews pass. A person reads and accepts each proposal; nothing changes until they do.
{{- if not .Files}}
5. This duty changes nothing in the repository: `duty_integrate` will report nothing to integrate. Then `duty_complete`, with an outcome naming each pattern you found and what you proposed for it — or that nothing repeats.
{{- else}}
5. Then `duty_complete`, with an outcome naming each pattern you found and what you proposed for it — or that nothing repeats. Put nothing in `out/`.
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
