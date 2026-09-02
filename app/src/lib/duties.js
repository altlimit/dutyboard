// Board vocabulary, shared by every view.
//
// Status is shown as a word, never as a colour alone — the colours here are an accent on
// text that already says the same thing.

export const STATUS_COLUMNS = [
  {
    key: "needs_decision",
    label: "Needs you",
    hint: "An agent asked a question and moved on. Answer to put the duty back in the queue.",
  },
  { key: "queued", label: "Queued", hint: "Waiting for an agent to claim it, highest priority first." },
  { key: "active", label: "In progress", hint: "Claimed by an agent right now." },
  { key: "blocked", label: "Blocked", hint: "Waiting on a child duty an agent spawned." },
  { key: "done", label: "Done", hint: "Finished, with a permanent outcome summary." },
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

export const THREAD_KIND_LABELS = {
  question: "Question",
  resolution: "Your answer",
  checkpoint: "Checkpoint",
  note: "Note",
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
