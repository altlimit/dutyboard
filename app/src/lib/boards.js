// The boards page: what each board has on it, and which boards to show first.
//
// The page used to be a grid of names in creation order, and every board looked the same
// whether three agents were waiting on an answer or nothing had moved in a month. These turn
// one grouped count across every board into a line per card, and an order that puts the
// boards that need you where you look first.

/** Work that is not finished. A board with none of it and no recent activity is quiet. */
const OPEN = ["needs_decision", "queued", "active", "blocked", "failed"];

/** How long a board with nothing open has to sit still before it folds away as quiet. */
export const QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The grouped count every card is drawn from: duties per board per status, and when each
 * group last moved. One request covers your boards and the ones shared with you — the read
 * rule is an OR of the two, and the datastore counts the union once.
 *
 * `limit` is explicit because an aggregate returns 25 groups by default, and six statuses
 * reach that by the fifth board. 500 is the most it gives; past ~80 boards the least recently
 * touched cards go without counts rather than the page failing.
 */
export const COUNTS_REQUEST = {
  group: ["project_id", "status"],
  metrics: [
    { fn: "count", as: "n" },
    { fn: "max", field: "updated_at", as: "last" },
  ],
  limit: 500,
};

/** `{ [project_id]: { needs_decision, queued, …, open, last } }` from the aggregate's groups. */
export function countsByBoard(groups) {
  const out = {};
  for (const g of groups || []) {
    const id = g.group && g.group.project_id;
    if (!id) continue;
    const c = (out[id] ||= { open: 0, last: 0 });
    const n = Number(g.metrics.n) || 0;
    c[g.group.status] = n;
    if (OPEN.includes(g.group.status)) c.open += n;
    c.last = Math.max(c.last, Number(g.metrics.last) || 0);
  }
  return out;
}

/**
 * Boards in the order worth reading them: what is waiting on you, then what failed, then
 * whatever moved most recently. A board nobody has worked yet falls back to when it was made,
 * so a new one still sits above last year's.
 */
export function sortBoards(boards, counts) {
  const c = (b) => counts[b.project_id] || {};
  return [...boards].sort(
    (a, b) =>
      (c(b).needs_decision || 0) - (c(a).needs_decision || 0) ||
      (c(b).failed || 0) - (c(a).failed || 0) ||
      (c(b).last || b.created_at || 0) - (c(a).last || a.created_at || 0),
  );
}

/** Nothing open, and nothing has moved for a fortnight. */
export function isQuiet(board, counts, now = Date.now()) {
  const c = counts[board.project_id];
  if (c && c.open) return false;
  const last = (c && c.last) || board.created_at || 0;
  return now - last > QUIET_AFTER_MS;
}

/**
 * What a card says about its board's work, as parts in reading order. `tone` picks the badge;
 * the words say the same thing, so colour is never the only signal.
 */
export function workParts(c) {
  if (!c) return [];
  const parts = [];
  if (c.needs_decision) parts.push({ tone: "needs_decision", text: `${c.needs_decision} need${c.needs_decision === 1 ? "s" : ""} you` });
  if (c.failed) parts.push({ tone: "failed", text: `${c.failed} failed` });
  if (c.active) parts.push({ tone: "active", text: `${c.active} in progress` });
  if (c.queued) parts.push({ tone: "", text: `${c.queued} queued` });
  if (c.blocked) parts.push({ tone: "", text: `${c.blocked} blocked` });
  return parts;
}
