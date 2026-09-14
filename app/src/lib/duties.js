// Board vocabulary, shared by every view.
//
// Status is shown as a word, never as a colour alone — the colours here are an accent on
// text that already says the same thing.

/**
 * How each column is ordered, and why it is not all the same.
 *
 * `queued` is ordered exactly as the SCHEDULER orders it — priority rank, then oldest —
 * because the top of that column is a promise: it is the duty an agent will actually claim
 * next. It used to be newest-first like everything else, and on a busy board that made the
 * column a plausible-looking lie. The agent would take duty 0 while the board showed 245 at
 * the top, and the hint above it said "highest priority first".
 *
 * `needs_decision` is oldest-first because the question waiting longest is the one that has
 * been blocking someone longest, and newest-first buries it.
 *
 * Everything else is most-recently-touched, which is what "what is happening" means.
 */
const ORDERS = {
  queued: [
    { field: "prio_rank", dir: "asc" },
    { field: "created_at", dir: "asc" },
  ],
  needs_decision: [{ field: "updated_at", dir: "asc" }],
};
const RECENT_FIRST = [{ field: "updated_at", dir: "desc" }];

/** The `order` clause for one column's query. */
export const columnOrder = (status) => ORDERS[status] || RECENT_FIRST;

/** The same ordering, applied to rows already in hand — the working set arrives as one
 *  query in a single order and has to be sorted per column after it is bucketed. */
export function sortColumn(status, rows) {
  const order = columnOrder(status);
  return rows.sort((a, b) => {
    for (const { field, dir } of order) {
      const av = a[field] ?? 0;
      const bv = b[field] ?? 0;
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

export const STATUS_COLUMNS = [
  {
    key: "needs_decision",
    label: "Needs you",
    hint: "An agent asked a question and moved on. Answer to put the duty back in the queue.",
  },
  { key: "queued", label: "Queued", hint: "Waiting for an agent to claim it, in the order an agent will take them." },
  { key: "active", label: "In progress", hint: "Claimed by an agent right now." },
  { key: "blocked", label: "Blocked", hint: "Waiting on a child duty an agent spawned." },
  { key: "done", label: "Done", hint: "Finished, with a permanent outcome summary. Open one to send it back if it did not work." },
  // `whenUsed`: rendered only while it has something in it. Failure is a real state an
  // agent can reach and it must be visible when it happens — but on most boards it never
  // does, and a permanently empty column costs every other column a share of the width.
  {
    key: "failed",
    label: "Failed",
    hint: "Ended without finishing. The agent's reason is on the duty's thread.",
    whenUsed: true,
  },
];

export const PRIORITIES = [
  { key: "immediate_blocker", label: "Blocker", hint: "Interrupts: taken before anything else." },
  { key: "next", label: "Next", hint: "The normal queue." },
  { key: "backlog", label: "Backlog", hint: "Picked up when nothing else is waiting." },
];

export const ALL_STATUSES = ["queued", "active", "needs_decision", "blocked", "done", "failed"];

const LABELS = {
  queued: "Queued",
  active: "In progress",
  needs_decision: "Needs you",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
};

export const statusLabel = (s) => LABELS[s] || s;
export const priorityLabel = (p) => (PRIORITIES.find((x) => x.key === p) || { label: p }).label;

/**
 * Who a duty came from, as the person looking at it should read it — "from you", "from Ada", or
 * "from an agent". `verb` is "from" on a card and "raised by" on the duty page.
 *
 * A duty filed before boards could be shared has no `created_by`, and needs none: until then only
 * a board's owner could add one, so its creator IS the owner the row already names.
 */
export function originLabel(duty, me, verb = "from") {
  if (duty.origin === "agent") return `${verb} an agent`;
  const creator = duty.created_by || duty.owner_uid;
  if (me && creator === me.uid) return `${verb} you`;
  return duty.created_by_name ? `${verb} ${duty.created_by_name}` : `${verb} the board's owner`;
}

export const THREAD_KIND_LABELS = {
  question: "Question",
  resolution: "Your answer",
  checkpoint: "Checkpoint",
  note: "Note",
  reopen: "Sent back",
};

/** Relative time, for a board where "3m ago" is more useful than a timestamp. */
export function ago(ms) {
  if (!ms) return "";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export const exactTime = (ms) => (ms ? new Date(ms).toLocaleString() : "");
