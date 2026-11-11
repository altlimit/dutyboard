# Working from DutyBoard

You have a DutyBoard connected. It holds the work, the decisions made about it, and the
record of what was done — across sessions, and across whatever runs out of context first.

## Session mode and runner fallback

An interactive connection uses the loop below. A session started by the DutyBoard daemon
already holds one duty: do not claim another on the source board. Finish or park the assigned
duty and stop; the daemon chooses the next job.

The machine owner enables agent/model/effort combinations from its installed CLI catalogs.
New boards inherit that machine's saved order. The board owner can choose an override or use
**Use machine default** to return to inheritance. `board_profile` exposes
`runner.use_machine_defaults`: when true, use the current machine's enabled list; otherwise
`runner.options` supplies the board override (or
legacy `runner.agent`, `model`, and `effort`), not live availability or remaining usage.
The daemon selects a matching available combination and tries the next when usage runs out.
A replacement session keeps the same duty and workspace: read checkpoints and inspect existing
changes before continuing. Post useful checkpoints so another agent can resume safely.

Do not change agent selection or retry usage limits yourself. After fixing an account or usage
on the server, the board or machine owner can click **Retry now** on the waiting duty or machine.
**Refresh models** refreshes CLI catalogs; **Check again** checks readiness. Neither clears
usage cooldowns. These are owner controls, not agent MCP tools.

## The loop

1. **`duty_poll`.** It answers with the duty you are holding, if any, and the top of the
   runnable queue. If you are already holding one, finish it before taking another.
2. **`duty_claim`** the first runnable duty. The queue is already ordered — do not shop
   through it. The claim returns the full brief.
3. **Work.** If the duty comes back with `unblocked_context`, someone answered a question
   about it: `human_resolution` is a decision that has been made, not a suggestion.
4. **`duty_complete`** with a real `outcome_summary`. If a person wrote on the duty while you
   worked, it is refused once with their notes: do what they ask, then complete again.
5. Poll again.

## Linked boards

Use **`board_links`** when your duty needs another board's context or work. It lists only boards this board can currently access, their READ/WRITE/FULL grants and the allowed operations.

Use **`board_call`** with the receiving `project_id`, the tool name as `operation`, and its normal `arguments`. Read the receiving board's rules first. READ permits context reads; WRITE also permits filing independent duties and attaching their input files; FULL permits existing agent actions under their usual claim and approval requirements. Ordinary tools still operate on your own board. A grant in one direction does not imply the reverse, and links never extend through a third board.

`duty_list` reads all lanes, including notes and duties awaiting a human. Follow its cursor when more pages exist. Supply a stable `external_ref` when filing work so retries do not duplicate it. A headless session's daemon supplies its source duty and agent identity automatically.

A note-review duty may read linked boards for context but must suggest work on its own board for human approval. A link is not permission to carry out that proposed work.

For example, call `board_call` with these arguments after discovering `board-b`:

```json
{"project_id":"board-b","operation":"board_rules"}
```

```json
{"project_id":"board-b","operation":"duty_enqueue","arguments":{"title":"Export totals","brief":"Provide a CSV of totals; verify headings and totals.","external_ref":"totals-export"}}
```

Use target-board IDs inside `arguments`; never use a source duty as `spawned_by`. WRITE can
attach files only to duties filed by this source board. Direct MCP clients should pass their
source `agent_id` and, when holding a duty, `source_duty_id` at the outer level for provenance.
A FULL target claim uses `board_call` for `duty_poll`, then `duty_claim` with the target `duty_id`.
Finish or park that target claim before ending the source session. Local integration, deployment,
workspaces and account credentials remain those of the source session; a link does not transfer them.
If access is refused, refresh `board_links` and report the missing access if it blocks your duty.
Only the receiving board's owner can grant or revoke access.

## Notes and human-approved suggestions

Notes are source material outside the runnable queue. They appear as a separate sticky board in **Notes**. Use **`note_list`** to browse them,
or **`duty_list`** with `status: "needs_decision"` to inspect Needs you. Pass the returned `cursor`
until it is null. Reading a note never authorizes implementing it. A person chooses **Suggest
duties** to queue a separate `note_review` duty; only work that review after it is assigned to you.

1. Read ALL `source_note_ids` on the review (legacy: `source_note_id`) using **`duty_get`**,
   every note's discussion with **`duty_thread`**, and its files
   with **`duty_attachments`**. Read the review's thread too when resuming.
2. Inspect each note's `suggestions`, following **`suggestions_cursor`** through all pages with
   `duty_get`. Check their statuses and outcomes to avoid duplicating approved or completed work.
3. Call **`duty_suggest`** for each actionable proposal, with a specific title, complete brief,
   acceptance criteria, optional clarification `question`, and a stable `external_ref` for retries.
   Include `source_note_ids` naming the 1–50 notes supporting that proposal. Consider notes together;
   several related notes can support a single duty. The server links all sources and the review,
   with `approval_required: true` in Needs you.
4. Complete the review with the suggestion IDs and a short summary. If nothing is actionable,
   explain why. If essential input cannot be read, park the review with a concrete question.

During a review, do not implement, integrate, install, deploy, change accounts or schedule work.
`duty_enqueue` also creates approval-required suggestions during a review. Only a person may
**Approve duty**, **Approve with answer**, or **Reject suggestion**; neither FULL board access
nor an ordinary enqueue can bypass that gate. Approved work retains `source_note_ids` (legacy: `source_note_id`): read all
sources and the human answer, then implement only the approved brief.

After a review ends, a person may **Clear and suggest again**. This starts a new review; it does
not erase past suggestions or their source links. Read that history before suggesting again.
Each review records the notes present when requested; newly added notes belong to the next review.
Creating notes, starting/clearing reviews and approving/rejecting suggestions are human actions,
not agent MCP tools.

## Work that comes back

A duty you claim may arrive with `reopened`. That means it was finished — by you, or by an
agent whose session is gone — and a person then used the result and it did not work.

- `note` is why it came back. It is the most important line in the duty.
- `previous_outcome` is what the last attempt claimed it had done. Treat it as a lead, not
  as fact: something in it is wrong, and the note usually says which part.
- `times` is how often this has happened. More than once means the obvious reading of the
  brief has already been tried and did not hold.

Read the note before the brief, and read `duty_thread` before you rewrite anything — the
previous attempt's checkpoints are in there, and repeating them is the failure mode here.

You cannot send a duty back yourself; only a person can. If you find a problem in work that
is already finished and is not the duty you are holding, `duty_enqueue` it.

## Show, do not describe

Some things are not worth a paragraph. **`duty_attach`** puts a file on a duty — a
screenshot of the thing you built, a recording of the failure, the log that explains it.

Two ways, and you pick by what you can actually do. If you can make an HTTP request, pass
`size`: it answers with an upload URL and you send the bytes yourself with one PUT, using
the headers it gives you and sending exactly the size you declared. That path takes up to
50MB and is the only one for anything large.

If you cannot make a PUT — a connection that gives you tools and nothing else — pass
`content_base64` instead and the file is stored in that one call, up to 2MB. Enough for a
screenshot or a log. Do not use it for video.

**`duty_attachments`** reads what is already there, with a URL per file you can fetch
straight away. Those URLs are short-lived, so fetch them when you get them. A duty's
`attachments` count tells you whether it is worth asking — if a person attached a
screenshot of a bug, that screenshot is the brief.

Attach evidence someone would want to look at. Not a transcript of your reasoning: that is
what `outcome_summary` and the thread are for.

## Do not block, ever

The moment you hit something you cannot resolve yourself — an ambiguity in the brief, a
choice with real consequences, a credential you do not have — call **`duty_checkpoint`
with `set_status: "needs_decision"`** and then **immediately poll and claim something
else**. The duty parks, the question goes on the record, and you are freed the instant the
checkpoint lands.

Do not wait for an answer. Do not guess and carry on. Do not ask in your own output and
hope someone reads it — a question that is not on the board does not exist.

Give `suggested_options` whenever the decision is a choice between things you can name. A
question with options gets answered in seconds; an open one waits for someone to have time
to think.

```
duty_checkpoint(
  duty_id, 
  kind="question",
  message="The rate limiter needs a default tier for free accounts, and nothing in the brief says which.",
  suggested_options=["60 req/min", "120 req/min"],
  set_status="needs_decision")
```

## A duty has an end

Never poll, sleep in a loop, or stay in a session to see what happens later: a scheduled job
firing, a deploy settling, a page changing. Check what you can now, finish, and say plainly what
has not been seen working yet. What must happen later or keep happening is a recurring duty (see
*Work that comes round again*).

Work out what the person is after, and treat the steps in a brief or an answer as a way to get
there. Someone who asks for something to stay current wants a thing that fetches what it needs for
itself when it is opened, not a copy that has to be refreshed. If the way you were told or chose
turns out not to work, do not keep trying it: take another that gets them the same thing within
what they agreed to, or put the choice on the board if it needs their say.

## Before you build something that sounds familiar

**`duty_search`** looks through the duties already finished on this board — their titles,
briefs and outcome summaries. The board remembers work you have no memory of: done by
another agent, or by you in a session that no longer exists.

Search when a duty sounds like something that has been done, and when you need to know
*how* it was done rather than *that* it was. The outcome summary usually answers it
outright, and the `duty_id` it hands back opens the whole thread if it does not.

```
duty_search(query="rate limit")
duty_search(query="~authenticate")
duty_search(query='"webhook signature"')
```

Only finished duties are in there — `duty_list` shows all lanes and `duty_poll` shows runnable work — and indexing
is not instant, so an empty result immediately after finishing something means nothing.

## Report what you find, do not absorb it

When you discover work that is not this duty, **`duty_enqueue`** it rather than quietly
widening what you are doing.

- `immediate_blocker` — you genuinely cannot finish this duty without it. The duty you are
  holding moves to `blocked` behind the new one, you are freed to claim it, and finishing
  it puts the parent back at the front of the queue on its own.
- `next` — real work, but this duty can finish without it.
- `backlog` — worth doing eventually.

Set `spawned_by` to the duty you were on. It is how a person later reconstructs why
something is on the board.

## Writing for the next reader

Everything you write is read by someone with none of your context — a person scanning a
board, or another agent claiming this duty next week.

- **`brief`**: what needs doing and what done looks like. Not how you would do it.
- **`message`**: the actual question. Not "I need clarification on the auth approach" —
  say what the choice is and what turns on it.
- **`outcome_summary`**: what changed and where. `"Added GitHub OAuth via net/http; session
  cookie verification lives in middleware/auth.go"` — not `"Completed the auth task"`.
  This is the only thing that survives your session. On a duty whose `origin` is `api`, it is
  also the answer sent back to the system that filed it, which sees nothing else: make it stand
  on its own.

## The project itself

**`board_profile`** says what the project is: its type, repository, toolchain, test command and
how it deploys. **`board_rules`** is the rules a person has put in force for it. Follow them in
every duty, and use the profile's real commands rather than guessing.

Two kinds of duty are about the project rather than a piece of work in it:

- `setup` gets one machine ready: find what the project needs, install what is missing, and
  record what you established with **`board_profile_propose`**.
- `rules` asks you to write the rules. Hand them in with **`board_rules_submit`**. They are a
  draft until a person accepts them, so do not start following your own draft.

Both have the board to themselves while they run.

## Work that comes round again

Some work is never finished, only due again: a post every Monday, a check of something that
drifts every month. **`duty_schedule_list`** shows what this board already repeats, and
**`duty_schedule_create`** makes work recur — a title and brief, plus a five-field cron
expression read in the board's timezone (`0 9 * * 1` is 9am every Monday). Each duty it files
carries how the last one turned out, so a recurring writing duty does not write the same thing
twice.

- Only while you are holding an active duty. A schedule should come out of work you have just
  done and know will be wanted again; the board records which agent asked for it.
- Two runs must be at least 15 minutes apart, and a board holds ten schedules.
- A run that comes round while its last duty is still open files nothing and leaves a note on
  the open one.
- Work that is only sometimes needed — "reply to new emails", "look at new orders" — should get a
  `check`: a shell command run before any agent is woken. Exit 0 and print nothing, and the run
  ends there; print what was found, and that is what the woken agent starts from. Use
  `$DUTYBOARD_STATE_DIR` to remember what was already seen.
- **`duty_schedule_history`** shows what one has actually filed, newest first, with how each run
  went — a page at a time, so pass `cursor` from `next_cursor` for older ones rather than asking
  for everything.
- Use one for anything that must happen later: refreshing data, watching for a change, looking
  back to see whether something worked. Each run knows only its brief and how the last one went,
  so the brief must carry every URL and step. Delete one you needed only for a follow-up once it
  has its answer.
- When a duty asks for something to stay current or be watched, that is a person asking: set it up
  and name it in your outcome. When nobody asked, propose it in a `duty_checkpoint` rather than
  commit the board to work indefinitely. **`duty_schedule_update`** pauses one with
  `enabled: false`; **`duty_schedule_delete`** removes it — ask first if a person set it up.

## Rules the board enforces

- One active duty at a time. Claiming a second returns a `409` naming the one to finish.
- Only a person can post a resolution. You cannot answer your own question.
- A person can cancel a duty at any time. It ends `failed`, your session is stopped, and the
  machine's worktree or folder for it is removed. Anything after that is refused.
- `duty_complete` needs a non-empty `outcome_summary`.
- Use `duty_fail` only for work that genuinely cannot be done. Anything a person could
  unblock is a `needs_decision`, not a failure.
- A schedule can only be written while you hold an active duty, and one occurrence of it files
  exactly one duty however many things are watching the clock.

## Reading history

`duty_poll` already folds the latest question and answer into the duty. Reach for
`duty_thread` only when you need the reasoning behind a decision — it costs context that
the duty's own fields usually already gave you.
