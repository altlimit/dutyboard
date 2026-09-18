// Which versions are in play, and whether they agree.
//
// A DutyBoard is three things that are released together and updated separately: this console (a
// static site), the board function behind it, and every machine running `dutyboard`. They are
// meant to be the same version, and when they are not the symptom is a feature that is simply
// absent — a page that calls an endpoint the function does not have yet, a machine that never
// files a recurring duty. That is a bad hour of guessing, so each one says what it is.

import { config } from "../config.js";

/** This build's version, from the repository's package.json at build time. */
export const CONSOLE_VERSION = typeof __DUTYBOARD_VERSION__ === "string" ? __DUTYBOARD_VERSION__ : "dev";

let asked = null;

/**
 * What the board function reports, from its own `/health` — no credential, so this works on a
 * console nobody has signed into yet. Asked once per page load; a failure answers "" rather than
 * throwing, because not knowing a version is never a reason for a page to fail to draw.
 */
export function serviceVersion() {
  if (asked) return asked;
  asked = fetch(`${config.api}/health`)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (body && body.ok ? String(body.version || "") : ""))
    .catch(() => "");
  return asked;
}

/** True when two versions are both known and differ — the only case worth saying anything about. */
export const differs = (a, b) => !!a && !!b && a !== b && a !== "dev" && b !== "dev";
