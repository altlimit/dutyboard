// MCP over streamable HTTP, at POST /mcp.
//
// The same handlers the REST routes call, exposed as tools so an agent runtime can add
// DutyBoard as a server and get `duty_poll` / `duty_claim` / … with no shim in between:
//
//   claude mcp add --transport http dutyboard-<board> \
//     "https://<sub>-fn.altengine.app/board/mcp?agent=alpha" \
//     --header "Authorization: Bearer db_…"
//
// Stateless by design: every request carries its own bearer token, so there is no
// session to keep and nothing to resume. GET (the server→client SSE stream) is answered
// 405, which the transport spec allows for a server with nothing to push.
//
// A tool that fails answers `isError: true` with the message as text rather than a
// JSON-RPC error. The model is the one that has to recover — being told "duty is
// needs_decision, not queued" is what lets it, and a protocol-level error would instead
// look to most clients like the server broke.

import { HttpError, badRequest, json, readBoundedText } from "./http.js";
import { listNotes, listDuties, suggestDuty, pollDuties, claimDuty, enqueueDuty, checkpointDuty, completeDuty, failDuty, listThread, getDuty, cancelDuty, listChanges, PRIORITIES, THREAD_KINDS } from "./duties.js";
import { deleteAttachment, attachToDuty, listAttachments, MAX_BYTES, MAX_INLINE_BYTES } from "./attachments.js";
import { searchDuties } from "./searching.js";
import { createSchedule, deleteSchedule, listSchedules, scheduleHistory, updateSchedule } from "./schedules.js";
import { getProfile, proposeProfile, getRules, submitRules, DEPLOY_METHODS } from "./profile.js";
import { VERSION } from "./version.js";

import { BOARD_OPERATIONS, linkedBoards, callWithBoardAccess } from "./board-access.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "dutyboard", title: "DutyBoard", version: VERSION };

/**
 * The operating protocol, handed to the model at `initialize`.
 *
 * This is the one place the whole loop can be stated to an agent with no setup on its
 * side — no file to add, no system prompt to edit. Clients that surface server
 * instructions put it in front of the model automatically. Not all of them do, which is
 * why the same protocol is also a file: agent/OPERATING.md in the repo, served at
 * https://www.dutyboard.com/agent.md for anything that would rather be given a URL.
 *
 * Keep it a PROTOCOL, not a tour. Each tool already describes itself in tools/list; what
 * cannot be said there is when to reach for which, and what never to do — the two things
 * an agent gets wrong in ways nobody notices until a board is full of half-finished work.
 */
const INSTRUCTIONS = `DutyBoard holds your work, the decisions made about it, and the record of what was done — across sessions, and across whatever runs out of context first. Synchronise with it at every boundary. Local execution (edits, tests, commands) is yours to manage alone.

STARTING, AND WHENEVER YOU ARE BETWEEN THINGS
Call duty_poll before doing anything you were not explicitly asked to do. If it reports an active duty, that is yours already — resume it from its brief and its last checkpoint rather than starting over. Otherwise duty_claim the first runnable duty; the queue is ordered, so do not shop through it. If nothing is runnable, say so and stop. A daemon-started session instead follows its assigned-duty instructions: the daemon claims work, and the session stops when its duty completes or parks.

LINKED BOARDS
Use board_links to discover boards this board can access. Use board_call with the receiving project_id, operation and normal tool arguments. Ordinary tools stay on your own board. READ is for context; WRITE also files work for that board; FULL allows the agent actions named in the link, without bypassing human approvals. Read the target rules before filing or changing work. Links are directional and never transitively inherited. Use duty_list to browse any lane, including notes and Needs you, and pass its returned cursor to continue. Use a stable external_ref for cross-board duties. Include source_duty_id when you hold a source duty; the daemon supplies it automatically. A link never switches your workspace or grants another board's MCP credentials. If access is refused, refresh board_links; do not work around the grant.

REVIEWING NOTES
A note_review duty asks for suggestions only. Notes live in a separate board view, not a duty lane. Read ALL source_note_ids on the review, each note's files and thread, and all existing linked suggestions. Consider the notes together: several notes can support one proposal. Pass source_note_ids for the 1–50 supporting notes to duty_suggest or duty_enqueue. Older single-note reviews can use source_note_id. Use note_list to browse all notes, following its cursor. The review records the notes present when requested; later notes belong to the next review. Use duty_suggest with a clear brief and optional question. Each proposal stays in Needs you until a person approves it. Never implement or schedule the proposed work during the review. Complete the review with a summary of what you suggested and the suggestion IDs. Follow suggestions_cursor through every page from duty_get. Notes themselves are not runnable. People trigger reviews with Suggest duties and can Clear and suggest again after a review ends; old suggestions and source links remain. Do not duplicate approved or completed work. Only a person may approve or reject suggestions.

RUNNER SELECTION AND USAGE LIMITS
board_profile returns runner.use_machine_defaults: true means inherit this machine's enabled list and order; otherwise runner.options is the board priority override (or legacy runner.agent/model/effort). The daemon chooses among combinations enabled on this machine and falls back when usage is exhausted, keeping the same duty and workspace. Resume from checkpoints and verify existing changes. Model catalogs come from installed CLIs; do not invent model names or edit runner configuration. Machine availability, board priorities and Refresh models are owner controls. After a server-side account or usage fix, the board or machine owner can use Retry now to clear usage cooldowns; Refresh models and Check again do not do that. Agents cannot reset usage, change access grants, or approve notes through MCP.

WHAT YOU FIND ALONG THE WAY
Do not widen the duty you are on. A discovery that blocks it: duty_enqueue with priority 'immediate_blocker' and spawned_by set to the duty you are holding — yours parks behind it, you claim the new one, and finishing it returns the parent to the front of the queue on its own. A discovery that does not block it: duty_enqueue with 'next' or 'backlog', then carry on with what you were doing.

WHEN YOU DO NOT KNOW
An ambiguity in the brief, a choice with consequences you cannot take back, a credential you do not have: duty_checkpoint with set_status 'needs_decision', the actual question in message, and suggested_options whenever the answer is a choice between things you can name. THEN POLL AND CLAIM SOMETHING ELSE. Do not wait for the answer, do not guess and continue, and do not ask in your own output and hope someone reads it — a question that is not on the board does not exist. You cannot answer your own question; only a person can.

FINISHING
Nothing is done because you believe it is done. Verify it, then duty_complete with an outcome_summary saying what changed and where — "Added GitHub OAuth via net/http; session verification in middleware/auth.go", not "completed the auth task". It is the only thing that survives your session. Then poll again. Use duty_fail only for work that genuinely cannot be done; anything a person could unblock is a needs_decision.

WORK THAT COMES BACK
A duty may arrive carrying 'reopened'. It was finished — by you, or by an agent whose session is gone — and a person then used the result and it did not work. 'note' is why, and it is the most important line in that duty; 'previous_outcome' is what the last attempt claimed, which is a lead rather than a fact. Read the note before the brief and duty_thread before you rewrite anything: repeating what has already been tried is the failure mode here. You cannot send a duty back yourself, only a person can — if you find a problem in finished work that is not the duty you hold, duty_enqueue it.

WRITING FOR THE BOARD
What you write here — messages, questions, outcome summaries, briefs — is read by people in a console that renders it as markdown. Lead with the point in one sentence. When there is more than that to say, follow it with a short bullet list, one fact per bullet; \`code\` for paths, commands, ids and URLs; a table only for rows of like things. No headings in a note, no preamble, and do not restate the brief.

BEFORE STARTING SOMETHING THAT SOUNDS FAMILIAR
duty_search looks through the duties already finished on this board — their titles, briefs and outcome summaries. The board remembers work you have no memory of, done by other agents or by you in a session that is gone. Search before you rebuild something, and when you need to know HOW a thing was done: the outcome summary usually says, and the duty_id it gives you opens the full thread.

SHOWING RATHER THAN DESCRIBING
duty_attach puts a file on a duty — a screenshot of what you built, a recording of the failure, the log that explains it. duty_attachments reads what is there, including what a person attached for you; if a duty has attachments, look at them before asking about it.

THE PROJECT ITSELF
board_profile says what this project is — its type, repository, toolchain, test command, how it deploys — and board_rules gives the rules a person has put in force for it. Follow those rules in every duty. A duty of kind 'setup' is how a machine gets ready for the project: record what you found with board_profile_propose. A duty of kind 'rules' asks you to write the rules: hand them in with board_rules_submit, and a person decides whether they take effect.

WORK THAT COMES ROUND AGAIN
Some work is never finished, only due again — a weekly post, a monthly check of something that drifts. duty_schedule_list shows what this board already repeats; duty_schedule_create makes a duty recur on a cron expression, and each one it files tells the next how the last went. Only while you hold an active duty. It is also the only way to do anything later: never poll, sleep or stay in a session waiting for something to happen or to keep something up to date. When a duty asks for something to stay current or be watched, that is a person asking, so set one up and say so in your outcome; when nobody asked, propose it in a checkpoint rather than commit the board to work indefinitely.`;

/** For a `submit` token — software outside the board, filing work and following it. Not the
 *  protocol above: it works nothing, so nearly all of that would be instructions it cannot follow. */
const SUBMIT_INSTRUCTIONS = `This connection files work on a DutyBoard and follows it; the board's own agents do the work. duty_enqueue files a duty — give it a brief a person or agent with no other context can act on, and an external_ref (your own id for the request) so a retry answers the duty already filed instead of filing it twice. duty_get reads one as it stands now; duty_changes lists those you filed that moved since a time you pass back; a finished duty's outcome_summary says what was done. duty_attach gives a duty its input files. duty_cancel takes back one nobody has started. You see only the duties this connection filed.`;

const s = (description, extra = {}) => ({ type: "string", description, ...extra });

const TOOLS = [
  {
    name: "board_links", title: "Boards this board can access",
    description: "List this board's outgoing grants, with target project_id, READ/WRITE/FULL level and allowed operations. Links are directional and rechecked on every call. They do not grant access through another board's links.",
    inputSchema: { type: "object", properties: {} }, handler: linkedBoards,
  },
  {
    name: "board_call", title: "Use a linked board",
    description: "Call an allowed agent tool on a board returned by board_links. project_id is the receiving board; operation is the tool name; arguments are that tool's normal arguments. READ reads duties, notes, threads, files, rules, profiles and schedules. WRITE also files duties and attaches their input files. FULL allows existing agent actions, still subject to claims and human approval rules. No human-only actions or forwarding through another link. Ordinary tools always stay on your own board. Use a stable external_ref when filing work. WRITE attachments must belong to duties filed by this source board. Pass the receiving board's IDs in arguments; never pass a source-board duty as spawned_by. For FULL, duty_poll then duty_claim on the target establishes a separate claim; finish or park it before ending your source session. Claims do not switch workspaces. If denied, refresh board_links. For example: {project_id: \"board-b\", operation: \"duty_claim\", arguments: {duty_id: \"target-duty\"}}.",
    inputSchema: { type: "object", properties: {
      project_id: s("Receiving board id from board_links."), operation: s("Agent tool to invoke.", { enum: Object.keys(BOARD_OPERATIONS) }),
      arguments: { type: "object", description: "The operation's normal arguments, such as duty_id or title and brief." },
      agent_id: s("Your source-board agent id; the daemon supplies this."),
      source_duty_id: s("The active source-board duty you hold, for provenance."),
    }, required: ["project_id", "operation"] }, handler: callLinkedBoard,
  },
  {
    name: "duty_list", title: "Read duties and notes",
    description: "Read a page of duties or notes without claiming anything or changing agent state. Includes all statuses by default; use status note for notes or needs_decision for Needs you. Returns duties and cursor; pass that cursor for more until it is null. Reading a note or an unapproved suggestion does not authorize working it.",
    inputSchema: { type: "object", properties: {
      status: s("Lane, or any.", { enum: ["any", "note", "queued", "active", "needs_decision", "blocked", "done", "failed"] }),
      limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: s("Cursor from the previous page."),
    } }, handler: listDuties,
  },
  {
    name: "duty_attachment_delete", title: "Remove an attachment",
    description: "Remove a file attached to a duty on this board.",
    inputSchema: { type: "object", properties: { attachment_id: s("Attachment to remove.") }, required: ["attachment_id"] }, handler: deleteAttachment,
  },
  {
    name: "note_list", title: "Read the board's notes",
    description: "Read a page of notes from the separate Notes board, with saved card positions and the latest board-wide review. Follow cursor until null. Notes are context, never runnable work. A review's source_note_ids records the notes included when the human requested it; notes added later belong to the next review.",
    inputSchema: { type: "object", properties: { cursor: s("Cursor returned by the previous page.") } }, handler: listNotes,
  },
  {
    name: "duty_suggest", title: "Suggest a duty from board notes",
    description: "While holding a note_review, create proposed work in Needs you. Read ALL source_note_ids on the review, their files, threads and existing suggestions first. Consider related notes together; one duty can have several source notes. Supply source_note_ids naming the 1–50 notes supporting this proposal, all from the held review. Source links persist after approval, and each note lists its linked proposals. The duty cannot run until a human explicitly approves. Reuse external_ref for retries. Never implement the suggestion during the review.",
    inputSchema: { type: "object", properties: {
      title: s("Short title of the proposed work."), brief: s("What should be done and how to verify it."),
      question: s("Optional clarification or approval question for the person."),
      source_note_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "Notes from this review that support this proposal. Required for reviews containing more than one note; one source is inferred for legacy single-note reviews." },
      priority: s("Priority after approval.", { enum: PRIORITIES }),
      external_ref: s("Stable reference for this suggestion within the review, to avoid duplicates."),
      agent_id: s("The agent holding the review."),
    }, required: ["title", "brief"] }, handler: suggestDuty,
  },
  {
    name: "duty_poll",
    title: "Poll the board",
    description:
      "Your whole view of the board in one call: the duty you are currently holding (if any) and the top of the runnable queue, highest priority first. A duty that was parked for a human decision comes back with unblocked_context carrying the question and the answer, so you never need to read a thread to resume. A duty that was FINISHED and sent back by a person comes back with `reopened` — what they said is wrong, and what the last attempt claimed it had done. Call this at the start of a work loop and whenever you finish something.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
        limit: { type: "integer", description: "How many runnable duties to return (1-10, default 3).", minimum: 1, maximum: 10 },
      },
    },
    handler: pollDuties,
  },
  {
    name: "duty_claim",
    title: "Claim a duty",
    description:
      "Take a queued duty and mark it active for you. You may hold only one active duty at a time — claiming while you already hold one fails and names the duty to finish first. Returns the full brief, so there is no need to fetch it separately — including `reopened` if this duty was finished before and a person sent it back, in which case read that note before the brief.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty to claim, from duty_poll."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id"],
    },
    handler: claimDuty,
  },
  {
    name: "duty_enqueue",
    title: "Add work you discovered",
    description:
      "Put newly discovered work on the board. Use priority 'immediate_blocker' when you cannot continue without it: the duty you are holding moves to blocked behind the new one, you are freed to claim it, and finishing it puts the parent back at the front of the queue automatically. Use 'next' or 'backlog' for work that does not interrupt what you are doing. While holding a note_review, this creates an approval-required suggestion instead; prefer duty_suggest, which also accepts a question.",
    inputSchema: {
      type: "object",
      properties: {
        title: s("One line naming the work."),
        brief: s("What needs doing and why, in a few sentences. This is what a future agent reads with no other context."),
        priority: s("How it schedules.", { enum: PRIORITIES, default: "next" }),
        spawned_by: s("The duty you were working on when you found this."),
        source_note_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "During a note review, notes supporting this proposal. Required for multi-note reviews; prefer duty_suggest." },
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
        external_ref: s("Your own id for this request. Filing the same external_ref again answers the duty already filed (existing: true) instead of a second one."),
        metadata: { type: "object", description: "Your own fields, up to 2KB of JSON, handed back on every read of the duty." },
        reserved_for: s("Send it to one runner: the agent_prefix of a machine linked to this board."),
      },
      required: ["title", "brief"],
    },
    handler: enqueueDuty,
  },
  {
    name: "duty_get",
    title: "Read one duty",
    description: "Read a duty or note. Returns duty with its status, brief, source_note_ids (legacy source_note_id) or origin_board_id/origin_duty_id when present, and outcome_summary once finished. A note also returns suggestions and suggestions_cursor: repeat with that cursor until null to inspect every linked proposal, including older reviews. approval_required means a person must explicitly approve before any work starts.",
    inputSchema: {
      type: "object",
      properties: { duty_id: s("The duty or note to read."), suggestions_cursor: s("For a note, the suggestions_cursor returned by the previous page of linked suggestions.") },
      required: ["duty_id"],
    },
    handler: getDuty,
  },
  {
    name: "duty_changes",
    title: "What moved",
    description:
      "The duties this connection filed whose status or content changed after `since` (epoch ms), oldest change first. Pass back the next_since it answers to get only what moved after that.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Epoch ms. 0, or leave it out, for everything.", default: 0 },
        limit: { type: "number", description: "At most this many, up to 100.", default: 50 },
      },
    },
    handler: listChanges,
  },
  {
    name: "duty_cancel",
    title: "Take back a duty you filed",
    description: "Call off a duty this connection filed that nobody is working on yet. It ends failed, with your reason. One already being worked on is refused.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty to cancel."),
        reason: s("Why, in a line. Kept on the duty."),
      },
      required: ["duty_id"],
    },
    handler: cancelDuty,
  },
  {
    name: "duty_checkpoint",
    title: "Ask, or record a milestone",
    description:
      "Post to a duty's thread. With set_status 'needs_decision' this is the non-blocking pause: the question is recorded, the duty parks until a human answers, and you are released immediately to claim other work — do this instead of guessing at an ambiguity or waiting on a credential you do not have. Without set_status it is just a note or milestone on the record.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty this is about."),
        message: s("The question or note, in markdown. Be specific: a human reads only this. A question leads with the question itself; a report leads with its one-line upshot, then bullets."),
        kind: s("What kind of entry this is.", { enum: THREAD_KINDS, default: "note" }),
        suggested_options: {
          type: "array",
          items: { type: "string" },
          description: "Concrete choices for the human to pick between. A question with options is answered far faster than an open one.",
        },
        set_status: s("Park the duty. 'needs_decision' frees you to take other work.", { enum: ["needs_decision", "blocked", "active"] }),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id", "message"],
    },
    handler: checkpointDuty,
  },
  {
    name: "duty_complete",
    title: "Finish a duty",
    description:
      "Mark the duty done. The outcome summary is permanent and is the only record of what happened — write what changed and where, not that you finished. If this duty was blocking a parent, the parent returns to the front of the queue. Refused, once, if a person wrote a note on the duty while you worked: the refusal carries the note — act on it, then complete again.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty you are finishing."),
        outcome_summary: s("What was actually done, in markdown: one sentence first, then a few bullets when there is more than one change."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id", "outcome_summary"],
    },
    handler: completeDuty,
  },
  {
    name: "duty_fail",
    title: "Give up on a duty",
    description:
      "Mark the duty failed when it cannot be completed as specified. Prefer duty_checkpoint with set_status 'needs_decision' when a human could unblock it — failing is for work that is genuinely not doable, not for work that is merely unclear.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty you are abandoning."),
        reason: s("Why it cannot be done."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id", "reason"],
    },
    handler: failDuty,
  },
  {
    name: "duty_thread",
    title: "Read a duty's decision log",
    description:
      "The full thread for one duty — questions, resolutions, milestones — oldest first. duty_poll already folds the latest question and answer into the duty, so reach for this only when you need the history behind a decision.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty whose thread you want."),
        limit: { type: "integer", description: "Entries to return (1-100, default 20).", minimum: 1, maximum: 100 },
      },
      required: ["duty_id"],
    },
    handler: listThread,
  },
  {
    name: "duty_search",
    title: "Search finished work",
    description:
      "Search the duties on this board that are already FINISHED, by their title, brief and outcome summary. Use it before starting something that sounds familiar, and when you need to know how a thing was done rather than that it was: the outcome summary of the duty that did it is usually the answer, and the duty_id lets you read its full thread. Open duties are not in here — use duty_list to browse all lanes or duty_poll for runnable work. The query is App Engine Search syntax: bare words, \"a phrase\", ~stemmed, title:word, AND / OR, -excluded. Indexing is not instant: a duty you have just completed may take a moment to become findable, so an empty result immediately after finishing something means nothing.",
    inputSchema: {
      type: "object",
      properties: {
        query: s('What to look for. e.g. `rate limit`, `~authenticate`, `"webhook signature"`, `title:migration`.'),
        project_id: s("Which board. Defaults to the one this token is scoped to."),
        status: s("Restrict to duties that finished one way.", { enum: ["done", "failed", "any"], default: "done" }),
        limit: { type: "integer", description: "How many results (1-25, default 10).", minimum: 1, maximum: 25 },
        cursor: s("Continue a previous search from where it stopped."),
      },
      required: ["query"],
    },
    handler: searchDuties,
  },
  {
    name: "duty_attachments",
    title: "Read the files on a duty",
    description:
      "Screenshots, recordings and logs attached to a duty, each with a URL you can fetch straight away. The URLs are signed and short-lived — fetch them now rather than storing them. A duty's `attachments` count tells you whether it is worth calling.",
    inputSchema: {
      type: "object",
      properties: { duty_id: s("The duty whose files you want.") },
      required: ["duty_id"],
    },
    handler: listAttachments,
  },
  {
    name: "duty_attach",
    title: "Attach a file to a duty",
    description:
      `Put a file on a duty — a screenshot of what you built, a recording of a failure, a log worth keeping. TWO WAYS. If you can make an HTTP request: pass \`size\` and it answers with an upload_url you PUT the bytes to, using the returned headers exactly and sending exactly that many bytes — up to ${MAX_BYTES / 1048576}MB, and the only way for anything large. If you cannot, or would rather not: pass \`content_base64\` instead of \`size\` and the file is stored in this one call, up to ${MAX_INLINE_BYTES / 1048576}MB. Attach evidence a person would want to look at; do not attach a transcript of your own reasoning.`,
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty to attach it to."),
        name: s("The file name, as a person should see it. e.g. 'checkout-error.png'"),
        size: {
          type: "integer",
          description: "The file's size in bytes, for the upload_url path. Signed into the URL, so it must be exact. Omit when sending content_base64.",
          minimum: 1,
        },
        content_base64: s(
          "The file itself, base64. Use this when you cannot make an HTTP PUT — the bytes are stored in this call and there is nothing to send afterwards. Small files only; a large one is refused with a message telling you to use `size` instead.",
        ),
        content_type: s("The MIME type, e.g. 'image/png' or 'video/mp4'."),
        agent_id: s("Which agent is attaching it. Optional when the connection names one."),
      },
      // `size` is no longer required: one of size / content_base64 must be there, and the
      // handler says which is missing. A schema cannot express "exactly one of these" in a
      // way every client validates the same way, and a wrong refusal from the client side
      // is harder to act on than a clear one from ours.
      required: ["duty_id", "name"],
    },
    handler: attachToDuty,
  },
  {
    name: "board_profile",
    title: "What this project is",
    description:
      "The board's profile — project type, repository, stack, toolchain, test command, how it deploys, how a worktree for it is prepared — and its runner settings, plus the version of the rules in force. runner.use_machine_defaults true inherits the current machine's enabled combinations and order. Otherwise runner.options is the board priority override; older boards use runner.agent/model/effort. A saved options list is inactive while machine defaults are enabled. This is configuration, not live availability or remaining usage. Only owners change runner settings. Read it before a setup or rules duty, and whenever you need the project's real commands rather than guessing them.",
    inputSchema: { type: "object", properties: {} },
    handler: getProfile,
  },
  {
    name: "board_profile_propose",
    title: "Record what setup found",
    description:
      "While holding an active 'setup' duty: write down what this project needs and how it is run, so every machine and every later session uses the same answers. Send only the parts you established. Takes effect at once; the board's owner can change any of it.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The setup duty you are holding."),
        toolchain: {
          type: "array",
          description: "What the project needs installed, e.g. {name: 'godot', version: '4.7.1', why: 'engine; project.godot says 4.7'}.",
          items: {
            type: "object",
            properties: { name: s("Tool name."), version: s("Exact version, when it matters."), why: s("What needs it.") },
            required: ["name"],
          },
        },
        test_command: s("The command that runs the project's full test suite, from the project root."),
        deploy: {
          type: "object",
          description: "How the project ships.",
          properties: {
            method: s("How it deploys.", { enum: DEPLOY_METHODS }),
            workflow: s("For ci / ci-dispatch: the workflow file, e.g. 'deploy.yml'."),
            branch: s("The branch a push to deploys, when it is not the default branch."),
            command: s("For command: what to run."),
            altengine_targets: {
              type: "array",
              description: "For altengine: what this project may deploy to, and as what. Usually set by the board's owner; leave it out to keep theirs.",
              items: { type: "object", properties: { kind: s("static or functions.", { enum: ["static", "functions"] }), instance: s("The instance name.") }, required: ["kind", "instance"] },
            },
          },
        },
        worktree: {
          type: "object",
          description: "How a fresh checkout of this project is made ready to work in. Paths are relative to the project root.",
          properties: {
            prep: s("Command that prepares a fresh checkout, e.g. 'npm ci'."),
            prep_inputs: { type: "array", items: { type: "string" }, description: "Files whose change means prep must run again, e.g. 'package-lock.json'." },
            cache: { type: "array", items: { type: "string" }, description: "Expensive ignored folders worth handing from one checkout to the next, e.g. 'node_modules', '.godot'." },
            copy: { type: "array", items: { type: "string" }, description: "Files outside git a checkout needs, copied from the project folder, e.g. '.env'." },
          },
        },
        repos: {
          type: "array",
          description: "For a board with more repositories than its main one: what you found for each, by the name the board gives it.",
          items: {
            type: "object",
            properties: {
              name: s("The repository's name on the board."),
              test_command: s("The command that runs that repository's whole test suite, from its root."),
              worktree: { type: "object", description: "How a fresh checkout of that repository is made ready: prep, prep_inputs, cache, copy — as for the main repository." },
            },
            required: ["name"],
          },
        },
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id"],
    },
    handler: proposeProfile,
  },
  {
    name: "board_rules",
    title: "The project's rules",
    description:
      "The rules in force on this board, as markdown: what every duty here must respect — security, reuse, performance, testing, conventions. `has_draft` says whether proposed rules are waiting for a person; a draft is not in force.",
    inputSchema: { type: "object", properties: {} },
    handler: getRules,
  },
  {
    name: "board_rules_submit",
    title: "Hand in proposed rules",
    description:
      "While holding an active 'rules' duty: submit the rules you wrote, as markdown. They become a draft that a person reviews and accepts; submitting again replaces your draft. Make them specific to this project and checkable — real commands, real paths — not general advice.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The rules duty you are holding."),
        body: s("The rules, as markdown."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["duty_id", "body"],
    },
    handler: submitRules,
  },
  {
    name: "duty_schedule_list",
    title: "Recurring duties on this board",
    description:
      "The recurring duties set up on this board: what each one files, how often, and when it next comes round. Check this before setting one up, so the board does not grow two schedules doing the same thing.",
    inputSchema: { type: "object", properties: {} },
    handler: listSchedules,
  },
  {
    name: "duty_schedule_create",
    title: "Make a duty recur",
    description:
      "Set up work that should happen again and again on a clock — a weekly post, a monthly check of something that drifts — so it arrives as a fresh duty each time rather than being remembered by nobody. Only while you are holding an active duty: a schedule should come out of work you are actually doing, and the board records which agent asked for it. The repeat is a five-field cron expression read in the board's timezone, and two runs must be at least 15 minutes apart. Each duty it files carries a note of how the previous one turned out, so a recurring writing duty does not repeat itself. Use one for anything that must happen later or keep happening — refreshing data, watching for a change, looking back to see whether something worked — instead of waiting in a session. Each run knows only its brief and how the last one went, so the brief must carry every URL and step. When nobody asked for the work to repeat, propose it to a person in a checkpoint first.",
    inputSchema: {
      type: "object",
      properties: {
        title: s("One line naming the work, used as each filed duty's title."),
        brief: s("What needs doing, every time it comes round. Written for an agent with no other context."),
        cron: s("Five fields — minute, hour, day of the month, month, day of the week. '0 9 * * 1' is 9am every Monday."),
        priority: s("How each filed duty schedules.", { enum: PRIORITIES, default: "next" }),
        reserved_for: s("A machine's agent prefix, if the work can only be done on that machine."),
        expire_after_days: { type: "integer", minimum: 0, maximum: 365, description: "Remove each duty it files from the board this many days after it is done, for runs nobody needs the record of. 0, the default, keeps them." },
        check: s("Optional. A shell command the machine runs before waking an agent for each run, in the board's folder. Exit 0 printing nothing means there is nothing to do: no session starts and the run leaves no duty behind. Any output, or a failing exit, wakes an agent with that output in its brief. $DUTYBOARD_STATE_DIR is a folder kept between runs, for remembering what it has already seen."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["title", "brief", "cron"],
    },
    handler: createSchedule,
  },
  {
    name: "duty_schedule_history",
    title: "What a recurring duty has filed",
    description:
      "The duties one schedule has already filed, newest first, with how each one went — so a recurring duty can see what the last few runs actually did rather than only the summary in its own brief. A page at a time: pass `cursor` from `next_cursor` for older ones, and stop when there is no cursor.",
    inputSchema: {
      type: "object",
      properties: {
        schedule_id: s("The schedule, from duty_schedule_list."),
        limit: { type: "integer", description: "How many to return (1-50, default 10).", minimum: 1, maximum: 50 },
        cursor: s("From a previous answer's next_cursor, for the page after it."),
      },
      required: ["schedule_id"],
    },
    handler: scheduleHistory,
  },
  {
    name: "duty_schedule_update",
    title: "Change or pause a recurring duty",
    description:
      "Change what a recurring duty says or how often it comes round, or turn it off with enabled false without deleting it. Only while you are holding an active duty. Changing the repeat re-aims it: the next run is worked out from now.",
    inputSchema: {
      type: "object",
      properties: {
        schedule_id: s("The schedule, from duty_schedule_list."),
        title: s("A new title for the duties it files."),
        brief: s("A new brief."),
        cron: s("A new five-field repeat."),
        priority: s("How each filed duty schedules.", { enum: PRIORITIES }),
        enabled: { type: "boolean", description: "False pauses it; true starts it again." },
        expire_after_days: { type: "integer", minimum: 0, maximum: 365, description: "Remove each duty it files this many days after it is done; 0 keeps them. Applies to the duties it files from now on." },
        check: s("An empty string removes it. A shell command the machine runs before waking an agent for each run, in the board's folder. Exit 0 printing nothing means there is nothing to do: no session starts and the run leaves no duty behind. Any output, or a failing exit, wakes an agent with that output in its brief. $DUTYBOARD_STATE_DIR is a folder kept between runs, for remembering what it has already seen."),

        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["schedule_id"],
    },
    handler: updateSchedule,
  },
  {
    name: "duty_schedule_delete",
    title: "Stop a recurring duty",
    description:
      "Remove a schedule for good. Duties it has already filed stay on the board. Only while you are holding an active duty — and if the schedule is one a person set up, ask them in a checkpoint first rather than deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        schedule_id: s("The schedule, from duty_schedule_list."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["schedule_id"],
    },
    handler: deleteSchedule,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** What a `submit` token's connection has — the same set as its REST routes (index.js). */
const SUBMIT_TOOLS = new Set(["duty_enqueue", "duty_get", "duty_changes", "duty_cancel", "duty_thread", "duty_attach", "duty_attachments"]);

/** Fields a submit token's tools leave out: it holds no duty, so there is no agent_id or
 *  spawned_by for it to fill in. */
const SUBMIT_HIDDEN_FIELDS = new Set(["agent_id", "spawned_by"]);

const allowedTool = (ctx, name) => ctx.caller.scope !== "submit" || SUBMIT_TOOLS.has(name);

function listing(ctx) {
  const submit = ctx.caller.scope === "submit";
  return TOOLS.filter((t) => allowedTool(ctx, t.name)).map(({ name, title, description, inputSchema }) => {
    if (!submit || !inputSchema.properties) return { name, title, description, inputSchema };
    const properties = Object.fromEntries(Object.entries(inputSchema.properties).filter(([k]) => !SUBMIT_HIDDEN_FIELDS.has(k)));
    return { name, title, description, inputSchema: { ...inputSchema, properties } };
  });
}

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Handle one JSON-RPC message. Returns null for a notification (nothing to answer). */
async function dispatch(ctx, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcErr(msg && msg.id != null ? msg.id : null, -32600, "invalid request");
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: ctx.caller.scope === "submit" ? SUBMIT_INSTRUCTIONS : INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, { tools: listing(ctx) });
    case "tools/call": {
      const name = params && params.name;
      const tool = allowedTool(ctx, name) ? BY_NAME.get(name) : null;
      if (!tool) return rpcErr(id, -32602, `unknown tool '${name}'`);
      try {
        const result = await tool.handler(ctx, (params && params.arguments) || {});
        return rpcOk(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (err) {
        const message = err instanceof HttpError ? `${err.code}: ${err.message}` : "internal error";
        if (!(err instanceof HttpError)) console.log("mcp tool failed:", name, err && err.stack);
        return rpcOk(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return isNotification ? null : rpcErr(id, -32601, `method '${method}' not found`);
  }
}

/** Same authorized gateway for MCP and REST; nested calls are never permitted. */
export async function callLinkedBoard(ctx, body) {
  const tool = BOARD_OPERATIONS[body.operation] && BY_NAME.get(body.operation);
  if (!tool) throw badRequest("that operation is not available through a board link");
  return callWithBoardAccess(ctx, body, tool.handler);
}

export async function handleMcp(ctx, request, maxBody) {
  if (request.method === "GET") {
    // No server-initiated messages, so there is no stream to open.
    return new Response("this MCP endpoint is POST-only", { status: 405, headers: { allow: "POST" } });
  }
  // Bounded. This used to be a bare request.text(), which was a hole straight through the
  // body limit on the door most of this API's traffic arrives at. Too large throws an
  // HttpError and comes back as a 413 rather than a JSON-RPC error, because a body that was
  // never read is not a message that can carry an id to answer.
  const text = await readBoundedText(request, maxBody);
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return json(rpcErr(null, -32700, "parse error"), 200);
  }

  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) {
      const r = await dispatch(ctx, m);
      if (r) out.push(r);
    }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }

  const res = await dispatch(ctx, msg);
  return res ? json(res) : new Response(null, { status: 202 });
}
