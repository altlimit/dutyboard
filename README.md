# DutyBoard

A coordination bus, external working memory, and asynchronous human-in-the-loop decision
engine for autonomous agents.

An agent working a long task hits two walls that its own loop cannot get past: it runs out
of context, and it runs into questions only a person can answer. DutyBoard is where both
go. Agents claim work from a queue, record what they did in a summary that outlives their
session, and — when they hit an ambiguity or need a credential — park the duty with a
question and **immediately take the next one** instead of blocking. A person answers when
they get to it, and the answer rides along the next time any agent picks that duty up.

What it deliberately does not hold: shell output, diffs, tool traces. Intent, state,
blockers and outcomes only. A poll answers in a couple of hundred tokens.

```
                 ┌───────────┐
                 │  queued   │◄─────────────────┐
                 └─────┬─────┘                  │ a human answers
        duty_claim     │                        │ (duty/resolve)
                       ▼                        │
                 ┌───────────┐        ┌─────────┴────────┐
       ┌─────────┤  active   ├───────►│  needs_decision  │
       │         └─────┬─────┘        └──────────────────┘
       │ duty_enqueue  │ duty_complete    ▲ duty_checkpoint
       │ (immediate)   ▼                    (agent keeps working
       │         ┌───────────┐               on something else)
       ▼         │   done    │──────► back to `queued` when a person says it did not
  ┌─────────┐    └─────┬─────┘         work, carrying the note that says why
  │ blocked │◄─────────┘                (duty/reopen)
  └─────────┘   finishing the child re-queues its blocked parent
```

## Layout

```
app/         the console                                 (Vue 3 + Vite, its own package)
site/        the marketing site at www.dutyboard.com     (sitegen)
functions/   the state machine, one deployed module      (altengine functions)
backend/     instance configuration the provisioner applies
cli/         `dutyboard`: the provisioner, and the runner that works boards on a machine (Go)
scripts/     local provisioning, site deploy, the demo seeder and the end-to-end smoke tests
```

The three builds share nothing. `app/` builds to `app/dist`, which the provisioner publishes to
**each deployment's own static site**. `site/` builds to `site/public`, which is all that
www.dutyboard.com serves: a marketing page and the setup instructions, with no console and no
knowledge of any deployment. So no single page stands in front of everyone's boards.

The console uses hash URLs (`#/b/my-board`), so it works on any static host, at any path, with no
rewrite rules.

## How it is built

DutyBoard runs on [altengine](https://www.altengine.net) — no server of its own.

| Piece | Service | What it does |
| --- | --- | --- |
| `board` | **functions** | The whole state machine, as one deployed module. REST at `/duty/*` and an MCP endpoint at `/mcp`. |
| `dutyboard` | **datastore** | `projects`, `duties`, `threads`, `agents`, `tokens`. |
| `dutyboard-auth` | **auth** | The people on boards. Row rules scope every read to boards you own or are a member of. |
| `dutyboard-live` | **channel** | Board and duty events, so the console moves as agents work. |
| `dutyboard-files` | **blob** | Attachments on duties: screenshots, recordings, logs. |

The split that matters: **the console reads the datastore directly and writes nothing.**

Every transition here touches more than one collection at once — claiming a duty writes
the duty row and the agent row together; an interrupt moves a parent to `blocked` in the
same breath as creating its child — and a row-level rule can only scope one collection per
request. That work is structurally unreachable from a browser's identity token, which is
exactly what functions exist for. So the state machine lives in the function, at
organization level, and the browser posts intentions to it.

Reads go straight from the browser to the datastore, where the auth instance's row rules
AND "a board you own or are a member of" into every query server-side. The page cannot ask
for anyone else's board, and does not have to remember to try.

### Two kinds of caller

| | Credential | How it is checked |
| --- | --- | --- |
| **A person** | An auth identity token (`id_token`) | `env.auth.verifyToken` — the signing secret never enters this code. Ownership or membership is checked per request, against rows. |
| **An agent** | A project token, `db_…` | Only its SHA-256 is stored, and that hash **is** the document key. Verifying a token is one point-read; the row names exactly one board, so an agent can never reach another. |

The `db_` prefix is what tells them apart. A token is shown once, at mint, and never again.

## Run your own

Install `dutyboard` with [alt](https://github.com/altlimit/alt) — no sudo, no package manager —
and put DutyBoard on your altengine organization:

```bash
alt install altlimit/dutyboard
dutyboard --provision-only        # asks for an altengine API key, or reads $ALTENGINE_KEY
```

(`alt run altlimit/dutyboard --provision-only` does the same without installing anything.)

It finds a DutyBoard already in the organization and upgrades it, or provisions a new one:

- the instances — `dutyboard` (datastore, functions), `dutyboard-auth`, `dutyboard-live`,
  `dutyboard-files`, `dutyboard-search`, and the static site `dutyboard-console` — and their config;
- the indexes and the access rules;
- the function, with its grants;
- **the console**, published to the root of `dutyboard-console` with a `config.js` pointing it at
  that function, and that site's origin added to the function's CORS list and the auth instance's
  allowed origins;
- a check that `/health` reports the version it just deployed.

It prints the console's address and stores it with the function, so a `dutyboard` that is pairing
a machine can tell you where to approve it. It is also always in the altengine console, as the
`dutyboard-console` static site. Every step is idempotent, so running it again is how you
upgrade. The binary carries the function and the console it deploys: the machine running it
needs no Node and no checkout.

**The key** needs the **MCP / AI agent access** toggles on the key form, which are off by default:
`Instances & data: Write` and `Functions: Write`. Not Full — nothing here deletes an instance.
It is only needed to set up and upgrade, so the provisioner does not keep it unless you say so;
projects the runner deploys use a narrower key of their own (see
[Running agents on your machine](#running-agents-on-your-machine)).

**It never publishes over a site it did not make.** A static deploy replaces a whole site, so an
existing static instance is only written to when what it serves was published by the provisioner
(its deployments are labelled `dutyboard v<version>`) or it serves nothing. A deployment from
before consoles had a site of their own kept its console under `/app` on the static instance named
like its functions instance; that site is upgraded in place, and `/app` links are sent on to the
root.

**It takes dutyboard.com off your origins.** Once your console is up, `https://www.dutyboard.com`
— and the console's previous origin, if it moved — are removed from the function's CORS list and
the auth instance's allowed origins. A page there has no business calling your deployment.

If the platform refuses to change the auth instance's sign-up form and allowed origins from an
API key, it prints what to set in the altengine console instead:
[`backend/signup.json`](backend/signup.json)'s fields, and the console's origin. On older
altengine it also could not create the auth and channel instances; it lists those as console work
and waits, re-checking every few seconds.

**On sign-up, decide before you finish.** A new deployment opens sign-up, which is what you want
for exactly as long as it takes to create your own account — after that it is an open door onto
your quota. Turn it off in the auth instance's settings once you have signed up. Allowed origins
are not a substitute: CORS binds browsers, and nothing else.

Two hosted details, both found the hard way:

- **Subdomains are minted, not the instance name.** A functions instance called `dutyboard`
  answers on `https://<random>-fn.altengine.app`, and a static site on another random subdomain.
  The provisioner asks the platform where things landed rather than guessing.
- **The console addresses its auth instance by ID.** Sign-in carries no API key, so the platform
  has no organization in which to resolve a name. The `config.js` the provisioner writes uses the
  ID; the datastore and channel stay names, because those calls carry an identity token.

### Letting an agent install it

[dutyboard.com/llms.txt](https://www.dutyboard.com/llms.txt) is the same setup written for an
agent: which key to ask for, the one command to run, and what to hand back. An agent that cannot
run commands is told to give its user the command rather than rebuild the setup by hand with
altengine's MCP tools — the console is a built app, and there is no by-hand route that ends with
one.

### Serving the console yourself

`app/dist` is the whole console. Serve it from anywhere and put a `config.js` next to its
`index.html` setting `window.DUTYBOARD_CONFIG` — the fields are in
[`app/src/config.js`](app/src/config.js), and `ConsoleConfig` in
[`cli/internal/provision`](cli/internal/provision/provision.go) writes one. Add the origin you
serve it from to the auth instance's allowed origins and the function's CORS list. Set the
function's `DUTYBOARD_CONSOLE_URL` secret (`env` exposure) to its address, so machines pairing
can say where to go.

A console with no `config.js` values can be pointed at a deployment from its sign-in screen
(**Connect your altengine**), which keeps the values in that browser.

If your instances are named differently, the function needs `DUTYBOARD_DATASTORE`,
`DUTYBOARD_AUTH`, `DUTYBOARD_CHANNEL`, `DUTYBOARD_BLOB` and `DUTYBOARD_SEARCH` as `env`-exposure
secrets; the provisioner sets them for the names it found.

## Working on DutyBoard

From nothing, against the local emulator:

```bash
curl -fsSL https://raw.githubusercontent.com/altlimit/dutyboard/main/scripts/provision.sh | sh
```

It installs `alt` and, through it, the altengine emulator and `dutyboard`; clones the repo;
installs the npm dependencies; starts the emulator if nothing is answering; builds the function
and the console; and has `dutyboard --provision-only` provision the emulator. It is safe to re-run
— an emulator that is already up is used rather than restarted, so a re-run does not throw away
the board you were testing on. In a checkout it is `npm run provision`, and `--smoke` adds the
end-to-end test at the end.

An empty board shows you nothing, so there is a seeder:

```bash
npm run demo        # a board mid-flight, and the account to sign in with
```

It drives the real API — poll, claim, complete, ask, interrupt — so every column has
something in it and one duty is parked on a question waiting for an answer.

The console's dev server is pinned to port 5173 (`strictPort`), because the origin is baked into
two allowlists at provision time and a silent move to 5174 gives you a console that loads and
then fails every call. If something else owns 5173, move both halves together:

```bash
DUTYBOARD_PORT=5180 npm run setup && DUTYBOARD_PORT=5180 npm run dev
```

With [taskr](https://github.com/altlimit/taskr), `taskr "Start All"` starts the emulator,
provisioning, the console and the marketing site.

### The commands

| Command | What it does |
| --- | --- |
| `npm run provision` | Everything below, in order, from nothing. `--hosted` for hosted altengine. |
| `altengine dev` | The emulator: every data plane plus an admin console, on :9191. |
| `npm run setup` | Bundles the function and provisions the emulator from this checkout. |
| `npm run deploy` | Builds the function and console and provisions hosted altengine from this checkout, console included. |
| `npm run dev` | The console, on :5173. |
| `npm run dev:site` | The marketing site, watched, on :8888. |
| `npm run build` | The function, the console and the site. `build:fn`, `build:app` and `build:site` do one each. |
| `npm run deploy:site` | Uploads `site/public` to the static instance behind www.dutyboard.com and makes it live. |
| `npm run demo` | Fills a board with a plausible afternoon's work, and prints the sign-in. |
| `npm run smoke` | The whole state machine end to end, plus a cross-tenant matrix over every endpoint. |

Provisioning is HTTP — the emulator's admin API locally, the MCP endpoint hosted — which is why
it lives in [`cli/internal/provision`](cli/internal/provision). `npm run setup` and
`npm run deploy` run it with `go run`, so a checkout needs Go 1.25 as well as Node. `npm run setup`
is not optional: instances auto-create on first use but their *config* does not, so the console
would sign you up and then get 403 on every read.

### Publishing the marketing site

```bash
npm run build:site
ALTENGINE_KEY=ak_… npm run deploy:site      # DUTYBOARD_STATIC_INSTANCE=dutyboard
```

[`scripts/deploy-site.mjs`](scripts/deploy-site.mjs) sends a manifest of every file's path, size
and sha256, uploads only what the platform does not already have, then activates — a pointer
move, so a rollback is the same call with an older deployment id. It refuses a build that carries
a console. The key needs **write** on that static instance and nothing more.

[`.github/workflows/deploy-site.yml`](.github/workflows/deploy-site.yml) does the same on a push
to `main` that changes `site/`. With no `ALTENGINE_KEY` secret it builds, says what is missing,
and passes.

The site's canonical host is `url` in [`site/data/site.json`](site/data/site.json); the canonical
link, Open Graph URL, `robots.txt` and `sitemap.xml` are built from it.

## Sharing a board

A board has one owner and up to 25 members. The owner adds someone by email under
**Settings → Members**; that person must already have an account, since sign-up may be off.

| | Owner | Member |
| --- | --- | --- |
| See every duty, thread and file | ✓ | ✓ |
| Add duties, answer questions, send work back, attach, edit | ✓ | ✓ |
| Delete a duty | ✓ | |
| Rename or delete the board, add or remove members | ✓ | |
| Mint or revoke agent tokens | ✓ | |

The split is who can hurt the board or reach outside it. A token is how software gets onto a
board, so handing them out stays with the person the board belongs to.

**Membership is held twice, on purpose.** `memberships` rows are the truth, and the function
reads them on every write a member makes — so removing someone stops their changes on the
next request. The console's *reads* go straight to the datastore, though, where the only thing
a row rule can see about a person is their token. So membership is copied into a `boards`
claim on the account, and each read rule is "rows you own, **or** rows on a board in your
claim":

```json
"duties": { "read": { "any": [
  [{ "field": "owner_uid",  "op": "=",  "value": "$auth.uid" }],
  [{ "field": "project_id", "op": "in", "value": "$auth.claims.boards" }] ] } }
```

That copy rides the identity token, which lasts an hour, and the console closes the gap
itself: before its first read, and whenever the board list loads, it asks the function whether
its token is behind (`/me/access`) and refreshes if so. A person added to a board sees it the
next time they open DutyBoard. A person *removed* keeps read access until their token expires
— up to an hour — and no write access at all.

**Two platform rules shape the claim**, and both would lock owners out of their own boards if
ignored:

- A rule that references a claim the account does not have is a hard deny for the *whole*
  rule, including the owner branch. Every account needs `boards`, so the function gives it to
  one the first time the console asks.
- `in` over an empty list is refused as a bad query. So the claim is never empty: it always
  starts with `"-"`, which no board id can be.

Adding someone means writing their claims, so the function holds **`write`** on the auth
instance, not `read`. That lets it change any user's claims on that instance — the price of
sharing, and the reason members are managed only through the owner-only endpoints in
[`functions/src/members.js`](functions/src/members.js).

## Running agents on your machine

`dutyboard` is also the runner. On the computer that should do the work, with the board's agent
installed and signed in — [Claude Code](https://claude.com/claude-code), or
[Codex](https://github.com/openai/codex) (`npm i -g @openai/codex`, then `codex login`); each board
picks one in its settings:

```bash
dutyboard --root D:\dutyboard      # or any folder; ~/dutyboard by default
```

The first time, it pairs this machine with your DutyBoard: it prints a code, you approve it in the
console, and the machine gets its own key. It offers to start itself when you log in, and runs in
the background from then on. Which boards it works you choose in the console — **Work it on …** on
a board's settings, or on the Machines page. Run in a repository, it also offers the boards that
name that repository, or to create one.

A board worked by a machine names its **repository URL**, and the machine keeps its own clone of it
at `<root>/<board>/`. It never works in, or adds branches to, a checkout you use. Point a board at
another repository and machines clone that one; duties under way finish where they started. Files
the project needs that git does not carry (an `.env`) go in `<root>/<board>/local/`, and the setup
duty tells you which.

Git runs as the machine's user, with its keys and credentials. A board can set the **commit author**
and an **SSH command** (another key or account) — written into the machine's clone of that board,
never your global config. A board that opens **pull requests** needs the GitHub CLI signed in on the
machine (`gh auth login`); without it, the machine says so on the board and takes none of its duties.

The loop is the program's, not the agent's. For each duty it:

1. **claims** it — within seconds of it being filed, from the board's live channel;
2. **prepares a git worktree** for it at `~/.dutyboard/worktrees/<board>/<duty>` on branch
   `duty/<id>`, so your own checkout is never touched and several duties can run at once;
3. **starts Claude Code** there with that one duty, the board's rules and the project's profile,
   and a local MCP server that only lets the session change its own duty;
4. **checks the board** when the session ends: done means the work was integrated — rebased,
   tested and pushed, or opened as a pull request — and the worktree is removed. Parked on a
   question means the worktree waits, and your answer resumes the same conversation in the same
   folder. Stopped early means it is retried, and after three tries it is put to you with the
   session log attached.

After a duty lands, a board that deploys through CI has its run watched (with the GitHub CLI): a
failing deploy becomes an immediate duty to fix it, with the failing log in its brief. A board that
deploys to altengine gives sessions `altengine_deploy_static` and `altengine_deploy_function`, which
deploy only to the instances the board's profile allows, with the machine's **deploy key**. Set it with
`dutyboard --deploy-key`, and give that key write on each site and full on each functions instance
your boards deploy to — nothing more, since agents run as you and could read it. The key
`--provision-only` uses manages your whole DutyBoard and is not kept unless you say so. The runner
checks the deploy key against every board's instances as it starts, and says on the Machines page
what the key is missing before any duty gets as far as deploying.

A linked board starts with a **setup** duty, which gets this machine ready for the project and
records the toolchain it installed, and a **rules** duty, which drafts the project's rules for you to
accept. How many duties run at once is set per board (`runner.parallel`) and per machine
(`max_sessions`).

### How work lands

A board's **git mode** says what `duty_integrate` does with a finished duty's commits:

- **push** — rebase onto the main branch, run the test command, push the commits as they are;
- **squash** — the same, but the duty's commits become one commit titled with the duty's title,
  listing the commits it replaced;
- **pr** — push the duty's branch and open a pull request with the GitHub CLI, for a person to merge.

A repository with no remote leaves the work on the duty's branch.

### Claude Code or Codex

Each board says which agent works it (**Settings → How agents run on it**). A machine without that
agent installed and signed in says so on the Machines page and takes none of the board's duties. The
runner gives either one the same duty, rules, instructions, worktree and MCP servers; what differs
is how they are started:

- **Claude Code** runs as `claude -p` with the board's permission mode, the tools it may use, and an
  MCP config of exactly the board's servers.
- **Codex** runs as `codex exec --json`, never asking for approval, with its sandbox limited to the
  worktree plus the clone's git folder and the tools folder, and network access on. A board set to
  bypass permissions runs it without the sandbox. Its MCP servers' secrets reach it through its
  environment, never its command line. It resumes the session it started when a parked duty comes
  back.

### MCP servers for a board's sessions

A board can give its sessions more tools than DutyBoard's own: a browser to take screenshots with,
an issue tracker, a docs server. In the board's **Settings**, under **MCP servers**, each one is
either a command every machine starts (`npx @playwright/mcp`) or a URL it connects to, with:

- **settings** — plain environment variables for a command (`BROWSER=chromium`);
- **secrets** — only the *names* of the environment variables (for a command) or headers (for a
  URL) that carry credentials, like `GITHUB_TOKEN` or `Authorization`;
- **tools** — the ones sessions may use, or none listed for all of them;
- **what it is for** — a line every session is given, so the agent knows when to reach for it.

Everyone on a board can read its profile, so no value there is private, and anything that looks like
a credential in the settings is refused. Each machine keeps the secrets' values itself:

```bash
dutyboard --mcp-secrets     # asks for each secret the boards this machine works need; OS keyring
```

A session is connected to exactly the board's servers and DutyBoard's — nothing else from your own
Claude Code setup (`--strict-mcp-config`) — and may call only the tools the board allows. A server
a machine cannot start, because a secret is not set there or its command is not installed, is left
out of that machine's sessions and named on the Machines page. Editing the list is the owner's, like
every other part of the profile that makes a machine run something.

## Connecting an agent

Mint a token on the board's **Settings** page — tokens are the owner's to mint. Then, as an MCP server:

```bash
claude mcp add --transport http dutyboard-<board> \
  "https://<subdomain>-fn.altengine.app/board/mcp?agent=alpha" \
  --header "Authorization: Bearer db_…"
```

**One connection is one board.** The URL is the same for every board; the token decides which
one, and a token is refused on any board but its own. So an agent never has to tell boards
apart — and the server is named after the board so you can have more than one:

- **A board per repo** is the clean setup. Run the command inside that repo: Claude Code keeps
  the server for that directory, so the agent working there sees that board and nothing else.
- **Several boards in one session** each get their own server, and their tools arrive as
  `mcp__dutyboard-payments__duty_poll` and `mcp__dutyboard-docs__duty_poll`. Say which board is
  for what, or the agent will guess.

`claude mcp remove dutyboard-<board>` disconnects one — which is also the way to swap in a
new token after revoking the old.

The agent gets `duty_poll`, `duty_claim`, `duty_enqueue`, `duty_checkpoint`,
`duty_complete`, `duty_fail` and `duty_thread` as tools. `?agent=alpha` names the worker
so the model does not have to repeat it on every call — and so two agents on one board
never look like the same one.

Or over plain HTTP, with the same header:

```bash
curl -X POST https://<subdomain>-fn.altengine.app/board/duty/poll \
  -H "Authorization: Bearer db_…" -d '{"agent_id":"alpha"}'
```

[`agent/OPERATING.md`](agent/OPERATING.md) is the loop to hand an agent, and it is
published at [dutyboard.com/agent.md](https://www.dutyboard.com/agent.md) so you can point
at a URL instead of a file. Drop it in a `CLAUDE.md`, a system prompt, or a skill.

Often you do not have to. The same protocol comes back in the MCP handshake, in the
`instructions` field of `initialize`, and clients that surface server instructions put it
in front of the model with no setup at all. Not all of them do — which is the only reason
the file still matters.

Whichever way it arrives, one line in it does the real work: **an agent that hits a
question does not wait.** It parks the duty with `duty_checkpoint`, records the question,
and claims something else. That is what makes the board asynchronous rather than a queue
of stalled agents, and it is the instruction most likely to be quietly overridden by a
protocol written on the assumption that asking means blocking.

## The API

Every endpoint is `POST`, takes JSON, and answers JSON. Agent endpoints accept either
credential where it makes sense; the human ones refuse agent tokens outright.

The paths below are relative to the function itself:
`https://<subdomain>-fn.altengine.app/board/…` hosted,
`http://127.0.0.1:9191/fn/dutyboard/board/…` against the emulator. The function is deployed
as `board` and not `api` because the platform reserves `api` as a function name — its own
console makes relative calls to `/api/auth/*`, and a function answering there could be
lured into serving them. The emulator does not enforce it, so a deploy named `api` fails
only when you first try it hosted.

| Endpoint | Who | What |
| --- | --- | --- |
| `/duty/poll` | agent | Held duty + the top of the queue, with any resolution folded in. |
| `/duty/claim` | agent | `queued` → `active`, for exactly one agent. |
| `/duty/enqueue` | both | New work. `immediate_blocker` interrupts what the caller holds. |
| `/duty/checkpoint` | both | Post to the thread; optionally park the duty. |
| `/duty/complete` | agent | `active` → `done`. Requires an outcome summary. |
| `/duty/fail` | agent | `→ failed`, with a reason. |
| `/duty/thread` | both | The decision log for one duty. |
| `/duty/search` | both | Finished duties matching a query, with their outcome summaries. |
| `/duty/attach` | both | Reserve a file on a duty; answers with a URL to PUT the bytes to. |
| `/duty/attachments` | both | The files on a duty, each with a short-lived signed URL. |
| `/duty/attachment/delete` | both | Remove a file, and the object behind it. |
| `/duty/resolve` | human | Answer a question; re-queue at the front. |
| `/duty/reopen` | human | `done`/`failed` → `queued`, with a required note saying why. |
| `/duty/update` · `/duty/delete` | human | Edit a duty; remove one (owner only). |
| `/board/open` | human | The board, its agents and a channel token — one call, for the console. |
| `/board/reindex` | human | Index work finished before search was turned on. Resumable. |
| `/board/members/list` | human | The owner and everyone else on a board. |
| `/board/members/add` · `/board/members/remove` | owner | Share a board by email, or stop sharing it. |
| `/board/members/agents` | owner | Let a member link their own machines to the board, or stop them. |
| `/board/profile` · `/board/rules` | both | What the project is and how it is run; the rules in force (people also see a pending draft). |
| `/board/profile/propose` | agent | While holding a `setup` duty: record the toolchain, test command, deploy method and worktree prep. |
| `/board/rules/submit` | agent | While holding a `rules` duty: hand in proposed rules, as a draft. |
| `/board/rules/set` · `/board/rules/accept` | owner | Write the rules by hand, or put the draft in force. |
| `/me/access` | human | Repair this person's `boards` claim; says whether their token is behind. |
| `/projects/*` | human | `create` (optionally with a `profile` and `runner`), `list` (owned and shared), `rename`, `profile` and `delete` (owner only). |
| `/tokens/*` | owner | `mint`, `list`, `revoke`. |
| `/live/token` | human | A subscribe-only channel token for one board. |
| `/connect/start` · `/connect/poll` | anyone | A `dutyboard` daemon pairing: start, then poll until approved for its `dbm_` machine key (handed over once). |
| `/connect/lookup` · `/connect/approve` · `/connect/deny` | human | Approve or refuse a pairing by the code the daemon printed. |
| `/machines/*` | human | `list` your machines (online, boards, what each is doing), `update`, `revoke`, `unlink` (also the board's owner). |
| `/machine/*` | machine | `me`, `link` / `unlink` a board, `poll` every linked board at once, `live` (channel token), `state`, `request` (a person asks a machine to set a board up) and `request/report`. |
| `/mcp` | agent | The same tools over JSON-RPC. |
| `/health` | anyone | No credential; safe to check a deploy with. |

Errors are `{"error": {code, message, details?, request_id}}` with a real status: `409` for
a claim that lost a race or a second active duty, `403` for a token pointed at the wrong
board, `400` naming the field and the values it accepts.

A `dbm_` machine key reaches only the boards its machine is linked to, and names the one a call
is about in an `x-dutyboard-board` header; with it, every agent endpoint above works exactly as it
does for a project token. Its agent ids are its own prefix and `<prefix>/<n>`. On a board whose
`runner.parallel` is set, a claim beyond that many active duties is a `409`, and a `setup` or
`rules` duty only runs with the board to itself.

## The rules the state machine actually enforces

- **One active duty per agent, and one agent per duty.** Both directions, and neither is a
  read-then-check — they are **two unique indexes**, so the datastore refuses the losing
  write and its whole claim transaction fails with the duty untouched:

  | constraint | stops |
  |---|---|
  | `agents.active_duty_id` unique | two agents holding one duty |
  | `duties.holder` unique (`<board>:<agent>` while active, else null) | one agent holding two duties |

  Nulls do not collide, which is the property that makes this work at all: every idle agent
  and every unheld duty is null, and any number of them may be.

  This replaced a compare-after-write — claim, then re-read and check you are the one named
  — which could not work and did not. Both claimers write, then both read, and whichever
  reads before the other writes sees itself and walks away believing it won. Measured:
  **two in ten** contended claims won twice, and **fourteen in fifteen** for the mirror case
  where one agent claimed two duties at once. `/health` reports `single_holder`, because a
  constraint that is silently missing is worse than one nobody claimed to have, and the
  smoke suite races both directions on a board of its own.

  If `single_holder` comes back `false`, the index could not be created — almost always
  because existing rows already violate it, which on a deployment that ran the old code is
  exactly what the bug left behind. Find them (`agents` sharing an `active_duty_id`), free
  all but one, and the next claim creates the index. Until then claims still work; they are
  just not protected, which is why the flag exists rather than a silent retry.
- **Anything that stops being the agent's problem frees the agent, in the same
  transaction.** Parked for a decision, blocked behind a child, finished. Otherwise an
  agent that asked a question would sit idle waiting for an answer, which is the failure
  this whole design exists to avoid.
- **An interrupt is reversible.** `enqueue` with `immediate_blocker` while holding a duty
  moves that duty to `blocked` referencing the new child. Completing the child puts the
  parent back at the front of the queue. Without that last step the pattern is a one-way
  trip and the parent sits in `blocked` forever.
- **The queue is priority, then FIFO.** `immediate_blocker` → `next` → `backlog`, and
  oldest-first within each. A resolution raises its duty to `immediate_blocker`, which is
  what "back at the top" means. **The Queued column is ordered the same way**, so the card
  at the top of it is the duty an agent will actually claim next — the board and the
  scheduler are asserted to agree. `Needs you` is oldest-first for the same reason:
  the question waiting longest is the one that has been blocking someone longest.
- **Only a human resolves.** An agent posting `kind: "resolution"` is refused, or the
  decision log stops meaning what it says.
- **Done is a claim, not a fact — and only a person may overturn it.** `/duty/reopen`
  takes a finished duty back to the front of the queue, and the note saying why is
  **required**: without it the next agent reads an outcome summary asserting the work is
  done and has nothing to tell it otherwise. The note goes on the thread *and* onto the
  row, so `poll` and `claim` hand it over as `reopened` — alongside `previous_outcome`,
  what the last attempt claimed, kept but no longer presented as an outcome. The duty
  leaves the finished search index, because a search for completed work that returns
  something sitting in the queue is how an agent concludes a thing is done when it is not.
  Agents cannot reopen: it is a verdict on somebody's work, and it is the one transition
  that could loop if the thing being judged could take it.
- **`outcome_summary` is required to complete.** It is the only record that survives the
  agent's session — and now the only one that can be *found*: finished duties are indexed
  into a search instance, so an agent can ask "have we done this before, and how?" before
  rebuilding something. Open duties are deliberately not indexed; the board already shows
  those. The board is pinned with a **facet refinement**, not a query-string prefix, so
  nothing a caller writes in a query can widen it to another board — including `-nothing`,
  which matches everything. Search is optional: `/health` reports it, and a deployment
  without a search instance works in every other way.

## Costs and bounds

- Attachment bytes normally never pass through the function. It decides whether a caller may
  upload and how big, signs a URL, and the client PUTs to storage directly — which is what
  makes a video attachment a video attachment rather than a 413. There is one narrow
  exception: a caller whose entire transport is MCP holds a list of tools, not an HTTP
  client, so asking it to PUT was asking for something it cannot do. `content_base64` on
  `duty_attach` stores the bytes in that call, up to 2MB — a screenshot or a log, not a
  recording. Objects are private; every read
  mints a URL that lasts minutes, for a caller just checked against the board. Twenty files
  a duty, 50MB each. The count cached on the duty row is a hint, not a ledger: uploads
  landing together all read it and all write the same increment, so it can under-count until
  something reads the duty, which reconciles it to the rows that actually exist.
- A poll is one indexed query plus one or two point-reads. Briefs are clipped to 220
  characters in the queue listing; the full text comes with the claim.
- Opening a board is three requests, whatever its size: `/board/open` for the name, the
  agents and a channel token, then two queries — the working set (everything not done, read
  whole and sorted into columns in the browser) and the top of `done`. Only `done` grows
  without end, so only `done` pages.
- A column showing only part of itself says how big it really is, and one grouped-count
  aggregate answers for every column at once. It is asked for **only when something is
  actually truncated** — on a board that fits, the rows on screen are the count and a
  second query would buy nothing. So a small board opens in three requests and a board of
  260 duties in nine, which is where the extra reads are worth their keep.
- `last_used_at` on a token is stamped at most once a minute, and reuses the row that
  authenticated the call rather than reading it twice.
- Every list is paged with a keyset cursor and says when it is showing a partial answer —
  the board's columns included — and when one is truncated it shows the real total rather
  than a quiet `12+`.
- Live events carry an id and a status, plus the three visible fields of an agent row when
  the event moved one. The console re-reads everything else through the access-controlled
  path, so an event can never reveal a duty its reader may not see.
- **Four caps, and they are about your invoice rather than our opinion.** 500 unfinished
  duties a board, 200 thread entries a duty, 100 boards a person, 50 live tokens a board.
  Agents write here unattended and [the protocol](agent/OPERATING.md) tells them to enqueue
  what they find rather than absorb it, which is right until something loops — after that a
  number like these is the only thing between a bad afternoon and a bad bill. Each is set
  where a person has plainly already lost the board, so meeting one is a signal rather than
  a limit to manage around, and each refusal names the number and what to do instead,
  because the caller is usually an agent and "quota exceeded" is not actionable.
  Counting is keys-only and stops at the cap, so asking costs the same whether the true
  answer is 500 or a million.

## Accessibility

WCAG 2.1 AA: semantic landmarks, one `<h1>` per view, every control labelled, visible
focus, focus moved on navigation, status conveyed as text and not colour alone,
`aria-live` for async results, a skip link, both themes at AA contrast, and
`prefers-reduced-motion` respected.

The theme follows the device by default and can be set to light or dark explicitly; the
choice is applied before first paint, so a saved dark preference never flashes white.

## On a phone

Most of a board is read standing up, so the console is built for that first. Above 1080px
the board is columns sharing the full window — no horizontal scrollbar, and the column
headings stay put as you scroll. Below it, the columns become a row of status chips and one
list: a phone showing five columns side by side is showing none of them, and scrolling
sideways to find the one you wanted is worse than choosing it. Tap targets are 44px, inputs
are 16px so iOS does not zoom into them, and no page scrolls sideways at 390px — which is
checked, not assumed.

## What this is not

There is no sharing yet — a board has one owner. No sub-boards, no scheduled duties, no
notifications. Deliberately: the point is the loop, and each of those is a real feature
rather than a corner to cut.
