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


// --- the page's headline numbers -------------------------------------------

const STATUSES = ["needs_decision", "queued", "active", "blocked", "failed", "done"];

/** Every board's counts added up: what the tiles across the top of the page say. */
export function totals(counts) {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const c of Object.values(counts || {})) for (const s of STATUSES) out[s] += c[s] || 0;
  return out;
}

/** How many days the finished-work chart covers, today included. */
export const TREND_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;

/** Local midnight `days` before the day `now` falls in. By the calendar, not by 24-hour steps,
 *  so a fortnight that crosses a clock change still starts at midnight. */
function midnight(now, days = 0) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/**
 * Finished work per hour, across every board you can see, for the fortnight the chart covers.
 * The function counts by the hour (it does not know your timezone); the days are made here.
 */
export function finishesRequest(now = Date.now()) {
  return {
    where: [{ field: "hour", op: ">=", value: Math.floor(midnight(now, TREND_DAYS - 1) / HOUR_MS) }],
    group: ["hour"],
    metrics: [
      { fn: "sum", field: "done", as: "done" },
      { fn: "sum", field: "failed", as: "failed" },
    ],
    // A fortnight is 336 hours; the default of 25 groups would be the last day.
    limit: 500,
  };
}

/**
 * `[{ start, done, failed }]`, one per local day, oldest first, today last — from the hourly
 * groups. An hour belongs to the day its middle falls in, which only matters in a timezone that
 * is not a whole number of hours from UTC, where an hour straddles midnight.
 */
export function finishesByDay(groups, now = Date.now()) {
  const days = Array.from({ length: TREND_DAYS }, (_, i) => ({ start: midnight(now, TREND_DAYS - 1 - i), done: 0, failed: 0 }));
  for (const g of groups || []) {
    const at = Number(g.group && g.group.hour) * HOUR_MS + HOUR_MS / 2;
    if (!Number.isFinite(at)) continue;
    let i = days.length - 1;
    while (i >= 0 && days[i].start > at) i--;
    if (i < 0) continue;
    days[i].done += Number(g.metrics && g.metrics.done) || 0;
    days[i].failed += Number(g.metrics && g.metrics.failed) || 0;
  }
  return days;
}

/** The last `n` days of a `finishesByDay` answer added up. */
export function lastDays(days, n, field) {
  return days.slice(-n).reduce((sum, d) => sum + d[field], 0);
}

/**
 * What each machine says it is doing with each duty, keyed by duty — so "Running now" can say a
 * duty is waiting out a usage limit rather than just that it is active. From `/projects/runners`.
 */
export function runsByDuty(runnersByBoard) {
  const out = {};
  for (const links of Object.values(runnersByBoard || {})) {
    for (const l of links) for (const r of l.runs || []) out[r.duty_id] = { ...r, machine: l.machine_name, online: l.online !== false };
  }
  return out;
}

/** The machines online across every board, each counted once however many boards it works. */
export function machinesOnline(runnersByBoard) {
  const ids = new Set();
  for (const links of Object.values(runnersByBoard || {})) for (const l of links) if (l.online !== false) ids.add(l.machine_id);
  return ids.size;
}
