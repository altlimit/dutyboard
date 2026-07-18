// Human-friendly relative timestamps for the `created`/`updated` ms epochs the
// datastore returns. Falls back to a locale date for anything older than a week.
export function fmtTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? " min ago" : " mins ago");
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  const d = Math.round(h / 24);
  if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
  return new Date(ms).toLocaleDateString();
}
