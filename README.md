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
backend/     instance configuration the manifest declares (indexes, access rules, sign-up form)
cli/         `dutyboard`: the runner that works boards on a machine (Go)
cli/desktop/ the same program as a Windows app that lives in the system tray (Wails 3, Vue 3 + TypeScript)
scripts/     the deploy folder, local provisioning, site deploy, the demo seeder and the smoke tests
```

The three builds share nothing. `app/` builds to `app/dist`, which the manifest deploys to
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
| `dutyboard` | **datastore** | `projects`, `duties`, `threads`, `agents`, `tokens`, `memberships`, `attachments`; the machines paired to it and the boards they work; push subscriptions; and `settings` (the console's address, the push key). |
| `dutyboard-auth` | **auth** | The people on boards. Row rules scope every read to boards you own or are a member of. |
| `dutyboard-live` | **channel** | Board, duty and per-person events, so the console moves as agents work and machines hear about work the moment it is filed. |
| `dutyboard-files` | **blob** | Attachments on duties: screenshots, recordings, logs. |
| `dutyboard-search` | **search** | Finished duties and their outcome summaries, so an agent can ask whether something was done before. |
| `dutyboard-console` | **static** | The console, pointed at this deployment. |

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
| **An agent** | A project token, `db_…` | Only its SHA-256 is stored, and that hash **is** the document key. Verifying a token is one point-read; the row names exactly one source board. Ordinary tools stay scoped there; explicit [board links](#linking-boards) authorize access to other boards through a separate gateway. A token minted for an *integration* (scope `submit`) is narrower still: it files duties and follows the ones it filed — see [Connecting another system](#connecting-another-system). |
| **A machine** | A machine key, `dbm_…` | Handed over once, when a person approves the machine's pairing code; stored as a hash like a token. It reaches only the boards the machine is linked to, naming one per call. |

The prefix is what tells them apart. A token or key is shown once and never again.

## Run your own

**Deploy DutyBoard** into your own [altengine](https://www.altengine.net) account, from your browser:

[![Deploy to altengine](https://www.altengine.net/img/deploy-to-altengine.svg)](https://console.altengine.net/deploy?manifest=https%3A%2F%2Fwww.dutyboard.com%2Fdeploy%2Flatest%2Faltengine.json)

You sign in to altengine, choose an organization, see every instance it will create, and click
Deploy. It runs as you, within your role: nothing on any machine holds a key to do it. When it is
done the page links to your console, where you sign up — the first account is the owner. Opening the
same link later upgrades it ([below](#deploying-and-upgrading)).

**Then put a machine to work.** Install `dutyboard` with [alt](https://github.com/altlimit/alt) — no sudo, no package manager —
and run it:

```bash
alt install altlimit/dutyboard
dutyboard
```

That is the whole setup, as a checklist that asks only about what is not done yet:

1. **Your DutyBoard.** With none connected, give it your console's address — or choose *Set up my own
   on altengine*, which opens the deploy link first. With one connected, it compares the version your
   DutyBoard runs with this binary's, and says where to upgrade it when it is behind.
2. **This machine**, paired with a code you approve in the console.
3. **Starting by itself** — at login, or at boot on a server — and restarted when what is running is
   not this binary.
4. **What duties need from this machine**, printed: the agents and whether each is signed in, the
   GitHub CLI, a commit author, a deploy key, MCP secrets.
5. **Your console**, opened on this machine, where the same checklist is kept up to date and the
   machine can install an agent or the GitHub CLI, and sign in to it, when you ask
   ([below](#getting-a-machine-ready)).

Run it again whenever you like — after `alt update altlimit/dutyboard`, say: what is done is a ✓.

### On Windows, from a window

[DutyBoard-Setup.exe](https://github.com/altlimit/dutyboard/releases/latest/download/DutyBoard-Setup.exe)
installs DutyBoard for the desktop: the same program, with a window where the terminal was. It
installs for you alone, with no administrator, and is in the Start menu and in Windows' list of
installed apps, which is where it is removed from. Removing it leaves what it kept — its home,
`%LOCALAPPDATA%\DutyBoard` — alone.

- **Set up my own DutyBoard** opens the deploy link in your browser; once it is deployed and you have
  signed up in its console, you give the app that console's address.
- **Join a DutyBoard** asks for its address: the console's, the one you open in your browser, or the
  API address from the console's Machines page.
- Either way it asks which folder this machine keeps its projects in — each board's repository is
  cloned there — then shows the code to approve in the console. Once you have, this machine starts
  working. The app stays in the system tray; closing its window does not stop it, and Quit does.
- The projects folder can be changed afterwards, from the app. Nothing is moved: boards are cloned
  again in the new folder as they are next worked.
- **Start when I sign in** starts it in the tray by itself. It is offered when you connect, and can be
  turned on or off from the app. Turning it on retires what a command-line install had set to start
  `dutyboard`, so the machine is started by one of them, not both.
- On a machine that already runs `dutyboard` from a command-line install, the app says so and offers
  to run it instead.
- When the app carries a later version than your DutyBoard, it says so and links to the upgrade, which
  whoever deployed it runs in their browser.

**It keeps itself up to date.** A few times a day it looks for a newer release, downloads it, and
checks it twice: its SHA-256 against the release's, and its signature against its own — an update is
installed only if it is signed by whoever signed the app that is running. It installs it when no
agent is working, since installing restarts the app, or at once when you say so.

The app is `dutyboard` too: given any argument — `--stop`, `--version` — it is the command line.
[DutyBoard-Desktop.exe](https://github.com/altlimit/dutyboard/releases/latest/download/DutyBoard-Desktop.exe)
is the app by itself, for running without installing; it updates itself the same way, in place.
macOS and Linux use the command above.

A home other than the default (`$DUTYBOARD_HOME`) keeps its secrets under a name of its own in the
keyring, so two homes on one account do not share a machine key.

### Deploying and upgrading

DutyBoard is deployed from its manifest — [altengine's "Deploy to altengine"](https://www.altengine.net/docs/deploy-to-altengine/).
Each release publishes one at `https://www.dutyboard.com/deploy/v<version>/altengine.json`, beside the
function and the console it deploys, and the newest at `/deploy/latest/`
([`scripts/build-deploy.mjs`](scripts/build-deploy.mjs) builds it). The deploy link points at
`latest`:

```
https://console.altengine.net/deploy?manifest=https%3A%2F%2Fwww.dutyboard.com%2Fdeploy%2Flatest%2Faltengine.json
```

`dutyboard --provision-only` prints it, and opens it where there is a browser. It makes, or upgrades:

- the instances — `<app>` (datastore, functions), `<app>-auth`, `<app>-live`, `<app>-files`,
  `<app>-search`, `<app>-tasks`, and the static site `<app>-console` — where `<app>` is the name
  chosen on the deploy page, `dutyboard` unless you change it;
- their config, the indexes and the access rules;
- the function, with its grants, its schedule, and its instance names as env;
- the `webhooks` queue token webhooks are delivered from;
- **the console**, whose own address is added to the function's CORS list and the auth instance's
  allowed origins, and given to the function, so a machine pairing says where to approve it. The
  console reads where it points from the `/altengine.json` altengine writes beside it.

**Upgrading has two halves.** The board and the console change when someone opens the link again —
or uses *Redeploy* on the app in the altengine console — which reads `latest` and deploys whatever
changed. The page says what will change before anything does. `/health` reports the version
deployed, and the console's **Machines** page and every `dutyboard` say when a newer one is out, with
the link. Machines update themselves with `alt update altlimit/dutyboard && dutyboard --service`
(the desktop app updates itself). A release that changes only the runner needs the second; one that
changes the board, the API or the console needs the first too.

**Whether they agree** is on the console's **Machines** page, under *Versions*: this console's own
build, what the board function reports, and what each machine is running right now — a machine
reports its version on every call, not the one it happened to pair with. They are released together
and updated separately, and when one lags the symptom is a feature that is simply missing rather
than broken, which is slow to work out any other way.

**A DutyBoard made before the link** — by `dutyboard --provision-only` with an API key, under the
same instance names — is upgraded by the same link: deploy it under its existing name, and altengine
offers to adopt the instances it finds, keeping their data. From then on it upgrades like any other.

**On sign-up, decide before you finish.** A new deployment opens sign-up, which is what you want
for exactly as long as it takes to create your own account — after that it is an open door onto
your quota. Turn it off in the auth instance's settings once you have signed up; upgrades leave it as
you set it. Allowed origins are not a substitute: CORS binds browsers, and nothing else.

The console addresses its auth instance by ID: sign-in carries no API key, so the platform has no
organization in which to resolve a name. The datastore and channel stay names, because those calls
carry an identity token.

### Letting an agent install it

[dutyboard.com/llms.txt](https://www.dutyboard.com/llms.txt) is the same setup written for an
agent: which key to ask for, the one command to run, and what to hand back. An agent that cannot
run commands is told to give its user the command rather than rebuild the setup by hand with
altengine's MCP tools — the console is a built app, and there is no by-hand route that ends with
one.

### Serving the console yourself

`app/dist` is the whole console. Serve it from anywhere and put a `config.js` next to its
`index.html` setting `window.DUTYBOARD_CONFIG` — the fields are in
[`app/src/config.js`](app/src/config.js) — or an `altengine.json` like the one altengine generates
([`app/src/runtime.js`](app/src/runtime.js) reads it). Add the origin you serve it from to the auth
instance's allowed origins and the function's CORS list. So that machines pairing can say where to
go, give the function its address in the `DUTYBOARD_CONSOLE_URL` env value.

A console with no `config.js` values can be pointed at a deployment from its sign-in screen
(**Connect your altengine**), which keeps the values in that browser.

The function reads which instances are its own from env — `DUTYBOARD_DATASTORE`, `DUTYBOARD_AUTH`,
`DUTYBOARD_CHANNEL`, `DUTYBOARD_BLOB`, `DUTYBOARD_SEARCH` and `DUTYBOARD_TASKS` — which the manifest
sets to the names the deploy chose, so a deployment named anything other than `dutyboard` needs
nothing set by hand.

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
| `npm run provision` | Everything below, in order, from nothing, against the emulator. |
| `altengine dev` | The emulator: every data plane plus an admin console, on :9191. |
| `npm run setup` | Bundles the function and provisions the emulator from this checkout. |
| `npm run deploy` | Builds the deploy folder, `dist/deploy/`: the manifest, the function and the console. To try it on hosted altengine before a release, serve that folder at any https address and open the deploy link with its `altengine.json`. |
| `npm run dev` | The console, on :5173. |
| `npm run dev:site` | The marketing site, watched, on :8888. |
| `npm run build` | The function, the console and the site. `build:fn`, `build:app` and `build:site` do one each. |
| `npm run deploy:site` | Uploads `site/public` to the static instance behind www.dutyboard.com and makes it live. |
| `npm run demo` | Fills a board with a plausible afternoon's work, and prints the sign-in. |
| `npm run smoke` | The whole state machine end to end, plus a cross-tenant matrix over every endpoint. |
| `node cli/desktop/build.mjs` | The desktop app, `cli/desktop/dist/DutyBoard-Desktop.exe`: cross-compiled for Windows from any machine. Needs Go 1.26. Its installer is built at a release, from [`installer.nsi`](cli/desktop/build/windows/installer.nsi). |
| `npm run smoke:runner` | A real `dutyboard` daemon working a board on the emulator, with a stand-in agent (as Claude Code, Codex and Cursor). |
| `node scripts/webpush-check.mjs` | Web Push encryption and signing, checked against an independent receiver. Runs in CI. |

Provisioning the emulator is HTTP to its admin API, which is why it lives in
[`cli/internal/provision`](cli/internal/provision); it declares what the manifest does, under the
same names. `npm run setup` runs it with `go run`, so a checkout needs Go 1.25 as well as Node. `npm run setup`
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
| Mint or revoke tokens, and set their webhooks | ✓ | |
| Edit the board's profile, runner settings and rules | ✓ | |
| Put their own machines on the board | ✓ | if the owner allows it |

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

## Linking boards

In **Board B → Settings → Board access**, add **Board A** and select a level. This grants **A → B**. It grants no access from B to A; configure that separately in A's settings.

| Level | What A's agents can do on B |
| --- | --- |
| READ | Read duties and notes across all lanes, threads, files, profiles, rules and schedules. |
| WRITE | Everything in READ, plus file independent work duties and attach input files to duties filed by A. |
| FULL | Existing agent actions, including claiming and updating duties, finishing work, and proposing profiles or rules under the usual claim requirements. |

B's owner configures the grant and must have personal access to A. Every cross-board call checks the grant and that access again: removal or loss of the owner's source-board membership stops further requests. Members can see the configuration but cannot grant access. Links do not add people as members, expose machine credentials, or permit human-only actions such as approvals, accepting rules, or managing access. A → B and B → C do not imply A → C. There are at most 50 incoming and 50 outgoing grants per board.

Agents discover available targets with **`board_links`**, then use **`board_call`**. For example, from A:

```json
{"project_id":"board-b","operation":"board_rules"}
```

```json
{"project_id":"board-b","operation":"duty_enqueue","arguments":{"title":"Add an export","brief":"Export account totals as CSV and verify the column headings.","external_ref":"account-export"}}
```

`arguments` takes the operation's normal fields. The gateway keeps every duty, schedule and attachment reference on the receiving board. It uses a distinct agent identity there, while retaining the source board and active source duty on newly filed work. Original tools continue to address A; the daemon does not switch its local workspace to B. A note-review session may read linked boards, but cannot use a link to start unapproved work elsewhere.

REST equivalents are `/board/links` and `/board/call`. The owner's configuration endpoints are `/board/access/set` (`project_id` is B, `source_project_id` is A, `level` is `read`, `write` or `full`), `/board/access/remove`, and `/board/access/list`. `/duty/list` reads a paginated lane or all lanes without claiming work. Deleting either board removes its grants.

## Running agents on your machine

`dutyboard` is also the runner. On the computer that should do the work:

```bash
dutyboard --root D:\dutyboard      # or any folder; ~/dutyboard by default
```

The first time, it pairs this machine with your DutyBoard: it prints a code, you approve it in the
console, and the machine gets its own key. It offers to start itself — when you log in, or at boot
on a server — and runs in the background from then on. Which boards it works you choose in the console — **Work it on …** on
a board's settings, or on the Machines page. Run in a repository, it also offers the boards that
name that repository, or to create one.

### Getting a machine ready

Each machine enables combinations of agent, model and effort under **Machines → Available agents
and models**. Models and effort levels come from its installed CLI, refreshed at startup, every
half hour, or with **Refresh models**. Boards use each machine's saved order by default, with an optional board priority override.
The Machines page also keeps a checklist for each
machine, which the machine itself reports: every agent and whether it is signed in, the GitHub CLI
(for boards that open pull requests or watch CI, and for making a board's repository), a commit
author, a deploy key, and the secrets its boards' MCP servers need. What a board on it is waiting on
comes first. Missing or signed-out alternatives remain visible as optional setup when another
allowed agent can work the board. If no agent is ready, the checklist asks you to install or sign
in to one, not all three. An explicit board override still needs at least one of its enabled
choices. The board overview shows **Runner needs attention** only when none of its online
runners can work it; a working alternative keeps the board ready. It is checked at start,
every half hour, and when you press **Check again**.

From that checklist the machine's owner can have it:

- **Install** an agent or the GitHub CLI, as the machine's user, with no admin: Claude Code and Cursor
  with their own installers (into `~/.local/bin`), the GitHub CLI from its release archive checked
  against the release's checksums, and Codex from npm into the tools folder (so Codex needs Node).
  The folder is added to the PATH of the running `dutyboard` and every session it starts, and kept for
  the next start — a service's PATH is the one it was installed with.
- **Sign in** to one. The machine runs the tool's own sign-in and the console shows what it printed:
  a link to open and, for the GitHub CLI and Codex, a code to enter there. Claude's sign-in page gives
  you a code to paste back, and the console passes it to the command waiting for it on the machine;
  it is cleared from the board as soon as the machine has it. You sign in on the tool's own site, and
  the tool keeps its credentials on the machine — none of them passes through DutyBoard. The GitHub
  CLI is also set up as git's credential helper (`gh auth setup-git`), so https clones of private
  repositories work.

Only the machine's owner can ask either, since both run software as them on their computer; a board's
owner can't, even for a machine on their board. A machine set to wait for someone there (*Setups
asked for here* → *Wait for someone at the machine*) holds these too, until someone runs `dutyboard`
on it and accepts.

A **deploy key** is connected from the console the same way a sign-in is (*Connect altengine*), or
typed on the machine (`dutyboard --deploy-key`). **MCP secrets** can be typed in the console too,
under *Set them here* on the checklist — encrypted in your browser for that one machine, so the board
that carries them cannot read them (see *MCP servers for a board's sessions*) — or on the machine
(`dutyboard --mcp-secrets`). The checklist says which are missing.

A board worked by a machine names its **repository URL**, and the machine keeps its own clone of it
at `<root>/<board>/`. It never works in, or adds branches to, a checkout you use. Point a board at
another repository and machines clone that one; duties under way finish where they started. Files
the project needs that git does not carry (an `.env`) go in `<root>/<board>/local/`, and the setup
duty tells you which. Tools a setup duty installs — an engine, an SDK, a browser — go in
`<root>/_tools/` and are registered, so every later session on the machine finds them on its PATH
and nothing is downloaded twice.

A board can also **start from nothing**: choose *A new project* as what it works on when you make
it (or *Create the repository* on its settings, while it has no repository). One of your machines makes the repository with its GitHub
CLI (`gh auth login` on it first — DutyBoard holds no GitHub credential), pushes a first commit, and
works the board. Its setup duty sees a repository with nothing in it but a README, and builds the
project's first version from the board's description and stack before setting the machine up. An
empty repository you point a board at gets the same first commit.

A board can also have **no repository at all**, for one-off tasks — *make this PDF print in black
and white*, *resize these photos*. Choose *One-off tasks — files in, files out* when you make it.
Attach what a task needs to its duty; the machine works it in a folder of its own, with the
attached files in `in/`, and everything the agent leaves in `out/` is put back on the duty when it
completes, ready to download. There is no setup or rules duty, nothing is committed, and the folder
is removed once the duty is done. A tool a task needs is installed and registered once, for every
later task on that machine.

A board can also **run an account** — a shop, a mailbox, anything with an MCP server — with no
repository either. Choose *An account run through its MCP servers* and add the account's server
(it needs at least one). Its duties are done in the account: the agent works through the server's
tools, checks the result there, and completes with an outcome that says what changed — no files
required. It attaches a file only when you need to download one or look at one to answer a question.
Each duty still gets a scratch folder that goes when it is done, and the board keeps
`<root>/<board>/local/` on each machine between duties, for the sources of what it publishes and
notes on where things stand. A machine missing one of the board's MCP secrets takes none of its
duties until `dutyboard --mcp-secrets` sets them.

Git runs as the machine's user, with its keys and credentials. A board can set the **commit author**
and an **SSH command** (another key or account) — written into the machine's clone of that board,
never your global config. A board that opens **pull requests** needs the GitHub CLI signed in on the
machine (`gh auth login`); without it, the machine says so on the board and takes none of its duties.

The loop is the program's, not the agent's. For each duty it:

1. **claims** it — within seconds of it being filed, from the board's live channel;
2. **prepares a git worktree** for it at `~/.dutyboard/worktrees/<board>/<duty>` on branch
   `duty/<id>`, so your own checkout is never touched and several duties can run at once;
3. **starts the board's agent** (Claude Code, Codex or Cursor) there with that one duty, the board's rules
   and the project's profile, and a local MCP server that only lets the session change its own duty;
4. **checks the board** when the session ends: done means the work was integrated — rebased,
   tested and pushed (as it is, or squashed), or opened as a pull request — and the worktree is
   removed. Parked on a
   question means the worktree waits, and your answer resumes the same conversation in the same
   folder. Stopped early means it is retried, and after three tries it is put to you with the
   session log attached.

After a duty lands, a board that deploys through CI has its run watched (with the GitHub CLI): a
failing deploy becomes an immediate duty to fix it, with the failing log in its brief. A board that
deploys to altengine lists what it may deploy to, each as a **static site** or a **functions** instance,
and gives sessions `altengine_deploy_static` and `altengine_deploy_function` — only the ones those
kinds need — which deploy only to those targets, as that kind, with the machine's **deploy key**.
(Plain instance names from boards saved before targets had a kind still allow either.) The easiest way
to give a machine that key is **Connect**, under the board's settings or on the machine's line on the
Machines page: the machine signs in with altengine for exactly the targets its boards deploy to —
write on each site, full on each functions instance — and keeps the key itself. The consent link
shows in the console; opened on another computer than the machine, you paste back the address the
page ended on, which is useless without what the machine kept. Connect again after adding a target.
Or set it by hand with `dutyboard --deploy-key`, giving that key the same access and nothing more,
since agents run as you and could read it. A function deployed with grants on other instances needs a
key that holds those too, which Connect does not ask for: set that key by hand. A machine
holds no key that manages your DutyBoard itself: that is deployed from the link, by a person. One an
older `dutyboard` kept to provision with is offered for removal when you set a deploy key, and
`dutyboard --sign-out` revokes it. The runner
checks the deploy key against every board's instances as it starts, and says on the Machines page
what the key is missing before any duty gets as far as deploying.

A linked board starts with a **setup** duty, which gets this machine ready for the project and
records the toolchain it installed, and a **rules** duty, which drafts the project's rules for you to
accept. A setup holds the board from the moment the machine is linked: what it records — the
toolchain, the test command, how a worktree is prepared — is what every other duty lands against. So
duties in progress are **blocked** behind it (each keeps the machine and worktree it had, with a note
saying why), nothing else is claimed while it is unfinished, and when it is done — or fails, or is
deleted — they go back to the front of the queue. How many duties run at once is set per board
(`runner.parallel`) and per machine (`max_sessions`).

### A machine with no screen

A server, a VM, a box you only reach over SSH: pairing and installing need no terminal.

```bash
alt install altlimit/dutyboard
dutyboard --server https://<slug>-fn.altengine.app/board --name build-1 --root ~/dutyboard --service
```

It prints the pairing code and a link, waits for you to approve it in your console, sets itself to
start by itself, starts, and exits. On Linux that is a systemd user service when your user lingers
(or lingering can be turned on without an admin), so it starts at boot and survives logging out.
Otherwise — a standard user on a server, a container, WSL without systemd — it uses your own
crontab: a line every five minutes that starts `dutyboard` when it is not already running, which
covers boot and a crash and needs no login or admin. If an admin later runs
`sudo loginctl enable-linger <user>`, `dutyboard --service` again switches to systemd. Run without
`--service`, and with nobody at the terminal, `dutyboard` simply runs — for a supervisor of your own.

**Updating** is the same command again: `alt update altlimit/dutyboard && dutyboard --service`. It
stops the `dutyboard` already running — which is still the old binary — and starts the new one; the
duties it held are resumed. `dutyboard --stop` only stops it (the crontab line starts it again within
five minutes).

A machine that reports a problem on a board — it could not clone the repository, its agent is not
signed in, its deploy key cannot deploy — says how to fix it on the Machines page and in the board's
settings, and **Retry now** there has it check again at once instead of at its next scheduled check.

Headless is enough for most projects: Godot has `--headless` for exports and tests, Playwright runs a
headless browser, and anything that must render a window can run under `xvfb-run`.

### Several repositories on one board

A project spread over repositories — an app, its CLI, its site — can be one board. Its repository
URL is the **main** one; under **More repositories** in its settings, each other one has a name, a
URL, a branch and a test command. Every machine clones them all, and a setup duty gets the machine
ready for each, recording each one's test command and worktree preparation by name.

A duty starts in its worktree of the main repository, and opens any other with `duty_repo_open`: a
worktree of it beside the main one (`<duty>@<name>`), on the same `duty/<id>` branch, prepared the
way the board says. The session is told every repository, where each is or will be, and which are
open; a setup duty opens them all. `duty_integrate` lands the main repository, then each opened one
in the board's order, each with its own test command, and stops at the first that does not — git
cannot land two repositories at once, so a repository already landed stays landed, and calling it
again once the other is fixed carries on from there. When the order across repositories matters
more than that, split the work into blocker duties. A finished duty's worktrees are all removed.

### How work lands

A board's **git mode** says what `duty_integrate` does with a finished duty's commits:

- **push** — rebase onto the main branch, run the test command, push the commits as they are;
- **squash** — the same, but the duty's commits become one commit titled with the duty's title,
  listing the commits it replaced;
- **pr** — push the duty's branch and open a pull request with the GitHub CLI, for a person to merge.

A repository with no remote leaves the work on the duty's branch.

### Claude Code, Codex or Cursor

Under **Machines → Available agents and models**, add the agent/model/effort combinations a machine
may use, move them up or down into priority order, and save its availability. Disable or enable a
saved combination without removing it or losing its position. New boards use
**machine defaults**: each machine tries its own saved list in order, skipping unavailable or
usage-limited choices. Changing that machine's list updates all boards inheriting it.

Under **Settings → How agents run on it**, choose **Override for this board** to select a board
priority list from enabled combinations. **Use machine default** switches back to inheritance;
save the settings to apply it. The saved override is retained for switching back later. A board
override is still limited to combinations enabled on each machine. Priorities apply within a
machine, not across machines racing to claim work. A new board can preview your machines before
linking them; only linked machines work its duties.

The owner's `/projects/profile` API sets `runner.use_machine_defaults: true` to inherit, or
`false` to use the saved override. Sending `runner.options` without a mode selects a board
override; unrelated partial updates preserve the current mode. Machine availability and its
order come from `agent_options` on `/machines/update`. A machine option with `disabled: true` is
kept in settings but excluded from execution; omit it or set it to false to enable the option.

When adding or editing a duty, or under **Settings → Recurring duties**, choose **Override for this
duty** to select and order enabled model/effort combinations from the linked machines. This takes
precedence over the board's list, so a demanding duty can prefer a smarter model while ordinary
duties keep using the defaults. **Use board defaults** restores inheritance. Each machine still
skips combinations it has not enabled; priorities apply within that machine. Add more choices on
Machines first. Changes to an active duty apply at its next agent session.

The duty and schedule APIs accept `agent_options: [{"agent":"codex","model":"your-model-id","effort":"high"}]`.
Omit the field on updates to keep the saved selection, or send `null` to inherit board defaults.
An override needs 1–30 distinct combinations. A recurring schedule copies its override to each
new duty; editing the schedule changes future occurrences, while existing duties can be edited
individually. Duty overrides require dutyboard 2.30.0 or later; older machines cannot claim them.

Model discovery does not run an inference task: Codex uses its app-server `model/list` protocol,
Claude Code uses its initialization response, and Cursor uses `--list-models`. Efforts are the
levels the CLI advertises; Cursor's model selection carries effort, so its separate effort stays
at default. A failed refresh is shown without deleting saved availability. The catalog describes
choices the CLI knows, not a guarantee of remaining usage or account entitlement.

When a session hits its usage limit, its agent/model cools down across this machine's boards
(changing effort does not reset that quota), and the duty tries the next choice. The runner keeps
the same worktree and uncommitted changes, records the handoff on the duty, and starts a new native
conversation when the combination changes. Limits survive runner restarts. It uses the CLI's reset
time when supplied, or retries after 30 minutes otherwise. When all choices are exhausted, it keeps
the claim and worktree, releases the session slot for other boards, and resumes after a reset.
After fixing sign-in, changing an account, or adding usage on the server, click **Retry now** on the
waiting duty, its detail page, or the machine's board entry. It clears that board's model cooldowns
on the machine, rechecks sign-in, and resumes the held work without waiting for the scheduled reset.
The request is saved for offline machines and applied once, even across a runner restart. If usage
is still exhausted, normal fallback and cooldowns apply again. **Refresh models** and **Check again**
do not clear usage cooldowns. Model cooldowns are shared by boards on the same machine, so retrying
a model also makes it available to other boards using it. Only the board owner or machine owner can
request a quota retry.

Ordinary task failures still follow the existing retry policy; they do not silently switch agents.

Existing single-agent settings and explicit board lists remain overrides until you choose **Use machine default**. Once machine availability is saved,
only its enabled combinations may start; an empty list disables new sessions. Explicit board priority
lists need matching machine availability and dutyboard 2.27.0 or later. An empty board override starts no
work. Machine defaults require dutyboard 2.28.0 or later; a machine with no saved enabled
combinations cannot run an inheriting board. An empty machine list disables new sessions there.
Update the runner and provision the console/function together when adopting this feature.

Each selected agent receives the same duty, rules, instructions, worktree and MCP servers:

- **Claude Code** runs as `claude -p` with the board's permission mode, the tools it may use, and an
  MCP config of exactly the board's servers.
- **Codex** runs as `codex exec --json`, with `approval_policy = "on-request"` and
  `approvals_reviewer = "auto_review"`: eligible approval requests go to Codex's automatic reviewer,
  not a person at the terminal. Its sandbox permits worktree and tools-folder writes with network
  access on. Codex still protects Git metadata even when its directory is listed as writable, so
  Git staging and commits can require automatic review. Use an up-to-date Codex CLI that supports
  automatic review. A board set to
  bypass permissions runs it without the sandbox. Each board-provided MCP server uses
  `default_tools_approval_mode = "approve"` so its tools run unattended. DutyBoard's own access checks and human-only
  approvals still apply. Its MCP servers' secrets reach it through its
  environment, never its command line. It resumes the session it started when a parked duty comes
  back.
- **Cursor** runs as `cursor-agent -p --output-format stream-json`, trusting the worktree and running
  commands and MCP tools unattended (`--force --approve-mcps`); a board set to bypass permissions also turns its sandbox off. Its
  CLI has no flag for MCP config or extra instructions, so the runner writes the board's servers into
  the worktree's `.cursor/mcp.json` for the session — hidden from git and put back afterwards, a
  command server's secrets kept in an `envFile` outside the worktree — and puts the instructions at
  the top of the prompt. A URL server that needs a secret is left out of Cursor sessions, since its
  header would have to be written into the worktree. Cursor also loads the servers in your own
  `~/.cursor/mcp.json`; it has no switch to use only the board's.

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
a credential in the settings is refused. Each machine keeps the secrets' values itself, in its OS
keyring. There are two ways to give them to it:

```bash
dutyboard --mcp-secrets     # on the machine: asks for the secrets its boards need and it lacks
```

Or from the console, on the **Machines** page: the checklist names each secret the machine is
missing, and **Set them here** takes their values. They are encrypted in your browser to a key only
that machine holds — it makes a P-256 key pair, keeps the private half in its keyring and publishes
the public half — and only the ciphertext is sent. DutyBoard carries it to the machine and holds it
until the machine takes it, a few seconds; it cannot read it, and neither can its datastore's
backups or anyone else on the board. The machine stores only values for secrets one of its boards
actually names, and says what it stored by name. Only the machine's owner can send them, and a
machine set to *wait for someone at the machine* holds them until someone there accepts. A machine
older than 2.36.0 publishes no key and is set from its own terminal.

A session is connected to exactly the board's servers and DutyBoard's — nothing else from your own
Claude Code setup (`--strict-mcp-config`) — and may call only the tools the board allows. A server
a machine cannot start, because a secret is not set there or its command is not installed, is left
out of that machine's sessions and named on the Machines page. Editing the list is the owner's, like
every other part of the profile that makes a machine run something.

## A team on a board

A board can be worked by a **team** instead of by one agent per duty: named roles that a duty passes
between, each with a written standard. You file the work; the team decides who does it, and nothing
lands until a reviewer has seen it work.

- **The Duty Officer reads every new duty first.** Nobody assigns a duty to a role by hand. The
  role marked as intake — the Duty Officer, on the shipped teams — runs on the cheapest model: it asks
  you when the brief is unclear, finishes what is trivial and safe itself, and hands everything else
  to the role that should do it.
- **A duty is handed on, not re-filed.** `duty_handoff` passes the *same* duty to another role with a
  note. Its thread, its files and its worktree go with it, so the next role starts from exactly what
  the last one left. Each role is a session of its own — its own conversation, usually its own model.
- **A builder cannot land its own work.** A role whose work is reviewed is not offered
  `duty_integrate` or `duty_complete`, and is refused if it calls them. It commits, and hands the
  duty to a role that reviews. The reviewer verifies the work in the same worktree, then lands it and
  completes the duty — or hands it straight back with its findings. Nothing reaches the main branch
  in between.
- **The machine checks before a reviewer is woken.** When a builder hands work to a reviewer, the
  machine running it refuses the handoff if anything is uncommitted, then runs the board's test
  command on the worktree; if it fails, the handoff is refused with the output and the builder fixes
  it in the same session. When it passes, the reviewer is told which commit passed, so it spends its
  time on what tests cannot tell it rather than running the suite again.
- **Review depth follows risk.** A duty is low, normal or high risk: the Duty Officer says which when
  it routes it, any role can raise it, and a change that touches one of the board's *sensitive paths*
  (`auth/**`, `*.sql`, …) is high whatever anyone said — the machine sees the changed files itself. A
  high-risk duty is reviewed line by line on a more capable model; a low-risk one gets a lighter look
  on a lighter one.
- **A different pair of eyes.** On by default, the reviewer runs on a different model from the one
  that built the work, when the machine has one at the reviewer's level.
- **Sent back, the builder remembers.** A builder whose work comes back picks up its own conversation
  — it reads the findings against what it did, instead of the whole change as a stranger would.
- **Two roles that cannot agree ask you.** After a reviewer has sent the same work back three times
  (a setting), the duty goes to *Needs you* with the latest findings — and so does any duty handed
  from role to role twelve times (a setting) without being finished.
- **A duty has an allowance of agent time.** Ten hours of sessions by default, across every role and
  attempt (the board's *Agent time one duty may use*; 0 is no limit). Past it, the duty waits in
  *Needs you*; answering lets it go on for as long again. A bound on a loop nobody is watching.
- **Plans can wait for you.** Off by default: with *I approve plans before they are built* on, a
  planning role's handoff waits in *Needs you* until you approve it or say what to change.
- **Bigger work is split, and checked as a whole.** A role holding a duty can file pieces of it with
  `duty_enqueue`, naming the role each is for. When the last piece is finished, the board files one
  more duty for the reviewer: check that the pieces, together, deliver what was originally asked. Any
  other new duty goes to the Duty Officer.
- **Recurring work remembers its route.** When the Duty Officer hands on a run of a recurring duty,
  the schedule remembers where it went, and later runs start there — no routing session each time.
  Changing what the schedule asks for forgets the route.
- **The team learns from what is sent back.** The board keeps the latest send-backs. Every ten, or
  when its owner presses *Look back now*, a `retro` duty reads them, finds what repeats, and proposes
  the smallest changes to the charters and the rules that would have prevented it — drafts, like
  anything an agent proposes, that change nothing until the owner accepts them.

**Charters.** Each role has a charter: its standing instructions, given to every session that works
as it, on top of the board's rules. A charter is the discipline's best practice written down once,
so nobody filing a duty has to ask for it. The software team's builders are held to security (input
validation, authorisation on every entry point, injection, secrets, dependencies), performance (no
N+1, bounded reads, indexes), reuse over duplication, unit tests for every behaviour and fixed bug,
end-to-end tests for every changed user-visible flow, and idiomatic, readable code — and QA's charter
checks the work against the same list. Rules are what *this project* requires; a charter is how a
role works on any duty; where they disagree, the rules win.

**The shipped teams.** A new board starts with the one that fits it, unless you untick *Start with
a team*:

| Team | Roles | For |
| --- | --- | --- |
| Software | Duty Officer, Architect, Engineer, Senior Engineer, QA | a project in a repository |
| Marketing and content | Duty Officer, Strategist, Writer, Editor | writing that gets published |
| Business and analysis | Duty Officer, Advisor, Analyst, Reviewer | research, numbers, decisions |
| Operations | Duty Officer, Operator, Reviewer | a board that runs an account through MCP servers |
| Task | Duty Officer, Specialist, Checker | one-off tasks, files in and files out |

In a board's **Settings → Team** its owner can switch teams, edit any role's name, level and
charter, change the handoff settings and sensitive paths, see what was sent back lately, or turn the
team off. **Have an agent draft one for this
board** files a `roster` duty: an agent reads what the board is for and proposes roles and charters
for it. Like the rules, what it proposes is a draft — nothing changes until the owner accepts it.
An existing board has no team until its owner gives it one.

**Levels, not models.** A role names a level — *light* for routing, *standard* for most building,
*senior* for risky work and reviewing, *principal* for design — and each machine works it with the
agent/model/effort combinations it has enabled at that level, in its own order, with the usual
fallback when one runs out of usage. A combination's level is read from its model and effort (a
small model is light; the largest at high effort is principal; between them effort decides), and the
machine's owner can set it on the **Machines** page. A machine with nothing at a level uses the
nearest one above, then below, so a duty never waits for a model that machine does not have. A duty
a person pinned to a model keeps it whatever its role.

**The team's memory.** Every board — with a team or not — keeps one short memory for its agents:
what the next session must know about the project and could not work out from the code, the rules or
the profile. It is in every session's prompt, and every session is told to write there
(`board_memory_write`) before it finishes: a decision and its reason, a command that actually works,
a trap. It is theirs, not yours — the board's description is what you say the project is, and the
rules are what you accept — but its owner can read, edit or clear it under **Settings → Team**. It is
held to 6,000 characters and replaced whole rather than appended to, so it stays curated; a write
based on a stale copy is refused with the current text to merge. The last ten versions are kept, and
the owner can put any of them back.

**What it costs.** Each role's prompt puts what is the same for every duty first — the generic
instructions, the rules, the project, the role's charter — and what changes last: the memory, the
other repositories, and finally the worktree and branch. The shared part is the same from one duty to
the next, so an agent that reuses a prompt prefix it has seen recently does. The Duty Officer, which
mostly reads a duty and passes it on, gets a shorter prompt still (the rules by reference, not in
full) and a worktree made without running the board's prep command; prep runs when someone builds,
and before anything lands.

**Watching it.** **Office**, in the top bar, draws all your boards as one office building: a room per board
with a cubicle per role, and a breakroom they share. A role working a duty sits at its cubicle
typing, with whatever waits for it stacked in its tray; a role with nothing in hand is in the
breakroom, wearing its board's colour. When a role is handed work it walks to its desk, and the duty
crosses the room from one cubicle to the next as it is handed on — live, over one channel for every
board on the page. Point at or focus a cubicle for what it is working on; select it to open the duty.
A board's own **Office** tab is the same building with just its room, beside who is waiting on you,
the latest handoffs and what has just been finished. The **Dashboard**'s **Top roles** ranks roles
across your boards by how their work held up — the share of a builder's duties that passed review
first time and were not reopened, the share of a reviewer's that stayed done — never by how much of
it there was.

A team needs `dutyboard` 2.36.0 or later on the machines working the board; an older one is told to
update rather than given the board. Teams are built for boards worked by machines: an agent
connected by token works as its role too, but hands work on only as far as its own checkout reaches.

## Notes and suggested duties

Open **Notes** from a board to collect ideas, context and files on a separate sticky board. Use **Add note**, then drag cards by their handles to arrange them. Positions are saved for everyone on the board. Arrow keys also move a focused handle (Shift for larger steps). On phones, notes stack vertically without dragging. Notes support uploads, pasted files, edits and discussion without entering the runnable queue.

**Suggest duties** queues one review of notes without a current linked suggestion. Notes already linked to a suggested duty are skipped, including approved, completed or rejected duties. The reviewer reads every note, its files, discussion and prior suggestions, then considers them together. Several notes can support one duty. Every proposal goes to **Needs you**, links to its source notes, and waits for **Approve duty** or **Approve with answer**. **Reject suggestion** keeps it out of the queue. The server enforces this gate even if the reviewer uses ordinary enqueue.

Open any note to see its suggestion history and duty statuses. **Clear link**, on a sticky card or inside the note, makes just that note eligible again without deleting duties or historical source links. Finish or cancel the running review before clearing links. A finished review does not block the next **Suggest duties** request: it snapshots all currently unlinked notes, including newly added notes and notes that produced no proposals. Deleting a suggested duty also removes it from eligibility tracking. The Notes page shows only a running review and hides suggestion controls when empty. Agents still read prior suggestions to avoid duplicating work.

**Agents leave notes too.** Something an agent notices that is not the duty in hand and need not
happen now — a missing test elsewhere, an outdated dependency, a reviewer's finding that should not
hold the work up — goes on the Notes with `note_add`, not into the queue as work nobody asked for. A
note runs nothing: it costs nothing until you press **Suggest duties** and approve what is worth doing.
Each says which role left it and links to the duty it came from. An agent can leave one only while
holding a duty on the board, at most five per duty, and a note review cannot add any. Reviewers on the
shipped teams are told to pass work that only has non-blocking findings and leave those as notes,
rather than send it back over them.

Signed-in board members use `/note/create`, `/note/list`, `/note/move` (`note_id`, `x`, `y`), `/note/process` (`project_id`) and `/note/clear` (`note_id`). Clearing a note resets only its suggestion eligibility. The legacy project-only clear resets a finished review pointer without clearing any note links. `note_id` remains accepted by process to identify the board. Agents read notes through `note_list` and, during a held review, use `duty_suggest` with `source_note_ids` naming 1–50 supporting notes per proposal. All must belong to the review. One source can be inferred for single-note reviews. The review itself can include up to the board limit of 500 notes. `note_list` and `duty_get` expose `has_suggestions` for notes (current eligibility links); `duty_get.suggestions` remains the complete history. Proposals expose `source_note_ids` where applicable; `source_note_id` remains as a legacy alias for the first source.

`duty_get` on a note includes paginated `suggestions` and `suggestions_cursor`; follow every page to include all sources and earlier reviews. A human approves with `/duty/resolve`, `approve: true` and `resolution_text`. Notes retain internal status/kind `note` for compatibility, but have no lane in the console. Their review is a separate `note_review` duty. Owner-only deletion removes a note's files and tracking links; existing proposed duties retain their source IDs. The runner instructions and MCP schemas explain combined reviews and approval boundaries.

## Work that comes round again

Some work is never finished, only due again: a post every Monday, a check of something that drifts
every month. A board's **Settings** page has them under **Recurring duties** — a title, a brief, and
a repeat (every weekday, every week on a day, every month on a date, or a cron expression) in your
own timezone. An agent can set one up too, while it is holding a duty, with `duty_schedule_create`.

When one comes round a fresh duty is filed, carrying how the last one went, so a recurring writing
duty does not write the same thing twice. A run that comes round while its last duty is still open
files nothing and leaves a note on the open one — a stuck duty cannot become a pile of twelve. Ten
schedules to a board, and two runs at least fifteen minutes apart. A duty a schedule filed says so
on its own page, and the schedule lists what it has filed, a page at a time.

A schedule that keeps skipping does not do it quietly: after three runs in a row, the duty it is
stuck behind is put to a person as a question — so it arrives in **Needs you** and notifies, like
any other — unless something is actively working it. And a schedule the board turns off itself,
because its repeat can no longer be read, records why and says so on the settings page.

Two things watch the clock, and either is enough: the function has a cron of its own, set when the
deployment is provisioned, and a machine's poll ticks the same code — so a deployment made before
this existed keeps working, and gains the cron the next time you provision. Both can fire at once
without filing anything twice: the duty carries the occurrence that filed it under a unique index,
so one occurrence files one duty.

An agent holding a duty can also change a schedule — its title, brief, repeat or priority — with
`duty_schedule_update`, so "rewrite the weekly post's brief so it stops repeating itself" is a duty
like any other.

**A schedule can check before it wakes anyone.** Give it a *check* — a shell command — and the
machine that picks up each run executes it in the board's folder before any agent starts. Exit 0
and print nothing, and there is nothing to do: no session, no tokens, and the run leaves no duty
behind (the schedule counts it as a quiet run). Print anything, or exit non-zero, and an agent is
woken with that output in its brief. So "every 15 minutes, look for new orders" costs a script run
until there is an order. `$DUTYBOARD_STATE_DIR` is a folder kept between runs, where a script can
remember what it has already seen; `$DUTYBOARD_BOARD` and `$DUTYBOARD_DUTY_ID` say what it is for.
A check has ten minutes. A run a person has written a note on is worked even if its check is quiet.

**Old runs can remove themselves.** A schedule (or any one duty) can say what happens once it is
done: kept, or removed a day, three days, a week, two weeks, a month or three months later — with
its thread and files, as if a person had deleted it. The function's clock does the removing. The
time counts from when the duty was done; a duty sent back out of done stops counting, and a failed
one is never removed this way. The next run still hears how the last one went: that is kept on the
schedule, not on the duty.

The timezone is the interesting part. A cron expression is written in local time, and the board's
function cannot convert a zone to an offset at all — the emulator's JavaScript runtime has no
timezone support, and a schedule that behaves differently there than hosted is worse than no
emulator. So the board stores the offset as a number, and the two things that *do* carry a timezone
database keep it honest: every machine working the board (Go's tzdata, checked hourly and whenever
a schedule changes) and the console while it is open. That is what keeps 9am at 9am through a clock
change. A board nobody has opened and no machine has polled since the clocks moved runs an hour out
once, and is put right on the next check.

## Notifications

When a duty lands in **Needs you**, everyone on its board is told — except whoever parked it. The
console's **Notifications** page turns it on:

- **In a tab.** Allow notifications once, and any open console tab — in the background, on any page —
  shows one, from the person's own live channel (`user.<uid>`).
- **Push.** Turned on per device, it arrives with no tab open, and on a phone: the console's service
  worker holds a Web Push subscription, and the function sends to it. On an iPhone or iPad that works
  only after **Add to Home Screen**, opened from there.

The function signs pushes with a VAPID key it makes on first use and keeps in the deployment's
datastore (`settings/webpush`), and encrypts each one to its device (RFC 8291), with no library —
[`scripts/webpush-check.mjs`](scripts/webpush-check.mjs) checks both against an independent
receiver. The provisioner allows the function to reach the browsers' push services
(`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
`*.notify.windows.com`) and nothing else. A device's subscription is its person's alone, and one its
push service reports gone is forgotten. The local emulator has no Web Crypto beyond hashing, so push
is hosted-only; notifications in a tab work everywhere.

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
`duty_complete`, `duty_fail`, `duty_thread`, `duty_search`, `duty_attach` and
`duty_attachments` as tools, plus `board_profile` and `board_rules` to read how the project is run. `?agent=alpha` names the worker
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

## Connecting another system

A CI job, a form on your site, your own backend: anything that should be able to put work on a
board and find out how it went, without being an agent. Mint it a token on **Settings → Tokens**
and choose **an integration** as what holds it. That token (scope `submit`) can:

- **file** a duty — `/duty/enqueue`, or `duty_enqueue` over MCP;
- **read** the duties *it* filed — `/duty/get`, `/duty/thread`, `/duty/attachments` — and give them
  input files with `/duty/attach`;
- **list what moved** — `/duty/changes`;
- **cancel** one nobody has started — `/duty/cancel`;
- **see the runners** it can send work to — `/board/runners`.

It cannot claim, finish, search or see anything else on the board, including other duties. What
it files is worked by the board's agents like any other duty, and shows on the board as
*from ci (API)*.

```bash
curl -X POST https://<subdomain>-fn.altengine.app/board/duty/enqueue \
  -H "Authorization: Bearer db_…" -H "content-type: application/json" \
  -d '{"title": "Nightly report", "brief": "What to do and why.",
       "external_ref": "report-2026-11-03", "metadata": {"run": 1182}}'
```

- **`external_ref`** is your own id for the request. Filing the same one again answers the duty
  already filed (`"existing": true`) instead of filing a second, so a retry after a timeout is
  safe. It is per token: two integrations' `build-42` are two duties.
- **`metadata`** is up to 2KB of your own JSON, handed back on every read and webhook.
- **`reserved_for`** sends the duty to one runner: the `agent_prefix` of a machine linked to the
  board, from `/board/runners`. A name no runner has is refused. The owner can also pin a token
  to one runner on the Tokens page, and then everything it files goes there.

**Finding out what happened.** Either poll, or be told.

Polling: `/duty/changes` with `{"since": 0}` lists the duties this token filed, oldest change
first, each with its `status` and, once finished, its `outcome_summary`. Keep the `next_since`
it answers and pass it back next time. `more: true` means there is another page now.

Being told: on the Tokens page, give the token a webhook. Every time a duty it filed changes
status — `queued`, `active`, `needs_decision`, `blocked`, `done`, `failed`, `deleted` — that URL is
sent the event, delivered by altengine tasks as `payload`, beside the task's own record:

```json
{ "task": { "id": "0mw0…", "queue": "webhooks", "name": "duty_01J….1762180000000.done",
            "attempt": 1, "maxAttempts": 10, … },
  "payload": {
    "id": "duty_01J….1762180000000.done", "type": "duty.done", "created_at": 1762180000123,
    "board": "nightly",
    "duty": { "id": "duty_01J…", "title": "Nightly report", "status": "done", "priority": "next",
              "external_ref": "report-2026-11-03", "metadata": {"run": 1182},
              "outcome_summary": "Report built; attached as report.pdf.", "last_question": null,
              "attachment_count": 1, "assigned_agent_id": "laptop/1", "reserved_for": null,
              "created_at": 1762179000000, "updated_at": 1762180000000,
              "url": "https://<console>/#/b/nightly/d/duty_01J…" } } }
```

`payload.id` is the same on every retry of one event; `task.attempt` counts them. It is signed the
way every altengine webhook is: `x-altengine-signature` is `v1=` and the hex HMAC-SHA256 of
`<x-altengine-timestamp>.<raw body>`, keyed with the **tasks instance's webhook secret** — one
for the whole deployment, in the altengine console on `dutyboard-tasks` (or `tasks_reveal_webhook_secret`
over altengine's MCP), where it can also be rotated:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(req, rawBody, secret) {
  const ts = req.headers["x-altengine-timestamp"];
  const want = "v1=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const got = String(req.headers["x-altengine-signature"] || "");
  const fresh = Math.abs(Date.now() - Number(ts)) < 5 * 60 * 1000;
  return fresh && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```

Answer `2xx` once you have it. A `408`, `429`, a `5xx` or no answer in thirty seconds is retried
— ten attempts, backing off from ten seconds to an hour, for up to a day; a `Retry-After` is
honoured — and any other `4xx` or a redirect is not, since the same request would be refused the
same way. Deliveries can arrive out of order and an event can arrive twice: deduplicate on
`payload.id`, and keep the duty's state from the newest `updated_at`. Attachments are not in the
payload; fetch them with `/duty/attachments`, whose links expire. If a receiver was down longer
than a day, `/duty/changes` still has everything.

The URL must be `https` with no credentials in it. Changing or removing a webhook, or revoking its
token, stops new events; ones already queued still go to the URL they were queued for.

## MCP coverage for board features

The HTTP MCP server and `dutyboard mcp` expose the same board operations. The local bridge
adds workspace tools and supplies the assigned agent and source-duty identity. MCP `initialize`
provides operating instructions; daemon sessions get instructions for their one assigned duty,
while interactive connections get the poll/claim loop. The standalone equivalent is
[`agent/OPERATING.md`](agent/OPERATING.md).

| Feature | Agent MCP workflow | Human controls |
| --- | --- | --- |
| Agent/model/effort priority | `board_profile` reads `runner.use_machine_defaults` and `runner.options`; the daemon inherits each machine's order or applies the board override to enabled combinations and handles usage fallback, preserving the duty and workspace. | Machine owner: CLI model refresh, availability and default order. Board owner: inherit or override priority. |
| Usage recovery | Resume from checkpoints and inspect existing work after a handoff. No agent tool resets usage cooldowns. | Board or machine owner: **Retry now** after fixing the server account or usage. |
| Notes and files | `duty_list` with `status: "note"`; `duty_get`, `duty_thread`, `duty_attachments` for contents. While holding a duty, `note_add` leaves a note about something noticed that need not happen now (at most five per duty). | Board members: add notes/files and **Suggest duties**. |
| Suggested duties | While holding `note_review`, `duty_suggest` creates Needs you proposals; `duty_get` on the source follows `suggestions_cursor` and preserves tracking across reviews. | Board members: approve/reject, request suggestions from unlinked notes, or clear one note link to retry. |
| Linked boards | `board_links` discovers grants; `board_call` invokes allowed tools on the target with ordinary nested arguments. | Receiving board owner: grant/revoke READ, WRITE or FULL, with current source-board access. |
| The team | The duty a session claims carries `roster`: its `role` with its charter, the `team` it can hand to, and the last role's `handoff` note. `duty_handoff` passes the duty on; `board_roster` reads the team; `duty_enqueue` takes `role` for a piece split from the held duty; a `roster` duty hands a drafted team in with `board_roster_submit`; a `retro` duty proposes charter and rule changes with `board_roster_submit` and `board_rules_submit`. `duty_handoff` takes `risk` (low, normal, high). A daemon session's `duty_handoff` names exactly who it can go to, a builder is not offered `duty_integrate` or `duty_complete`, and its handoff to a reviewer is refused until its work is committed and the test command passes. | Board owner: choose, edit, accept or turn off the team; approve plans; set the handoff limit, sensitive paths and independent review; ask for a retro. Nobody assigns a role. |
| The team's memory | `board_memory` reads it (it also comes with a claim); `board_memory_write` replaces it, with the version read. | Board owner: read, edit or clear it, or put back one of its last ten versions. Members read it. |

`duty_list` returns `duties` and `cursor`; pass the cursor until null. `duty_get` on a note
returns `duty`, `suggestions` and `suggestions_cursor`; pass `suggestions_cursor` until null.
Human-only controls are deliberately absent from agent tools, including through FULL links.
Submit-only integration tokens retain their narrower filing/tracking tools and cannot review
notes, browse all lanes, or use board links. Review sessions are not offered implementation,
deployment or schedule-mutation tools, and the bridge refuses those calls even by name.

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
| `/duty/enqueue` | both | New work. `immediate_blocker` interrupts what the caller holds. `external_ref` makes a retry answer the duty already filed; `metadata` is the caller's own; `reserved_for` sends it to one runner. |
| `/duty/get` | both | One duty or note; notes include paginated linked suggestions with `suggestions_cursor`. |
| `/duty/list` | both | Browse lanes without claiming; `status`, `limit` and `cursor`. Not available to submit tokens. |
| `/duty/suggest` | agent | During a held review, file an approval-required suggestion linked to its supporting `source_note_ids`. |
| `/note/list` | both | Read notes, positions and the current board review; follow `cursor`. |
| `/note/create` · `/note/move` | human | Add a note or save its card position on the Notes board. |
| `/note/process` · `/note/clear` | human | Review unlinked notes on `project_id`, or clear one `note_id` eligibility link while preserving duties and source history. |
| `/duty/changes` | token | The duties this token filed that changed since `since`, oldest first, with `next_since` to pass back. |
| `/duty/cancel` | both | Call a duty off: `→ failed`, with the reason. A person may cancel any unfinished duty on their board, and the machine holding it stops the session and removes its worktree or folder. A token may cancel only what it filed, while nobody is working on it. |
| `/duty/checkpoint` | both | Post to the thread; optionally park the duty. |
| `/duty/complete` | agent | `active` → `done`. Requires an outcome summary. Refused once, with the notes, when a person wrote on the duty since the session was shown its notes. |
| `/duty/fail` | agent | `→ failed`, with a reason. Refused for unread notes like complete. |
| `/duty/quiet` | machine | A scheduled duty whose check found nothing to do: removed, and counted on its schedule. |
| `/duty/thread` | both | The decision log for one duty. |
| `/duty/search` | both | Finished duties matching a query, with their outcome summaries. |
| `/duty/attach` | both | Reserve a file on a duty; answers with a URL to PUT the bytes to. |
| `/duty/attachments` | both | The files on a duty, each with a short-lived signed URL. |
| `/duty/attachment/delete` | both | Remove a file, and the object behind it. |
| `/duty/resolve` | human | Answer a question; re-queue at the front. |
| `/duty/reopen` | human | `done`/`failed` → `queued`, with a required note saying why. |
| `/duty/update` · `/duty/delete` | human | Edit a duty; remove one (owner only). |
| `/board/links` · `/board/call` | agent | Discover outgoing grants; invoke an allowed operation with target `project_id` and nested `arguments`. |
| `/board/access/list` | human | Read incoming and outgoing grants on an accessible board. |
| `/board/access/set` · `/board/access/remove` | owner | Grant or revoke source-board access to the receiving board. |
| `/board/open` | human | The board, its agents and a channel token — one call, for the console. |
| `/board/reindex` | human | Index work finished before search was turned on. Resumable. |
| `/board/runners` | both | The machines working the board. A token sees each one's `agent_prefix`, name and whether it is online — what it needs for `reserved_for`. |
| `/projects/runners` | human | `/board/runners` for many boards at once, keyed by board — what the boards page uses to say which have a machine on them. |
| `/projects/upcoming` | human | The next runs of every enabled schedule across many boards — the soonest twelve, the total, and each board's next — for the boards page's "Up next". |
| `/board/members/list` | human | The owner and everyone else on a board. |
| `/board/members/add` · `/board/members/remove` | owner | Share a board by email, or stop sharing it. |
| `/board/members/agents` | owner | Let a member link their own machines to the board, or stop them. |
| `/board/profile` · `/board/rules` | both | What the project is and how it is run; the rules in force (people also see a pending draft). |
| `/board/profile/propose` | agent | While holding a `setup` duty: record the toolchain, test command, deploy method and worktree prep — and each other repository's, under `repos`. |
| `/board/rules/submit` | agent | While holding a `rules` duty: hand in proposed rules, as a draft. |
| `/board/rules/set` · `/board/rules/accept` | owner | Write the rules by hand, or put the draft in force. |
| `/schedules/list` | any | The board's recurring duties, what each repeats and when it next comes round. |
| `/schedules/create` · `/schedules/update` · `/schedules/delete` | human, or an agent holding a duty | Make work recur, change or pause it, stop it. `next_due_at` on an update moves the next run, which is how the console files one now. |
| `/schedules/sync` | any | Tell the board what its schedules' timezones are worth in minutes from UTC, and read back what it believes. |
| `/schedules/history` | any | The duties one schedule has filed, newest first, with how each went. A page at a time (`limit` up to 50, `cursor` for the rest). |
| `/me/access` | human | Repair this person's `boards` claim; says whether their token is behind. |
| `/duty/handoff` | agent | The role holding a duty passes it to another role, with a note: `{ duty_id, to_role, note, risk? }`. Same duty, same thread, same workspace. A machine also says which model did the work, whether the change touched a sensitive path, and the commit its test run passed on. |
| `/duty/usage` | machine | How long a session the machine ran on a duty lasted: `{ duty_id, ms }`. Added up against the board's per-duty allowance of agent time. |
| `/note/add` | agent | Leave a note on the board's Notes from the duty held: `{ title, brief }`. At most five per duty. |
| `/board/roster` · `/board/roster/*` | both · owner · agent | The team in force (people also see a draft and the shipped teams). `set` puts a preset or an edited team in force, changes the handoff settings, or turns it off; `accept` puts a draft in force; `draft` files a roster duty; `retro` files a retro duty; `submit` is either handing its team in. |
| `/board/memory` · `/board/memory/write` · `/board/memory/history` | both · both · human | The team's memory, and replacing it: an agent holding an active duty, with the version it read, or the board's owner. `history` is its last ten earlier versions, for people to read and restore. |
| `/projects/*` | human | `create` (optionally with a `profile` and `runner`, and `roster: "auto"` or a team's id to start with one), `list` (owned and shared), `rename`, `profile` and `delete` (owner only). |
| `/projects/runners` · `/projects/upcoming` · `/projects/rosters` | human | For `{ project_ids }`: each board's machines, what its schedules file next, or its team as cards (no charters). |
| `/live/boards` | human | One subscribe-only token for the board channels of up to 40 boards, for a page that shows them all. |
| `/tokens/*` | owner | `mint` (with a `scope`: `agent`, or `submit` for an integration, and an optional runner to pin it to), `list`, `update` (its name and runner), `revoke`. |
| `/tokens/webhook` · `/tokens/webhook/test` | owner | Set or remove a token's webhook; queue a `ping` to it. |
| `/live/token` · `/live/me` | human | A subscribe-only channel token for one board; or for the person's own channel, where "needs you" events arrive. |
| `/push/*` | human | `key` (the deployment's VAPID public key), `subscribe` and `unsubscribe` a device, `test`. |
| `/connect/start` · `/connect/poll` | anyone | A `dutyboard` daemon pairing: start, then poll until approved for its `dbm_` machine key (handed over once). |
| `/connect/lookup` · `/connect/approve` · `/connect/deny` | human | Approve or refuse a pairing by the code the daemon printed. |
| `/machines/*` | human | `list` your machines (online, boards, what each is doing), `update`, `revoke`, `unlink` and `retry` (the last two also the board's owner). `retry` with `reset_limits: true` persists a one-time usage cooldown reset; name `project_id` to limit it to that board's models. |
| `/machine/*` | machine | `me`, `link` / `unlink` a board, `poll` every linked board at once, `live` (channel token), `state`, `request` (a person asks a machine to set a board up) and `request/report`. |
| `/mcp` | agent | The same tools over JSON-RPC. An integration's token is offered only its own: `duty_enqueue`, `duty_get`, `duty_changes`, `duty_cancel`, `duty_thread`, `duty_attach`, `duty_attachments`. |
| `/health` | anyone | No credential; safe to check a deploy with. |

Errors are `{"error": {code, message, details?, request_id}}` with a real status: `409` for
a claim that lost a race or a second active duty, `403` for a token pointed at the wrong
board, `400` naming the field and the values it accepts.

A `dbm_` machine key reaches only the boards its machine is linked to, and names the one a call
is about in an `x-dutyboard-board` header; with it, every agent endpoint above works exactly as it
does for a project token. Its agent ids are its own prefix and `<prefix>/<n>`. On a board whose
`runner.parallel` is set, a claim beyond that many active duties is a `409`, and a `setup` or
`rules` duty only runs with the board to itself. A machine's setup holds the board from the moment
it is filed: duties in progress are blocked behind it, and every other claim is a `409` until it
finishes.

## The rules the state machine actually enforces

- **On a board with a team, a builder's work is not finished by the builder.** A `duty_complete`
  from an agent holding a duty as a role marked `reviewed` is a `409` naming who to hand it to, and a
  daemon session in that role is refused `duty_integrate` and the deploy tools as well. The only way
  that role's duty ends `done` is through a role that `reviews` — or a person.
- **Nobody filing a duty chooses its role.** A `role` on `/duty/enqueue` is refused from a person, a
  submit token or a linked board; only an agent splitting the duty it holds may name one. Everything
  else starts with the role that reads new duties first, as does a duty a person reopens.
- **A drafted team, like drafted rules, is not in force.** `board_roster_submit` writes a draft;
  only the board's owner accepting it changes who works the board.

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

No sub-boards, and no notifications beyond "a duty needs you" — no email, no digest. Deliberately:
the point is the loop, and each of those is a real feature rather than a corner to cut.
