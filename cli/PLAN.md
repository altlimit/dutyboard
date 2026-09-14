# `dutyboard` — the runner and provisioner

Status: **phases 1–5 built** (server, provisioner, daemon, console, setup/rules/deploy) — see §15 and "Built so far" at the end. Written 2026-09-14. Decisions marked **(assumed)** are defaults
chosen while planning; change them here before the phase that depends on them starts.

## 1. Why this exists

DutyBoard holds the work, but today the loop that works it lives in prompt text:
[agent/OPERATING.md](../agent/OPERATING.md) and a "DutyBoard" section pasted into each
project's `CLAUDE.md`. Claude is *asked* to poll, claim, work, complete, repeat, and it drifts
into a flow of its own. Every project also rebuilds the same plumbing by hand: musictheory has
a PowerShell poller on Windows Task Scheduler, a regex that pulls a token out of
`~/.claude.json`, a per-board `db_` token, and a six-step deploy recipe in prose.

`dutyboard` is one open-source Go binary that takes all of that over:

- **Provisions** DutyBoard itself on altengine from an API key, or finds and upgrades an
  existing deployment.
- **Runs as a daemon** paired to that DutyBoard with one machine key, and works every linked
  project folder. The loop is code: the daemon claims, hands Claude exactly one duty, and
  checks the duty's state afterwards. Claude has no loop to invent.
- **Sets projects up**: clones, installs the toolchain the project type needs into a folder it
  owns and remembers it, generates project rules, and works out how the project deploys.

Non-goals for v1: runners other than Claude Code (the interface allows them), sandboxing the
agent (it runs as your user), a hosted multi-tenant runner service.

## 2. What it feels like

Installed with [alt](https://github.com/altlimit/alt) (no sudo, no package manager):

```
$ alt install altlimit/dutyboard
$ dutyboard
No DutyBoard connected.
  1) Connect to an existing DutyBoard      (pair with a code)
  2) Set up my own on altengine            (needs an altengine API key)
> 2
altengine API key: ••••••••
✓ Organization "altlimit"
Found DutyBoard v2.0.0 → https://k3x9-fn.altengine.app/board
  1) Use it (upgrade to v2.1.0)   2) Provision a new one   > 1
✓ indexes (14)  ✓ access rules  ✓ function board v2.1.0  ✓ console https://…/app/
Opening the console to finish pairing…   code KQTR-8841
✓ Paired — this machine is "faisal-wsl"
Start automatically when you log in? [Y/n] y
Tools: <projects root>/_tools   Projects: ~/dutyboard
Watching 0 boards · live
```

- **Running it is the daemon.** First run pairs (and optionally provisions), offers to install
  itself as a login service, and stays up. Afterwards it starts on its own.
- **Run inside an unlinked repo** and it offers to link that folder to a board, or to create a
  board (asking the profile questions in the terminal).
- **Everything else is in the console**: set a project up on a machine, pause/resume, what it
  is working on, session logs, revoke.
- Flags exist only for overrides: `--server`, `--name`, `--root`, `--provision-only`,
  `--local` (emulator). Claude launches `dutyboard mcp` itself; nobody types it.

## 3. Architecture

```
 console (Vue) ─────────────┐                          ┌──── GitHub (CI runs, clone)
                            ▼                          │
                  altengine: function `board`  ◄───────┼──── dutyboard daemon (your machine)
                  datastore · auth · channel · blob    │       ├─ live: machine.<id>, board.<p>…
                  search · static (console)            │       ├─ worker per linked folder
                            ▲                          │       │    └─ claude -p … (one duty)
                            │ provision / upgrade /    │       │          └─ dutyboard mcp ──unix socket──┐
                            └─ altengine deploys ◄─────┴───────┤                                         │
                                                               └─ local API (socket) ◄────────────────────┘
```

Local state lives in `~/.dutyboard/` (`%LOCALAPPDATA%\DutyBoard` on Windows):

| Path | Contents |
|---|---|
| `config.json` | server URL, machine id/name, projects root, limits, `remote_setup` |
| credentials | machine key and (optionally) altengine key in the OS keyring; 0600 file fallback |
| `workspaces.json` | folder → board, agent id |
| `state.json` | per-duty attempt counts, Claude session ids, backoff timers |
| `tools/<name>/<version>/`, `tools/registry.json` | installed toolchain and its record |
| `worktrees/<board>/<duty-id>/`, `worktrees/<board>/.cache/` | one git worktree per unfinished duty, and the caches handed between them (§6); the linked folder itself is never worked in |
| `logs/<board>/<duty>/<stamp>.jsonl` | Claude stream-json per session, rotated |
| `run/daemon.sock` | local API, dir 0700 (named pipe with a user-only ACL on Windows) |

## 4. Credentials and the board guard

| Credential | Held by | Scope |
|---|---|---|
| altengine key `ak_…` | daemon (keyring), optional after provisioning | provisioning, upgrades, project deploys to altengine |
| machine key `dbm_…` | daemon only | boards **linked to this machine**, by its agent ids |
| board token `db_…` (existing) | unchanged | kept for raw MCP users; moved under "Advanced" in the console |

- **Pairing** is a device flow: `/connect/start` returns a `user_code` and `device_code`; the
  person approves the code on the console's `/pair` page; the daemon polls `/connect/poll` and
  receives the key once. Codes expire after 10 minutes.
- **Server-side guard.** A `dbm_` call must name a board (`x-dutyboard-board`). `identify()`
  resolves the machine row, then point-reads the `machine_links` row for that board; no link,
  no access. The caller becomes `kind: "agent"` with that `projectId`, so every existing duty
  endpoint works unchanged. `agent_id` must be one of the link's agent ids.
- **Local guard.** Claude never sees a key. `dutyboard mcp` holds nothing: it forwards each
  JSON-RPC call over the daemon's socket with its folder and (headless) duty id, and the daemon
  checks both before adding the key and forwarding to `/mcp`:
  - The folder must be linked; the board comes from the link, never from the model.
  - **Headless** (`--duty <id>`): `duty_claim` is hidden, and complete/fail/checkpoint/attach on
    any other duty are refused. The session enqueues freely. `duty_complete` is refused until
    `duty_integrate` has succeeded for this duty (§6), so "done" always means the work is on the
    default branch or in a PR.
  - **Interactive** (from `.mcp.json`): agent id `<machine>-interactive`, all board tools.
- This guards against mistakes and cross-project mix-ups. It is not a sandbox: any process
  running as your user can open the socket, exactly as it could read your SSH keys.

## 5. Server changes (`functions/src`, `backend/`)

### Collections

| Collection | Key | Fields |
|---|---|---|
| `pairings` | sha256(device_code) | `user_code` (unique), `status` pending/approved/denied, `machine_name`, `os`, `arch`, `cli_version`, `approved_by`, `machine_id`, `key_once` (cleared on delivery), `expires_at` |
| `machines` | sha256(`dbm_` key) | `machine_id` (unique), `owner_uid`, `name`, `os`, `arch`, `cli_version`, `workspace_root`, `remote_setup`, `max_sessions`, `paused`, `revoked`, `created_at`, `last_seen_at` |
| `machine_links` | `<project_id>:<machine_id>` | `owner_uid` (machine owner), `agent_prefix` (`<machine>`; lanes are `<machine>/1`, `<machine>/2`, …), `path_hint`, `runs[]` `{duty_id, state working/integrating/parked/limited/error, detail, at}`, `worktree_bytes`, `created_at` |
| `machine_requests` | `mr_<ULID>` | `machine_id`, `project_id`, `kind` setup, `path`, `repo_url`, `status` pending/running/done/failed, `result`, timestamps |
| `rules` | `project_id` | `version`, `body` (markdown, ≤32KB), `updated_by`, `updated_at`, `draft` `{body, by, based_on, created_at}` |

Additions to existing rows:

- `projects.profile`: `type` (`game` `website` `webapp` `mobile` `desktop` `api` `cli-lib`
  `other` + `type_other`), `description`, `repo_url`, `default_branch`, `stack[]`,
  `test_command`, `toolchain[]` `{name, version, why}`, `deploy` `{method, workflow?, branch?,
  command?, altengine_instances[]?}`, `git` `{mode: "push" | "pr", default_branch}`,
  `worktree` `{prep, prep_inputs[], cache[], copy[]}` (§6).
- `duties.affinity`: machine id holding a parked duty's worktree, or null (§6). Polls from other
  machines skip the duty while that machine is present on its channel.
- `projects.runner`: `agent` (`claude-code`), `model`, `effort`, `instructions`,
  `permission_mode`, `allowed_tools[]`, `session_minutes`, `parallel` (duties active at once on
  this board, across all machines; default 1).
- **Board parallel limit on claim**: `duty_claim` counts the board's active duties and answers
  409 when `runner.parallel` is reached. It is enforced here, not in the daemon, so two machines
  on one board still respect it. A `setup` or `rules` duty is exclusive: it can only be claimed
  when nothing else on the board is active, and while it is active nothing else can be claimed.
- `duties.kind`: `work` (default) | `setup` | `rules`.
- `duties.reserved_for`: agent id or null. A reserved duty is invisible in other agents' polls
  and refused on their claims. (`assigned_agent_id` is not reused: it outlives a claim on
  purpose, see `duties.js:85`.) The runnable query over-fetches and filters, since reserved
  duties are few.
- `memberships.can_run_agents` (owner-granted). Removing a member, or the grant, deletes that
  person's machine links on the board.

### Endpoints

| Route | Caller | Purpose |
|---|---|---|
| `/connect/start`, `/connect/poll` | none | device pairing; the key is minted at the poll that finds it approved, once |
| `/connect/lookup`, `/connect/approve`, `/connect/deny` | human | read and approve a code on `/pair` |
| `/machines/list`, `/machines/revoke`, `/machines/update` | human (machine owner) | runners section; online from `env.channel.presence("machine.<id>")` |
| `/machines/unlink` | human (machine owner or board owner) | take a machine off a board |
| `/board/members/agents` | owner | grant or withdraw a member's `can_run_agents`; withdrawing unlinks their machines |
| `/machine/me` | machine | own settings, links, pending requests |
| `/machine/link`, `/machine/unlink` | machine | link a folder: board owner, or member with `can_run_agents` |
| `/machine/state` | machine | run state changes only (not a heartbeat); publishes `{t:"runner"}` |
| `/machine/poll` | machine | batched: held duty + runnable count for every linked board |
| `/machine/live` | machine | subscribe token for `machine.<id>` + `board.<p>` per link, TTL 4h, `presenceId` = machine id |
| `/machine/request`, `/machine/request/report` | human / machine | "set up on a machine" |
| `/projects/create` | human | accepts `profile`, `runner`; a board made with either starts with a `rules` duty |
| `/projects/profile` | owner | edit profile/runner; publishes `{t:"board", what:"profile"}` |
| `/board/profile` | human, agent | profile, runner, `rules_version` |
| `/board/profile/propose` | agent holding a `setup` duty | `toolchain`, `test_command`, `deploy`, `worktree` |
| `/board/rules` | human, agent | rules in force + version; people also get the draft, agents only `has_draft` |
| `/board/rules/set`, `/board/rules/accept` | owner | edit, or accept the draft; publishes `{t:"board", what:"rules"}` |
| `/board/rules/submit` | agent holding a `rules` duty | write the draft |

### MCP tools (hosted)

- `board_profile` — read the profile.
- `board_profile_propose` — set `toolchain`, `test_command`, `deploy`, `worktree`; only while
  holding a `setup` duty. A human edit afterwards wins.
- `board_rules` — read the accepted rules.
- `board_rules_submit` — write the draft; only while holding a `rules` duty.
- `duty_claim`'s response gains `rules_version`, and every duty brief carries `kind`.
- A parked duty is kept for its machine by `duty_checkpoint` with `affinity: true` (machine keys
  only), which sets `duties.affinity`.
- `/health` gains `machines: true` and `console_url` (from the `DUTYBOARD_CONSOLE_URL` secret).

### Channels

- `board.<p>` (existing) carries what workers need: `{t:"duty", id, status}`. New event types
  `{t:"board", what}` and `{t:"runner", machine_id, state}`.
- `machine.<id>` (new) is published only by the server: `setup {request_id}`, `pause`,
  `resume`, `revoked`, `links` (re-mint your token).
- Payloads stay ids and status. Content is always fetched over REST with credentials.
- The provisioner turns **presence on** for the channel instance; runner "online" depends on it.

### Console runtime config

`app/src/config.js` reads `window.DUTYBOARD_CONFIG` (from `/app/config.js`, loaded by
`index.html` before the bundle) ahead of the `VITE_*` build values, then localStorage
overrides as today. `app/public/config.js` ships as `window.DUTYBOARD_CONFIG = null` for dev.
This lets one prebuilt console be deployed anywhere by writing one file.

## 6. The daemon

### Startup

1. Load config and keys. No machine key → first-run menu (§2).
2. `/machine/me`; if the bundled version is newer than the deployment's `/health` and an
   altengine key is stored → upgrade (§9).
3. Verify the toolchain registry (§7). Anything failing is marked missing.
4. Connect live (below), then **check every board** and start workers.

### Live, with a 15-minute fallback

| Trigger | Action |
|---|---|
| `board.<p>` `duty` event with `status: "queued"` | wake that board |
| `board.<p>` event on a duty this machine is running, now not `active`, not our own origin | **cancel**: stop that Claude (process tree), park its worktree (below); `status: "deleted"` removes the worktree |
| `board.<p>` `board` event | re-sync rules / reload profile and runner |
| `machine.<id>` command | setup / pause / resume / re-mint / stop on revoke |
| socket connected or reconnected | check all boards (`/machine/poll`) — catches anything missed |
| a session ends | check that board immediately (finishing a duty emits no "next" event) |
| every 15 minutes | check all boards — publishes are fire-and-forget (`live.js:53`) |

- Reconnect with exponential backoff capped at 15s.
- **Token rotation**: the platform closes a socket at token expiry. At ~3h50m the daemon mints
  a new token, opens a second socket, subscribes, then closes the first — no gap — and checks
  all boards.
- Wakes are debounced ~2s per board; a wake while `max_sessions` is reached is remembered.
- The MCP mode sends `x-dutyboard-origin: <machine>` so the daemon ignores its own echoes.
- Library: `github.com/coder/websocket`.

### Two limits

| Limit | Set where | Protects | Default |
|---|---|---|---|
| `max_sessions` | machine, editable on the console's Machines page | Claude plan usage, CPU, RAM | 3 |
| `runner.parallel` | board, **enforced by the server on claim** (§5) | whether this repo's work can run side by side | 1 |

Three boards at 1 each run three sessions at once; one board at 3 runs three on that board.
When `max_sessions` is reached, free capacity goes to boards in turn, so one busy board cannot
starve the others; `immediate_blocker` duties go first. The console suggests raising a board's
`parallel` once it has accepted rules and a `test_command`, since those are what parallel work
is checked against when it merges.

### Every duty in its own worktree, named after the duty

The daemon never works in the linked folder. It stays yours to code in while agents run. Each
duty gets a git worktree at `~/.dutyboard/worktrees/<board>/<duty-id>/` on branch `duty/<id>`,
created at its first claim and **kept until the duty is finished**.

The daemon creates and manages worktrees; Claude is never asked to. Claude Code has its own
`--worktree`, but that makes a fresh one per session and puts branch naming back in the model's
hands.

- **Unblocking resumes exactly where it stopped.** A duty parked as `needs_decision` or
  `blocked` keeps its folder: branch, uncommitted edits, build output. When a person answers,
  the duty is queued, claimed again, and the daemon runs `claude --resume <session-id>` in the
  same folder with the answer. Claude Code stores conversations per folder path, so a stable
  per-duty path is what makes `--resume` work at all; the session carries on with its whole
  context instead of re-reading the brief.
- **No slot numbers to track.** The duty id finds the folder. Agent ids `<machine>/1`,
  `<machine>/2`, … still exist, because the server allows one active duty per agent, but they are
  only concurrency lanes: the lowest free one claims, and it has nothing to do with which folder
  is used.
- **Lifetime.** Created on first claim. Kept while the duty is active, parked, or queued again
  after an answer. Removed when the duty is done, failed or deleted (board event), after its
  caches are handed back (below). A reopened duty starts a new branch and folder from the default
  branch, with the previous outcome in its prompt.
- **Caches without slots.** `profile.worktree.cache` names the expensive gitignored folders
  (`node_modules`, Godot's `.godot/`, build caches). When a worktree is removed, those folders are
  *moved* (same filesystem, instant) into `worktrees/<board>/.cache/`, tagged with the hash of
  `prep_inputs`. A new worktree moves them in if they are there, so usually one duty's caches go
  to the next. Parallel duties that find the cache already taken run `profile.worktree.prep` from
  scratch. Prep (`npm ci`, a headless Godot import, `git submodule update --init`, `git lfs pull`)
  runs on a fresh worktree, and again only when the `prep_inputs` hash (lockfiles) differs from
  the cache's.
- **Files outside git** that the project needs (`.env`, local secrets, unversioned assets) are
  listed in `profile.worktree.copy` and copied or symlinked from the linked folder.
- **Other machines.** The folder only exists on the machine that parked the duty, so parking
  records `duties.affinity = machine_id`. While that machine is online (presence), other machines'
  polls skip the duty. If it is offline, another machine may claim it and starts from the
  snapshot below: files kept, Claude conversation lost.
- **Snapshot on park.** If the board has more than one machine linked, the daemon pushes the
  worktree's state to `refs/dutyboard/wip/<duty-id>` (temporary index, `git commit-tree`, push).
  The branch itself is not touched, so no `wip` commits end up in history.
- **Disk.** Parked worktrees older than `park_ttl` (14 days **(assumed)**) are snapshotted and
  removed; resuming restores from the snapshot. The console shows worktree disk use per board.
- A linked folder that is not a git repository is refused.

### Duty run lifecycle

```
wake ──► check board ─ nothing runnable, or max_sessions reached ─► wait
            │
            ├─ a lane of this machine holds an active duty (daemon restarted) ─────────────┐
            └─ claim top of queue (409: board full, or another machine won) ──┐             │
                                                                                ▼             ▼
                    worktree for <duty-id> exists? ── yes ─► use it; resume the Claude session if one is recorded
                                                  └─ no ──► fetch · create duty/<id> from origin/<default>
                                                            (or from the wip snapshot) · take caches · prep · copy
                                                                                │
                                                                                ▼
                                          run Claude in the worktree ── cancel event ──► stop · park
                                                                                │ exit / timeout
                                                                                ▼
                                                                          re-read duty
      done / failed ─► hand back caches · remove worktree and branch · post-run (CI watch) ─► check board
      needs_decision / blocked ─► park (keep folder, affinity, snapshot if needed) ─► check board
      still active ─► attempt++ ─┬─ < 3 ─► resume the same Claude session (backoff)
                                 └─ = 3 ─► checkpoint needs_decision + log tail attached ─► park
```

- **Integrate** (local MCP tool `duty_integrate`, called by Claude when the work is committed):
  - `push` mode: the daemon takes the board's **integration lock**, fetches, rebases the branch
    onto `origin/<default>`, runs `test_command`, and pushes `HEAD:<default>`. It returns the
    commit hash. On a rebase conflict it returns the conflicting files and **keeps the lock**
    while Claude resolves them and calls again. A failing test returns the output; the lock is
    released, and Claude fixes and calls again.
  - `pr` mode: push the branch, open a PR (`gh`, or the GitHub API with a token), return its URL.
    No lock.
  - A duty with no commits (most `setup` and `rules` duties) integrates as a no-op.
  - The MCP guard refuses `duty_complete` until this has succeeded (§4), so every outcome carries
    a real commit or PR.
- **Deploys** (`altengine` and `command` methods) take the same per-board lock, so two sessions
  never deploy over each other. With CI, the repository's own `concurrency` settings apply.
- **Claude usage limits**: a session that ends on a usage-limit message does not count as an
  attempt. Every run on the machine backs off until the reset time it reports, with state
  `limited`.
- `/machine/state` is called on run state changes only.

### Launching Claude (`internal/runner/claude`)

```
claude -p "<duty prompt>"
  --append-system-prompt "<contract + rules + profile + tools + runner instructions>"
  --mcp-config <tmp 0600 json: dutyboard mcp --duty <id>>
  --permission-mode <runner.permission_mode, default acceptEdits>
  --allowedTools <runner.allowed_tools>
  --model <runner.model> --effort <runner.effort>
  --output-format stream-json --verbose
  --session-id <uuid> -n "<duty title>"
```

- Working directory is the duty's worktree. `setup` duties also get `--add-dir <linked folder>`, to find
  the untracked files `worktree.copy` needs.
- Resume: `claude -p --resume <session-id> "<you stopped before the duty left active; continue>"`.
- Environment: toolchain bins prepended to `PATH`, tool variables (`GODOT_BIN`,
  `ANDROID_HOME`, …).
- Not `--strict-mcp-config`: the user's other MCP servers stay available.
- The stream is written to the session log; the final result, cost and tool calls are kept.

### Prompts (`internal/prompt`, embedded)

- **Contract** (headless edition of OPERATING.md): you hold exactly this duty, on branch
  `duty/<id>` in this folder; commit your work there; never switch branches or create worktrees;
  never run anything in the background or end your turn to wait; questions go on the board as
  `needs_decision` with options; enqueue what you find; when the work is done call
  `duty_integrate`, then `duty_complete`; stop the moment this duty leaves `active`;
  `outcome_summary` names files, commit or PR, deployment.
- **Duty prompt** by kind: `work` (brief, reopen note first, `unblocked_context`,
  attachments, the deploy steps from the profile), `setup` (§7), `rules` (§8).

## 7. Toolchain setup

A `setup` duty is created, `reserved_for` the machine (any of its lanes), at
`immediate_blocker`, when a folder is linked or when a duty finds a tool missing that needs more
than a user-folder install. It is exclusive on its board (§5).

The session:

1. Works out what the project needs from the profile, the repo, and the bundled hints for its
   type (`internal/hints/<type>.md`: Godot, Unity, Node, Go, Flutter, Electron, …).
2. Writes it to the board with `board_profile_propose` (`toolchain`), so other machines know.
3. Checks this machine: `PATH`, usual install locations, `tools_list`.
4. Installs what is missing into `<projects root>/_tools/<name>/<version>/`: portable builds from
   official sources, checksum verified. **No sudo, no system package managers (assumed).**
5. Anything needing admin rights or a licence acceptance becomes a `needs_decision` with the
   exact command.
6. Registers each tool with `tools_register`: `{name, version, path, bin, env, source, sha256,
   verify}` (for example `verify: "godot --version"`).
7. Works out the worktree setup and proposes `worktree` (§6): the `prep` command and its
   `prep_inputs`, the `cache` folders worth handing between duties, and the untracked files in
   the linked folder that a worktree needs (`copy`). It
   asks on the board before copying anything that looks like a secret.
8. Detects the deploy method (§10) and proposes it.

Local MCP tools served by the daemon (never the server): `tools_list`, `tools_register`.
Any work session can install into the tools folder and register, so the next session knows.
The daemon runs every `verify` at startup and after each setup; a failure marks the tool
missing and enqueues a `setup` duty. Every session's system prompt carries a short "Tools on
this machine" section and never downloads a second copy.

## 8. Rules

- A `rules` duty (any machine) runs after setup. Claude starts from the bundled seed for the
  project type, reads the repo and toolchain, and writes concrete, checkable rules: security,
  reuse and no duplication, performance, testing and verification (with the real commands),
  conventions, git, deploy. It submits with `board_rules_submit`.
- Rules land as a **draft a person accepts (assumed)**; regenerations show a diff.
- The accepted rules go into every headless session's system prompt. The daemon also writes
  them to `.dutyboard/RULES.md` (gitignored) and links add `@.dutyboard/RULES.md` to
  `CLAUDE.md`, so interactive sessions in the folder follow them too. `rules_version` on claim
  triggers a re-sync.

## 9. Provisioning (`internal/provision`)

The binary embeds the built function (`bundle.js`), console, `agent.md`, `llms.txt`, and
`backend/*.json`, so provisioning needs no Node, npm or sitegen.

| Step | Detail |
|---|---|
| Detect | `whoami`, `list_instances`, each functions instance's listing; `/health` on any function named `board` gives `version` and features |
| Choose | use existing (upgrade if older) or provision new under a name prefix (default `dutyboard`, then `dutyboard-2`, …) |
| Instances | auth, channel, datastore, functions, blob, search, static; datastore `autoId`/`autoIndex`; indexes; access rules; function CORS; channel presence on |
| Blocked steps | where hosted altengine refuses a key (creating auth/channel on older platforms; auth sign-up fields and origins), print a checklist and **re-check every few seconds**, continuing when done |
| Function | deploy `board` with today's grants; read back the minted URL |
| Static | manifest → upload missing → activate; files are the console, `agent.md`, `llms.txt`, and a generated `/app/config.js` |
| Pair | open `<console>/app/#/pair?code=…` |
| Upgrade | on daemon start when the bundle is newer: indexes, access rules, function, static. Server changes stay additive so an upgrade never needs a data migration |
| Local | `ALTENGINE_URL` on loopback uses the emulator admin API, as `setup.mjs` does |

- **One implementation**: the Go provisioner replaces `scripts/setup.mjs`, `deploy.mjs` and
  `deploy-site.mjs` **(assumed)**. The npm scripts become wrappers
  (`go run ./cli/cmd/dutyboard --provision-only [--local]`); `provision.sh` becomes "download
  the binary and run it". `backend/*.json` stays the source of truth.
- The altengine key is **kept in the keyring after provisioning (assumed)**, for upgrades and
  project deploys; without it each upgrade asks again.
- Self-hosted static content is the console, `agent.md` and `llms.txt` **(assumed)**; the
  marketing site stays dutyboard.com's.
- Upstream fix worth making in altengine: key-writable auth sign-up fields and origins, so the
  checklist disappears.

## 10. Project deploy flow

| `deploy.method` | Detected when | After the session completes the duty |
|---|---|---|
| `ci` | a workflow in `.github/workflows` runs on push to the default branch and has a deploy step (altengine, pages, wrangler, firebase, vercel, netlify, `npm run deploy`, …) | nothing more: integration pushed it; watch the run for that commit |
| `ci-dispatch` | a deploy workflow exists but only on `workflow_dispatch` (musictheory, this repo) | `gh workflow run` for the integrated commit; watch |
| `altengine` | no CI, hosted on altengine | the session calls the daemon's deploy tools after integrating |
| `command` | a deploy script | the session runs it after integrating |
| `none` | nothing deploys | nothing more |

Deploys always run from the integrated commit, never from an unmerged branch. In `pr` mode
nothing deploys until the PR merges, which is the repository's own CI's business.

- Detection: Go reads workflow triggers and steps; the `setup` session confirms or corrects
  (it can read the scripts a workflow calls) and asks when unsure. Editable in the console.
- **Local altengine deploy tools**: `altengine_deploy_static {dir, instance, message}` and
  `altengine_deploy_function {instance, name, file, grants}`. The daemon builds the manifest,
  uploads, activates, checks `x-ae-deployment`, and prunes to the live deployment plus one
  inactive. It refuses any instance not in `deploy.altengine_instances`.
- **CI watching** (worker, not Claude), using `gh` if signed in or a GitHub token:
  - pass → checkpoint note with the run URL;
  - fail → enqueue `immediate_blocker` "Fix failed deploy of `<sha>`", failing job log
    attached, `spawned_by` the duty **(assumed)**;
  - no GitHub access → note "CI deploys this; not verified", and setup asks for access once.
- **Git** **(assumed)**: every duty is on `duty/<id>` in its own worktree either way (§6). `git.mode:
  push` rebases and pushes to the default branch at integration (what musictheory does today,
  minus the shared checkout); `pr` opens a PR and the duty's outcome links it.

## 11. Linking a folder

From the daemon (run inside a repo) or from the console ("Set up on a machine"):

1. Console path: server stores a `machine_requests` row and publishes `setup` on
   `machine.<id>`. The daemon only acts inside its projects root, and clones `repo_url` if the
   folder is missing. `remote_setup: auto` **(assumed)**; `ask` shows a desktop notification.
2. `/machine/link` → re-mint the live token.
3. Commit the link the same way as any other change, in a worktree on branch `duty/link`, integrated
   per `git.mode`: `.dutyboard/board.json` (server, board — committed **(assumed)**),
   `.dutyboard/.gitignore` (`RULES.md`, `local/`), a `.mcp.json` entry
   `{"command":"dutyboard","args":["mcp"]}`, and the `CLAUDE.md` import. Your checkout gets them
   on your next pull; the daemon never writes to it except the gitignored `.dutyboard/RULES.md`.
4. Enqueue `setup`; `rules` is already queued if the board has none.
5. Report the result so the console shows "Linked on faisal-wsl at ~/dutyboard/cadence".

## 12. Console (`app/`)

- **Board wizard** (`Boards.vue`): name and id → project type → repo, branch, stack chips
  suggested by type, description → deploy method and git mode → runner (Claude Code, model,
  effort, parallel duties, extra instructions) → "Set up on a machine" or the install line
  (`alt install altlimit/dutyboard`).
- **`/pair`** page.
- **Settings**: Profile, Rules (view, edit, accept draft with diff, regenerate), Runners
  (machines, online via presence, `max_sessions`, linked folders with each running or parked duty and worktree disk use, pause,
  revoke), member `can_run_agents`, raw tokens under Advanced. Runner settings suggest raising
  `parallel` once the board has accepted rules and a `test_command`.
- **Board header**: runner pill (online / N working / integrating / limited / offline).
- **Duty view**: `setup` and `rules` duties render their kind; parked duties show the attached
  session log.

## 13. Repo layout and release

```
cli/
  PLAN.md
  go.mod                 module github.com/altlimit/dutyboard/cli
  cmd/dutyboard/main.go
  internal/
    app/        first run, flags, service prompt
    api/        DutyBoard REST client
    altengine/  REST + MCP client
    provision/  detect, instances, config, function, static, upgrade
    assets/     go:embed of dist/ + backend/*.json; download fallback
    pair/       device flow, keyring
    live/       channel socket, rotation, debounce
    worker/     scheduler, lanes, duty run state machine, limits
    worktree/   per-duty worktrees, caches, prep, copy, park, snapshots, integration lock
    runner/     Runner interface; claude/
    prompt/     embedded templates
    localmcp/   `dutyboard mcp` stdio mode + daemon socket
    tools/      registry, verify, session env
    hints/      per-type toolchain hints and rule seeds
    deploy/     CI detection, run watching, altengine deploys
    gitx/       git helpers
    service/    systemd --user, launchd, Startup-folder launcher (Windows)
    state/      ~/.dutyboard layout, logs, rotation
```

- Nested module so `go vet ./...` never walks `node_modules`. Dependencies: standard library,
  `go-keyring`, `coder/websocket`, a YAML parser for workflows.
- **Install** is [alt](https://github.com/altlimit/alt): `alt install altlimit/dutyboard`, and
  `alt run altlimit/dutyboard` to provision without installing. The README's install section is
  replaced with that, and `scripts/provision.sh` shrinks to installing alt (if missing), then
  `alt install altlimit/dutyboard && dutyboard`.
- **Release** on tag `v*`, one version for everything (the version in `package.json`):
  `npm ci` → build function, console (runtime config), site → copy into
  `cli/internal/assets/dist/` → GoReleaser for linux/mac/windows × amd64/arm64 → GitHub release.
- **Asset names follow what alt scores** (OS +100, arch +100, archive +20; checksum files
  ignored but verified): `dutyboard_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows), each
  holding the `dutyboard` binary, plus `checksums.txt`. The embedded-assets archive for
  `go install` builds is `dutyboard-web_<version>.tar.gz`, which names no OS or arch and so
  never outscores a binary.
- **Updates**: the daemon checks the latest release daily and shows it in the console. When the
  binary lives under alt's storage it runs `alt update altlimit/dutyboard` and restarts itself;
  otherwise it only tells you.
- `go install github.com/altlimit/dutyboard/cli/cmd/dutyboard@latest` works without embedded
  assets: the first provision downloads `dutyboard-web` for the latest release and verifies its
  checksum.
- CI gains `go vet` and `go test ./...` for `cli/`.

## 14. Testing

- **Go unit**: duty run state machine against a fake API and fake runner (claim race, board
  full, cancel, delete, timeout, three attempts, usage limit, park then unblock resumes the same
  folder and Claude session, daemon restart finds a held duty); scheduler fairness across boards
  under `max_sessions`; worktrees against a real temporary git repo (create, cache hand-back and
  take, prep re-run on lockfile change, copy, park keeps uncommitted edits, snapshot ref leaves
  the branch untouched, restore from snapshot, TTL cleanup, rebase conflict holds the lock, test
  failure releases it, no-op integration); CI detection on workflow fixtures (including
  commented-out `push`); manifest hashing and paging; token rotation with a fake socket; local MCP
  guard (wrong duty, unlinked folder, hidden claim, complete before integrate).
- **Server**: `scripts/smoke.mjs` gains pairing, machine scoping (unlinked board → 403, member
  without `can_run_agents` → 403, member removal sweeps links), `reserved_for`, board
  `parallel` on claim, exclusive `setup`/`rules`, `affinity` skipped while
  the machine is present,
  `board_rules_submit` only under a `rules` duty, presence in `/machines/list`.
- **Integration** (build tag `emulator`): provision against `altengine dev`, pair, link a fixture
  repo, run one duty with a stub runner that calls MCP like Claude would.
- **By hand, once per phase**: musictheory on Windows (tooling is PowerShell and Godot), a
  website repo with a push-to-deploy workflow.

## 15. Phases

Each phase ends deployed and usable.

1. **Server** — pairing, machines and links, `dbm_` in `identify()`, `/machine/*`, duty `kind`
   and `reserved_for`, profile and runner fields, rules storage and MCP tools, channel events,
   `can_run_agents`, console runtime config. *Done when* smoke passes and a curl-driven
   "machine" can pair, link and complete a duty.
2. **Provisioner** — detect, choose, provision, function, static, upgrade, local emulator; npm
   wrappers; release pipeline with embedded assets. *Done when* one command takes an empty org
   to a working console, and a re-run upgrades in place.
3. **Daemon** — first run, service install, live and fallback, scheduler and limits, per-duty
   worktrees and `duty_integrate` (push mode), Claude runner, prompts, local MCP mode and socket, cancel, logs.
   *Done when* a duty filed in the console is picked up within seconds, done on its own branch,
   pushed, and completed without anyone touching the terminal — and two duties on a board with
   `parallel: 2` integrate one after the other, and a duty answered after `needs_decision` resumes
   in its own folder and Claude conversation.
4. **Console** — wizard, `/pair`, runners, profile, rules, set up on a machine, runner pill.
5. **Setup, rules, deploy** — tool registry and hints, `setup` and `rules` duties, CI detection
   and watching, altengine deploy tools, git PR mode.
6. **Docs and moving musictheory over** — README (install via `alt install altlimit/dutyboard`),
   `llms.txt`, site page; link musictheory,
   remove `register-task.ps1`, move its CLAUDE.md deploy and conventions into profile and rules.

## 16. Decisions

| # | Decision | Default |
|---|---|---|
| 1 | Can members of a shared board link machines? | only with an owner-granted `can_run_agents` |
| 2 | Git flow | per board; default `push` (rebase and push to the default branch at integration), `pr` optional |
| 3 | Commit `.dutyboard/` | `board.json` yes; `RULES.md` and `local/` gitignored |
| 4 | AI-generated rules | draft, accepted by a person |
| 5 | System installs (sudo, apt) | never; ask on the board with the exact command |
| 6 | Setup requested from the console | automatic inside the projects root |
| 7 | Keep the altengine key after provisioning | yes, keyring |
| 8 | Self-hosted static content | console, `agent.md`, `llms.txt` |
| 9 | Replace Node provisioning scripts | yes; npm scripts wrap the binary |
| 10 | CI fails after a push | worker enqueues a fix-deploy blocker |
| 11 | Parallelism | two limits: `max_sessions` per machine (3), `runner.parallel` per board (1, server-enforced) |
| 12 | Where agents work | a daemon-managed worktree per duty at `worktrees/<board>/<duty-id>` on `duty/<id>`, kept until the duty finishes; never the linked folder, never worktrees made by the model |
| 13 | Install | `alt install altlimit/dutyboard` |
| 14 | Parked worktree lifetime | 14 days, then snapshot to `refs/dutyboard/wip/<id>` and remove |

## 17. Risks

- **Hosted auth config gaps** keep a manual checklist in provisioning until altengine exposes
  those settings to API keys.
- **Claude plan limits** can stall a queue; the `limited` state makes that visible rather than
  looking like failures.
- **Windows**: process-tree kill, named-pipe ACLs, Task Scheduler, and projects whose tooling
  is Windows-only while the daemon runs in WSL. The daemon must run where the project's tools
  run.
- **Remote setup clones and runs an AI on code** from a repo URL typed in the console; limited to
  the machine owner and the projects root, and `ask` mode exists for shared machines.
- **`.mcp.json` committed** means teammates without `dutyboard` see a failing MCP server entry;
  harmless, and the README says how to install.
- **Worktrees cost disk**: a checkout per unfinished duty, and parked duties add up. `park_ttl`
  bounds it; cache hand-back keeps prep off most new duties, but parallel duties still prep.
- **Claude session resume depends on Claude Code's per-folder session storage**; if that changes,
  a resumed duty falls back to a fresh session with the thread and the worktree as context.
- **Merge conflicts** grow with how much parallel duties overlap. Integration catches them, but a
  board whose duties all touch the same files should stay at `parallel: 1`.
- **Projects that need files outside git** fail in a worktree until setup has found them for
  `worktree.copy`; the first failure should read as a setup question, not a broken duty.
- **Invocation cost**: live wake keeps polling to roughly 100 `/machine/poll` calls a day per
  machine, plus one call per duty transition.

## Built so far (2026-09-14)

Phases 1–5 exist and are tested. Phase 6: the README, llms.txt and the site cover the runner; moving
musictheory over needs a release and its owner at a Windows terminal (see below). Where the build differs from the plan above:

- **Local bridge transport**: loopback TCP plus a secret in `run/daemon.json` (0600), not a Unix
  socket or named pipe — one code path on every OS, with the same trust boundary (this user).
- **Headless session identity**: a per-session token in the MCP server's environment, so the
  daemon knows which run a message belongs to without trusting anything the session says.
- **No linked folders** (replaces §11): a board worked by a machine requires a repository URL, and
  each machine clones it into `<projects root>/<board>/<repo>-<hash>/`, with `<board>/local/` for
  untracked files a worktree needs. Nobody's own checkout is used. Machines are put on boards from
  the console; running `dutyboard` in a repository offers the boards naming its remote. Changing a
  board's repository clones the new one; duties under way stay on their clone until they finish.
  Boards carry an optional commit author and SSH command, set in the clone's local git config. A
  pull-request board on a machine without `gh` is reported as a problem and not worked.
- **Tool registry** (§7) shipped with phase 3: `tools_list` and `tools_register` in the bridge,
  verified on register and at daemon start, on every session's PATH.
- **Console** (§12): the board wizard is one form rather than steps; machines have their own page
  (`/machines`) with the settings the plan put under Runners, and `/pair` approves a code.
- **Deploy** (§10): CI is watched with the GitHub CLI only (no token fallback yet); a machine without
  `gh` notes on the duty that CI was not watched. `altengine_deploy_static` does not prune old
  deployments yet — the listing's shape could not be confirmed with a read.
- **Hints** (§7) are per project type, embedded, and given to setup and rules sessions with the
  daemon's reading of `.github/workflows`.

Verified by:

- `npm run smoke` (195 checks, server);
- `go test ./...` in `cli/` (the provisioner's hosted path against a fake altengine; worktrees,
  integration, conflicts and snapshots against real git);
- `npm run smoke:runner` (30 checks: the daemon working a board on the emulator with a fake agent,
  including an altengine deploy through the bridge);
- one run with real Claude Code (Haiku) completing a duty, integrating and landing the commit.

### Moving musictheory over (phase 6, not done)

Needs a `v*` release so `alt install altlimit/dutyboard` has a Windows binary, and the owner at the
machine, because pairing is approved in the console. Its tooling is PowerShell and Godot on Windows,
so the daemon runs on Windows, not in WSL.

1. On Windows: `alt install altlimit/dutyboard`, then `dutyboard` inside `D:\Projects\musictheory`;
   approve the code; link the folder to the `cadence` board; accept the login service.
2. In the console, fill the board's profile: type Game, test command `tools/run_tests.ps1 -Layer all`,
   deploy method `altengine` with instance `cadence` (its six-step deploy becomes
   `altengine_deploy_static` on `build/web-nothreads`).
3. Let the setup duty register Godot, and move the "Direction the owner has set" and "Conventions"
   sections of its CLAUDE.md into the rules the rules duty drafts, before accepting them.
4. Remove the old poller: `tools/dutyboard/register-task.ps1 -Remove`, and the DutyBoard section
   of its CLAUDE.md.

