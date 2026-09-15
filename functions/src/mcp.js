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

import { HttpError, json, readBoundedText } from "./http.js";
import { pollDuties, claimDuty, enqueueDuty, checkpointDuty, completeDuty, failDuty, listThread, PRIORITIES, THREAD_KINDS } from "./duties.js";
import { attachToDuty, listAttachments, MAX_BYTES, MAX_INLINE_BYTES } from "./attachments.js";
import { searchDuties } from "./searching.js";
import { getProfile, proposeProfile, getRules, submitRules, DEPLOY_METHODS } from "./profile.js";
import { VERSION } from "./version.js";

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
Call duty_poll before doing anything you were not explicitly asked to do. If it reports an active duty, that is yours already — resume it from its brief and its last checkpoint rather than starting over. Otherwise duty_claim the first runnable duty; the queue is ordered, so do not shop through it. If nothing is runnable, say so and stop.

WHAT YOU FIND ALONG THE WAY
Do not widen the duty you are on. A discovery that blocks it: duty_enqueue with priority 'immediate_blocker' and spawned_by set to the duty you are holding — yours parks behind it, you claim the new one, and finishing it returns the parent to the front of the queue on its own. A discovery that does not block it: duty_enqueue with 'next' or 'backlog', then carry on with what you were doing.

WHEN YOU DO NOT KNOW
An ambiguity in the brief, a choice with consequences you cannot take back, a credential you do not have: duty_checkpoint with set_status 'needs_decision', the actual question in message, and suggested_options whenever the answer is a choice between things you can name. THEN POLL AND CLAIM SOMETHING ELSE. Do not wait for the answer, do not guess and continue, and do not ask in your own output and hope someone reads it — a question that is not on the board does not exist. You cannot answer your own question; only a person can.

FINISHING
Nothing is done because you believe it is done. Verify it, then duty_complete with an outcome_summary saying what changed and where — "Added GitHub OAuth via net/http; session verification in middleware/auth.go", not "completed the auth task". It is the only thing that survives your session. Then poll again. Use duty_fail only for work that genuinely cannot be done; anything a person could unblock is a needs_decision.

WORK THAT COMES BACK
A duty may arrive carrying 'reopened'. It was finished — by you, or by an agent whose session is gone — and a person then used the result and it did not work. 'note' is why, and it is the most important line in that duty; 'previous_outcome' is what the last attempt claimed, which is a lead rather than a fact. Read the note before the brief and duty_thread before you rewrite anything: repeating what has already been tried is the failure mode here. You cannot send a duty back yourself, only a person can — if you find a problem in finished work that is not the duty you hold, duty_enqueue it.

BEFORE STARTING SOMETHING THAT SOUNDS FAMILIAR
duty_search looks through the duties already finished on this board — their titles, briefs and outcome summaries. The board remembers work you have no memory of, done by other agents or by you in a session that is gone. Search before you rebuild something, and when you need to know HOW a thing was done: the outcome summary usually says, and the duty_id it gives you opens the full thread.

SHOWING RATHER THAN DESCRIBING
duty_attach puts a file on a duty — a screenshot of what you built, a recording of the failure, the log that explains it. duty_attachments reads what is there, including what a person attached for you; if a duty has attachments, look at them before asking about it.

THE PROJECT ITSELF
board_profile says what this project is — its type, repository, toolchain, test command, how it deploys — and board_rules gives the rules a person has put in force for it. Follow those rules in every duty. A duty of kind 'setup' is how a machine gets ready for the project: record what you found with board_profile_propose. A duty of kind 'rules' asks you to write the rules: hand them in with board_rules_submit, and a person decides whether they take effect.`;

const s = (description, extra = {}) => ({ type: "string", description, ...extra });

const TOOLS = [
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
      "Put newly discovered work on the board. Use priority 'immediate_blocker' when you cannot continue without it: the duty you are holding moves to blocked behind the new one, you are freed to claim it, and finishing it puts the parent back at the front of the queue automatically. Use 'next' or 'backlog' for work that does not interrupt what you are doing.",
    inputSchema: {
      type: "object",
      properties: {
        title: s("One line naming the work."),
        brief: s("What needs doing and why, in a few sentences. This is what a future agent reads with no other context."),
        priority: s("How it schedules.", { enum: PRIORITIES, default: "next" }),
        spawned_by: s("The duty you were working on when you found this."),
        agent_id: s("Which agent you are. Defaults to the id configured on this connection."),
      },
      required: ["title", "brief"],
    },
    handler: enqueueDuty,
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
        message: s("The question or note. Be specific: a human reads only this."),
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
      "Mark the duty done. The outcome summary is permanent and is the only record of what happened — write what changed and where, not that you finished. If this duty was blocking a parent, the parent returns to the front of the queue.",
    inputSchema: {
      type: "object",
      properties: {
        duty_id: s("The duty you are finishing."),
        outcome_summary: s("What was actually done, in a few sentences."),
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
      "Search the duties on this board that are already FINISHED, by their title, brief and outcome summary. Use it before starting something that sounds familiar, and when you need to know how a thing was done rather than that it was: the outcome summary of the duty that did it is usually the answer, and the duty_id lets you read its full thread. Open duties are not in here — duty_poll is what shows you those. The query is App Engine Search syntax: bare words, \"a phrase\", ~stemmed, title:word, AND / OR, -excluded. Indexing is not instant: a duty you have just completed may take a moment to become findable, so an empty result immediately after finishing something means nothing.",
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
      "The board's profile — project type, repository, stack, toolchain, test command, how it deploys, how a worktree for it is prepared — and its runner settings, plus the version of the rules in force. Read it before a setup or rules duty, and whenever you need the project's real commands rather than guessing them.",
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
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const listing = () =>
  TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));

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
        instructions: INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : rpcOk(id, {});
    case "tools/list":
      return rpcOk(id, { tools: listing() });
    case "tools/call": {
      const name = params && params.name;
      const tool = BY_NAME.get(name);
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
