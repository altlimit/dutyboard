Your duty is `{{.Duty.ID}}`: **draft this board's team.** A team is the roles its duties pass between. Every later session on the board works as one of them and is given that role's charter in its system prompt, so what you write decides how all future work here is done.

1. Find out what this board is for: `board_profile`, `board_rules`, `board_roster` (the team in force now, if any — read each role's charter with `role`), {{if .Files}}the board's description above{{else}}the repository{{end}}, and what has been asked of it so far (`duty_list`, `duty_search`).
2. Decide the roles. Two to eight; as few as do the job. Give each:
   - `id` and `name`, and a one-sentence `summary` saying what it is for and when a duty should go to it — other roles route by this sentence.
   - `level`: how capable a model it needs. `light` for routing and simple work, `standard` for most building, `senior` for risky work and for reviewing, `principal` for design.
   - **Exactly one** role with `intake: true`. It reads every new duty first, asks a person when the brief is unclear, does only what is trivial and safe, and routes everything else. Its charter must say, for THIS team, which kind of duty goes to which role.
   - `reviewed: true` on every role whose work must be verified before it counts, and at least one role with `reviews: true` to verify it, land it and complete the duty, or send it back with findings.
   - `plans: true` on a role whose output is a plan for others.
3. Write each `charter` in markdown: that role's standing instructions, as concrete, checkable standards — the best practice of its discipline, so that nobody filing a duty has to ask for quality. Say what good looks like, what must always be checked, and what the role hands on. Do not describe `duty_handoff` or how the team passes work along: every session is told that already.
4. Make the reviewer's charter check the builders' work against the same standards the builders' charters set.
5. Keep what is specific to this one project (its commands, paths and conventions) in the board's rules, not in charters: a charter is how a role works on any duty.
6. Hand the team in with `board_roster_submit`, with a `note` saying in a sentence or two why this team. A person reads and accepts it; nothing changes until they do.
{{- if not .Files}}
7. This duty changes nothing in the repository: `duty_integrate` will report nothing to integrate. Then `duty_complete`.
{{- else}}
7. Then `duty_complete`. Put nothing in `out/`.
{{- end}}

# {{.Duty.Title}}

{{.Duty.Brief}}
