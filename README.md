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
       ▼         │   done    │
  ┌─────────┐    └─────┬─────┘
  │ blocked │◄─────────┘
  └─────────┘   finishing the child re-queues its blocked parent
```

## Layout

```
site/        the marketing site at www.dutyboard.com  (sitegen)
app/         the console at /app                      (Vue 3 + Vite)
functions/   the state machine, one deployed module   (altengine functions)
backend/     instance configuration to apply once
scripts/     provision, deploy, serve, and the end-to-end smoke test
public/      build output — both halves, gitignored
```

`npm run build` runs the two builds in that order on purpose: the site build cleans
`public/` first, so doing it the other way round deletes the app.

The console is served from `/app` in development too, not from `/`. A path assumption that
only holds on one of them is exactly the kind of thing that survives every local test.

### The one rewrite it needs

The console is a single-page app. Every path under `/app` has to serve
`public/app/index.html` rather than 404 — one rule:

```
/app/*  →  /app/index.html   (200, not a redirect)
```

Until the static service that does this is available, the router uses hash URLs
(`/app/#/b/my-board`), which need no rewrite and work on any static host. Switching is one
line in [`app/src/router.js`](app/src/router.js): `createWebHashHistory()` →
`createWebHistory("/app/")`.

## How it is built

DutyBoard runs on [altengine](https://www.altengine.net) — no server of its own.

| Piece | Service | What it does |
| --- | --- | --- |
| `board` | **functions** | The whole state machine, as one deployed module. REST at `/duty/*` and an MCP endpoint at `/mcp`. |
| `dutyboard` | **datastore** | `projects`, `duties`, `threads`, `agents`, `tokens`. |
| `dutyboard-auth` | **auth** | The people who own boards. Row rules scope every read to its owner. |
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
AND `owner_uid = you` into every query server-side. The page cannot ask for someone else's
board, and does not have to remember to try.

### Two kinds of caller

| | Credential | How it is checked |
| --- | --- | --- |
| **A person** | An auth identity token (`id_token`) | `env.auth.verifyToken` — the signing secret never enters this code. Ownership is checked per request. |
| **An agent** | A project token, `db_…` | Only its SHA-256 is stored, and that hash **is** the document key. Verifying a token is one point-read; the row names exactly one board, so an agent can never reach another. |

The `db_` prefix is what tells them apart. A token is shown once, at mint, and never again.

## Run it

One command, on a machine with none of this installed:

```bash
curl -fsSL https://raw.githubusercontent.com/altlimit/dutyboard/main/scripts/provision.sh | sh
```

It installs [`alt`](https://github.com/altlimit/alt) and, through it,
[sitegen](https://github.com/altlimit/sitegen) and the altengine emulator; clones the
repo; installs the npm dependencies; starts the emulator if nothing is answering;
provisions every instance and its config; deploys the function; and builds the site and
the console. It is safe to re-run — an instance that exists is left alone, and an emulator
that is already up is used rather than restarted, so a re-run does not throw away the board
you were testing on.

In a checkout it is `npm run provision`, and `--smoke` adds the end-to-end test at the end.

An empty board shows you nothing, so there is a seeder:

```bash
npm run demo        # a board mid-flight, and the account to sign in with
```

It drives the real API — poll, claim, complete, ask, interrupt — so every column has
something in it and one duty is parked on a question waiting for an answer. That question
is the product; answer it and watch the duty go back to the front of the queue.

The console is pinned to port 5173 (`strictPort`), because the origin is baked into two
allowlists at provision time and a silent move to 5174 gives you a console that loads and
then fails every call. If something else owns 5173, move both halves together:

```bash
DUTYBOARD_PORT=5180 npm run setup && DUTYBOARD_PORT=5180 npm run dev
```

Then, with [taskr](https://github.com/altlimit/taskr), one command starts everything —
the emulator, provisioning, the console and the marketing site:

```bash
taskr "Start All"
```

### The commands

| Command | What it does |
| --- | --- |
| `npm run provision` | Everything below, in order, from nothing. `--hosted` for hosted altengine. |
| `altengine dev` | The emulator: every data plane plus an admin console, on :9191. |
| `npm run setup` | Applies `backend/` — instances, auth rules, indexes, the function's CORS list. |
| `npm run deploy` | Bundles `functions/src` and deploys it. |
| `npm run dev` | The console, on :5173/app/. |
| `npm run dev:site` | The marketing site, watched, on :8888. |
| `npm run build` | Both, into `public/`. |
| `npm run preview` | Serves `public/` as a static host would, rewrite included, on :4173. |
| `npm run demo` | Fills a board with a plausible afternoon's work, and prints the sign-in. |
| `npm run smoke` | The whole state machine end to end, plus a cross-tenant matrix over every endpoint. |

`altengine dev` is the *only* altengine CLI command involved: there is no `altengine apply`
or `altengine deploy`. Provisioning is HTTP — the emulator's admin API locally, the MCP
endpoint hosted — which is why it lives in [`scripts/setup.mjs`](scripts/setup.mjs) rather
than in a list of CLI invocations.

`npm run setup` is not optional. Instances auto-create on first use but their *config*
does not: a fresh auth instance collects only an email and grants no access at all, so the
console would sign you up and then get 403 on every read.

### Deploying to hosted altengine

```bash
export ALTENGINE_KEY=ak_…
npm run provision -- --hosted
```

That key needs the **MCP / AI agent access** toggles on the key form, which are off by
default: `Instances & data: Write` and `Functions: Write`. Not Full — nothing here deletes
an instance, and Full is what lets a key do that. `Usage` and `Live desktop inspection`
stay None. A key without them fails with "lacks 'write'", which reads like a bug in the
script and is not one.

That creates the instances, sets the datastore's config, declares the indexes, applies the
access rules, sets the function's CORS origins, deploys the function, and builds `public/`.

One thing it cannot do, and says so instead of half-succeeding: **set the auth instance's
sign-up form and allowed origins.** Auth config is split across four independently
validated sections, and the platform refuses to merge them blindly from a tool call. Paste
[`backend/signup.json`](backend/signup.json)'s fields and add the origin the console is
served from.

On older altengine it also could not CREATE the auth and channel instances — both mint a
signing secret at creation, and `create_instance` would not do that. It tries now, and only
reports them as console work if that refusal actually comes back, so the same command is
right on both.

Re-run it afterwards; it checks the instance as it actually is and reports only what is
still missing.

**On sign-up, decide before you finish.** `allowSignup` is on by default, which is what you
want for exactly as long as it takes to create your own account — after that it is an open
door onto your quota. Either turn it off in the console once you have signed up, or leave
it off from the start and create your account with the MCP's `auth_create_user`, which
sends no email and does not need the public route. Allowed origins are not a substitute:
CORS binds browsers, and nothing else.

### Letting an agent install it

Everything above is also written for an agent to do, at
[dutyboard.com/llms.txt](https://www.dutyboard.com/llms.txt). Give an assistant the
altengine MCP (`https://api.altengine.net/mcp`) and that URL — with a key scoped the same
way as above — and it provisions the rest:
the instances, the datastore settings, the access rules, the function with its grants and
CORS, and your account.

The only step that may fall to you is the auth instance's sign-up form and allowed origins.
The agent tries it over MCP and asks you to do it in the console if that altengine does not
expose auth config yet. Then it hands back a link that fills the console's connection form
with what it provisioned, so the last step is one click.

It does not declare indexes, and neither should you when starting from nothing. Auto-index
is on: the first query needing one creates it and retries, and on an empty collection that
build writes nothing. [`backend/indexes.json`](backend/indexes.json) stays the record of
what the app asks the datastore for — worth reading, not worth running.

The link fills the form; it does not save. A link that silently repointed a console would
be a tidy way to put someone's sign-in form in front of an auth instance they do not own,
and "click here to see the board" is how that would arrive.

The function bundle it deploys is served from
[dutyboard.com/board.js](https://www.dutyboard.com/board.js) — one self-contained ES module,
byte-identical to `npm run build:fn` from this repo. That is a supply-chain position, so it
is worth knowing you can rebuild it and compare rather than take it on trust.

### You do not have to serve the console

The hosted one at [dutyboard.com/app](https://www.dutyboard.com/app/) is a static page that
talks to whatever altengine you point it at. **Connect your altengine**, on its sign-in
screen, takes the same instance names used above, tests the connection before saving, and
keeps them in that browser. Nothing about your boards passes through dutyboard.com — the
page is served from there, the data never is.

It needs the console's origin on two allowlists, the same two `DUTYBOARD_ORIGINS` sets
locally: the auth instance's allowed origins, and the functions instance's CORS list.

`public/` is the whole static site if you would rather serve it yourself: marketing at the
root, the console under `/app`. Host it anywhere that can serve a directory — and, once you switch the router to history
URLs, that can also apply the rewrite above. `npm run preview` serves it exactly that way
locally, which is the only way to find out whether the rewrite is right before a deploy
depends on it.

If your instances are named differently, set `DUTYBOARD_DATASTORE`, `DUTYBOARD_AUTH`,
`DUTYBOARD_CHANNEL`, `DUTYBOARD_BLOB` and `DUTYBOARD_FN_INSTANCE` for the deploy, the
matching `VITE_*` vars for the console, and add the names as `env`-exposure secrets on the
functions instance so the deployed code resolves them too.

`DUTYBOARD_BLOB` has no `VITE_*` twin, and that is not an omission: the console never names
the blob instance. It asks the function for an upload URL and sends the file to whatever
comes back, so where attachments are stored is the function's business alone. `/health`
reports whether they are configured, which is what the console's **Connect your altengine**
screen shows.

## Connecting an agent

Mint a token on the board's **Agents & tokens** page. Then, as an MCP server:

```bash
claude mcp add --transport http dutyboard \
  "https://<subdomain>-fn.altengine.app/board/mcp?agent=alpha" \
  --header "Authorization: Bearer db_…"
```

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
| `/duty/update` · `/duty/delete` | human | Edit or remove a duty. |
| `/board/open` | human | The board, its agents and a channel token — one call, for the console. |
| `/board/reindex` | human | Index work finished before search was turned on. Resumable. |
| `/projects/*` | human | `create`, `list`, `rename`, `delete`. |
| `/tokens/*` | human | `mint`, `list`, `revoke`. |
| `/live/token` | human | A subscribe-only channel token for one board. |
| `/mcp` | agent | The same tools over JSON-RPC. |
| `/health` | anyone | No credential; safe to check a deploy with. |

Errors are `{"error": {code, message, details?, request_id}}` with a real status: `409` for
a claim that lost a race or a second active duty, `403` for a token pointed at the wrong
board, `400` naming the field and the values it accepts.

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
