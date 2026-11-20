// Whether a newer DutyBoard is out, for the console to say so with a link that updates it.
//
// The newest release's manifest is published at www.dutyboard.com/deploy/latest/altengine.json, and
// its `version` is the newest version. The console cannot read it itself — a static site sends no
// CORS headers — so this function does, and remembers the answer for a few hours per isolate: a
// console asks once per page load, and every one of them would otherwise be a fetch to the site.
//
// Best-effort throughout. A deployment whose function may not reach the site (one provisioned before
// it was allowed to), or a site that is down, answers `latest: null`, and the console says nothing.

import { VERSION } from "./version.js";

export const MANIFEST_URL = "https://www.dutyboard.com/deploy/latest/altengine.json";
const FRESH_MS = 6 * 3600_000;
const RETRY_MS = 15 * 60_000;

let memo = null; // { at, latest, ok }

/** -1, 0 or 1, for two `major.minor.patch` versions; null when either is not one. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

async function fetchLatest(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const m = await res.json();
    return typeof m.version === "string" && compareVersions(m.version, m.version) === 0 ? m.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /release` — this deployment's version, the newest released, and whether that is newer. */
export async function releaseStatus(env, cfg, now = Date.now(), current = VERSION) {
  const url = env.DUTYBOARD_MANIFEST_URL || MANIFEST_URL;
  if (!memo || now - memo.at > (memo.ok ? FRESH_MS : RETRY_MS)) {
    const latest = await fetchLatest(url);
    memo = { at: now, latest, ok: latest !== null };
  }
  const latest = memo.latest;
  return {
    current,
    latest,
    update_available: latest !== null && compareVersions(latest, current) === 1,
    // What the console's update link names, so it updates this deployment and not a new one.
    app: cfg.app || null,
    manifest_url: url,
    checked_at: memo.at,
  };
}

/** For tests: forget the remembered answer. */
export function _resetRelease() {
  memo = null;
}
