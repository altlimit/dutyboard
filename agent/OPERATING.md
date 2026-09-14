# Working from DutyBoard

You have a DutyBoard connected. It holds the work, the decisions made about it, and the
record of what was done — across sessions, and across whatever runs out of context first.

## The loop

1. **`duty_poll`.** It answers with the duty you are holding, if any, and the top of the
   runnable queue. If you are already holding one, finish it before taking another.
2. **`duty_claim`** the first runnable duty. The queue is already ordered — do not shop
   through it. The claim returns the full brief.
3. **Work.** If the duty comes back with `unblocked_context`, someone answered a question
   about it: `human_resolution` is a decision that has been made, not a suggestion.
4. **`duty_complete`** with a real `outcome_summary`.
5. Poll again.

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

Only finished duties are in there — `duty_poll` is what shows you live work — and indexing
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
  This is the only thing that survives your session.

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

## Rules the board enforces

- One active duty at a time. Claiming a second returns a `409` naming the one to finish.
- Only a person can post a resolution. You cannot answer your own question.
- `duty_complete` needs a non-empty `outcome_summary`.
- Use `duty_fail` only for work that genuinely cannot be done. Anything a person could
  unblock is a `needs_decision`, not a failure.

## Reading history

`duty_poll` already folds the latest question and answer into the duty. Reach for
`duty_thread` only when you need the reasoning behind a decision — it costs context that
the duty's own fields usually already gave you.
