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
scripts/     setup, deploy, and the end-to-end smoke test
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
| `api` | **functions** | The whole state machine, as one deployed module. REST at `/api/duty/*` and an MCP endpoint at `/api/mcp`. |
| `dutyboard` | **datastore** | `projects`, `duties`, `threads`, `agents`, `tokens`. |
| `dutyboard-auth` | **auth** | The people who own boards. Row rules scope every read to its owner. |
| `dutyboard-live` | **channel** | Board and duty events, so the console moves as agents work. |

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

With [taskr](https://github.com/altlimit/taskr), one command starts everything —
the emulator, provisioning, the console and the marketing site:

```bash
npm install
taskr "Start All"
```

Or by hand:

```bash
altengine dev                 # the emulator, on :9191
npm install
npm run setup                 # provision the instances from backend/
ALTENGINE_URL=http://127.0.0.1:9191 ALTENGINE_KEY=dev npm run deploy
npm run dev                   # the console, on :5173/app/
npm run dev:site              # the marketing site, on :8888
npm run smoke                 # 55 assertions over the whole state machine
```

`npm run setup` is not optional. Instances auto-create on first use but their *config*
does not: a fresh auth instance collects only an email and grants no access at all, so the
console would sign you up and then get 403 on every read.

### Deploying to hosted altengine

Create four instances in the [console](https://console.altengine.net) — `dutyboard`
(datastore), `dutyboard-auth` (auth), `dutyboard-live` (channel), `dutyboard` (functions).
Auth and channel mint a signing secret at creation, so they can only be made there.

Then paste the configs from [`backend/`](backend/): [`signup.json`](backend/signup.json)
as the auth instance's sign-up form, [`access.json`](backend/access.json) as its access
rules, and the indexes in [`indexes.json`](backend/indexes.json) on the datastore. Set the
functions instance's CORS origins to wherever you serve the console. Then:

```bash
export ALTENGINE_KEY=ak_…     # needs 'full' on the functions instance
npm run deploy                # the function
npm run build                 # the site and the console, both into public/
```

`public/` is the whole static site: marketing at the root, the console under `/app`. Host
it anywhere that can serve a directory — and, once you switch the router to history URLs,
that can also apply the rewrite above.

If your instances are named differently, set `DUTYBOARD_DATASTORE`, `DUTYBOARD_AUTH`,
`DUTYBOARD_CHANNEL` and `DUTYBOARD_FN_INSTANCE` for the deploy, the matching `VITE_*` vars
for the console, and add the names as `env`-exposure secrets on the functions instance so
the deployed code resolves them too.

## Connecting an agent

Mint a token on the board's **Agents & tokens** page. Then, as an MCP server:

```bash
claude mcp add --transport http dutyboard \
  "https://<subdomain>-fn.altengine.app/api/mcp?agent=alpha" \
  --header "Authorization: Bearer db_…"
```

The agent gets `duty_poll`, `duty_claim`, `duty_enqueue`, `duty_checkpoint`,
`duty_complete`, `duty_fail` and `duty_thread` as tools. `?agent=alpha` names the worker
so the model does not have to repeat it on every call — and so two agents on one board
never look like the same one.

Or over plain HTTP, with the same header:

```bash
curl -X POST https://<subdomain>-fn.altengine.app/api/duty/poll \
  -H "Authorization: Bearer db_…" -d '{"agent_id":"alpha"}'
```

[`agent/OPERATING.md`](agent/OPERATING.md) is the loop to hand an agent. Drop it in a
`CLAUDE.md`, a system prompt, or a skill.

## The API

Every endpoint is `POST`, takes JSON, and answers JSON. Agent endpoints accept either
credential where it makes sense; the human ones refuse agent tokens outright.

| Endpoint | Who | What |
| --- | --- | --- |
| `/api/duty/poll` | agent | Held duty + the top of the queue, with any resolution folded in. |
| `/api/duty/claim` | agent | `queued` → `active`, for exactly one agent. |
| `/api/duty/enqueue` | both | New work. `immediate_blocker` interrupts what the caller holds. |
| `/api/duty/checkpoint` | both | Post to the thread; optionally park the duty. |
| `/api/duty/complete` | agent | `active` → `done`. Requires an outcome summary. |
| `/api/duty/fail` | agent | `→ failed`, with a reason. |
| `/api/duty/thread` | both | The decision log for one duty. |
| `/api/duty/resolve` | human | Answer a question; re-queue at the front. |
| `/api/duty/update` · `/api/duty/delete` | human | Edit or remove a duty. |
| `/api/projects/*` | human | `create`, `list`, `rename`, `delete`. |
| `/api/tokens/*` | human | `mint`, `list`, `revoke`. |
| `/api/live/token` | human | A subscribe-only channel token for one board. |
| `/api/mcp` | agent | The same tools over JSON-RPC. |
| `/api/health` | anyone | No credential; safe to check a deploy with. |

Errors are `{"error": {code, message, details?, request_id}}` with a real status: `409` for
a claim that lost a race or a second active duty, `403` for a token pointed at the wrong
board, `400` naming the field and the values it accepts.

## The rules the state machine actually enforces

- **One active duty per agent.** A second `claim` is a `409` that names the duty to finish
  first. The claim is guarded by the agent row *and* confirmed by a read-back, so two
  agents racing for the same duty end with one of them told it lost — not both believing
  they won.
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
  what "back at the top" means.
- **Only a human resolves.** An agent posting `kind: "resolution"` is refused, or the
  decision log stops meaning what it says.
- **`outcome_summary` is required to complete.** It is the only record that survives the
  agent's session.

## Costs and bounds

- A poll is one indexed query plus one or two point-reads. Briefs are clipped to 220
  characters in the queue listing; the full text comes with the claim.
- `last_used_at` on a token is stamped at most once a minute, and reuses the row that
  authenticated the call rather than reading it twice.
- Every list is paged with a keyset cursor and says when it is showing a partial answer —
  the board's columns included, which is why they show `50+` rather than a quiet 50.
- Live events carry an id and a status only. The console re-reads through the
  access-controlled path, so an event can never reveal a duty its reader may not see.

## Accessibility

WCAG 2.1 AA: semantic landmarks, one `<h1>` per view, every control labelled, visible
focus, focus moved on navigation, status conveyed as text and not colour alone,
`aria-live` for async results, a skip link, both themes at AA contrast, and
`prefers-reduced-motion` respected.

## What this is not

There is no sharing yet — a board has one owner. No sub-boards, no scheduled duties, no
notifications. Deliberately: the point is the loop, and each of those is a real feature
rather than a corner to cut.
