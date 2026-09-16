// ULIDs and agent tokens.
//
// Duty and thread keys are lexicographically sortable by creation time, which is what
// lets a duty's thread be read in order and a keyset cursor over duties mean something
// without a second sort field.

import { sha256Hex as sha256 } from "./hash.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = 0;
let lastRandom = null;

function encodeTime(ms, len) {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/**
 * Cryptographically strong random bytes.
 *
 * `crypto.getRandomValues` is the right primitive and is what production uses. The local
 * emulator's sandbox provides only `crypto.randomUUID`, which is CSPRNG-backed too — so
 * that is the fallback, rather than a Math.random path that would be silently weak in the
 * one environment nobody checks.
 */
function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(out);
    return out;
  }
  let filled = 0;
  while (filled < n) {
    // A v4 UUID carries 122 random bits; the version and variant nibbles are fixed, so
    // they are skipped rather than counted as entropy.
    const hex = crypto.randomUUID().replace(/-/g, "");
    for (let i = 0; i < 32 && filled < n; i += 2) {
      if (i === 12 || i === 16) continue; // the version / variant positions
      out[filled++] = parseInt(hex.slice(i, i + 2), 16);
    }
  }
  return out;
}

/** Increment the 80-bit randomness in place, so two ULIDs minted in the same
 *  millisecond still sort in the order they were created. */
function bumpRandom(r) {
  for (let i = r.length - 1; i >= 0; i--) {
    if (r[i] < 31) {
      r[i]++;
      return r;
    }
    r[i] = 0;
  }
  return r; // overflowed a whole millisecond of ids — vanishingly unlikely, and harmless
}

export function ulid(now = Date.now()) {
  if (now === lastMs && lastRandom) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastMs = now;
    lastRandom = Array.from(randomBytes(16)).map((b) => b % 32);
  }
  let rand = "";
  for (const v of lastRandom) rand += CROCKFORD[v];
  return encodeTime(now, 10) + rand;
}

/** Ids carry a prefix so it is obvious in an agent's transcript what kind of id it is. */
export const dutyId = () => "duty_" + ulid();
export const threadId = () => "th_" + ulid();
export const scheduleId = () => "sch_" + ulid();

/** A URL-safe slug for a project key. */
export function slugify(s, fallback = "project") {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || fallback;
}

const B64URL = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A fresh agent token — 192 bits. Shown once at mint; only its SHA-256 is ever stored. */
export function mintToken() {
  return "db_" + B64URL(randomBytes(24));
}

/** A machine key — 256 bits, because it reaches every board its machine is linked to rather
 *  than one. Handed over once, at the end of pairing; only its SHA-256 is stored. */
export function mintMachineKey() {
  return "dbm_" + B64URL(randomBytes(32));
}

/** The secret half of a pairing: the daemon holds it and polls with it. Never shown to a
 *  person, so it can be as long as it likes. */
export const mintDeviceCode = () => B64URL(randomBytes(32));

export const machineId = () => "m_" + ulid();
export const requestId = () => "mr_" + ulid();

/** No I, O, 0 or 1: a person reads this off one screen and types it into another. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The half of a pairing a person types — `KQTR-8841`.
 *
 * 40 bits, which would be thin for a secret and is fine for this: approving a code needs a
 * signed-in person, the code dies in ten minutes, and what it grants goes to the machine that
 * started the pairing, not to whoever guessed it.
 */
export function userCode() {
  const chars = Array.from(randomBytes(8), (b) => USER_CODE_ALPHABET[b % 32]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const sha256Hex = sha256;
