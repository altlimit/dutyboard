// MCP over streamable HTTP, at POST /mcp.
//
// The same handlers the REST routes call, exposed as tools so an agent runtime can add
// DutyBoard as a server and get `duty_poll` / `duty_claim` / … with no shim in between:
//
//   claude mcp add --transport http dutyboard \
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

import { HttpError, json } from "./http.js";
import { pollDuties, claimDuty, enqueueDuty, checkpointDuty, completeDuty, failDuty, listThread, PRIORITIES, THREAD_KINDS } from "./duties.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "dutyboard", title: "DutyBoard", version: "2.0.0" };

const s = (description, extra = {}) => ({ type: "string", description, ...extra });

const TOOLS = [
  {
    name: "duty_poll",
    title: "Poll the board",
    description:
      "Your whole view of the board in one call: the duty you are currently holding (if any) and the top of the runnable queue, highest priority first. A duty that was parked for a human decision comes back with unblocked_context carrying the question and the answer, so you never need to read a thread to resume. Call this at the start of a work loop and whenever you finish something.",
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
      "Take a queued duty and mark it active for you. You may hold only one active duty at a time — claiming while you already hold one fails and names the duty to finish first. Returns the full brief, so there is no need to fetch it separately.",
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
        instructions:
          "DutyBoard coordinates long-running work between agents and the people who own it. Loop: duty_poll, duty_claim the top runnable duty, work, then duty_complete with a real summary. When you hit an ambiguity or need something only a human can give you, duty_checkpoint with set_status 'needs_decision' and immediately claim the next duty instead of waiting. Report discovered work with duty_enqueue rather than silently widening the duty you are on.",
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

export async function handleMcp(ctx, request) {
  if (request.method === "GET") {
    // No server-initiated messages, so there is no stream to open.
    return new Response("this MCP endpoint is POST-only", { status: 405, headers: { allow: "POST" } });
  }
  let msg;
  try {
    msg = JSON.parse(await request.text());
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
