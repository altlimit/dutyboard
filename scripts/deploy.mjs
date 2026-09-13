#!/usr/bin/env node
// Deploy the bundled function.
//
// This is the same thing `altengine deploy` does, kept in the repo so a deploy is one
// npm script with the instance names this app actually uses already filled in.
//
//   ALTENGINE_KEY=ak_… npm run deploy
//   ALTENGINE_URL=http://127.0.0.1:9191 ALTENGINE_KEY=dev npm run deploy   # emulator
//
// The key needs `full` on the functions instance: a deploy replaces the code that runs
// with that instance's capabilities, which is more than writing data through them.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const URL_BASE = (process.env.ALTENGINE_URL || "https://api.altengine.net").replace(/\/+$/, "");
const KEY = process.env.ALTENGINE_KEY || "";
const FN_INSTANCE = process.env.DUTYBOARD_FN_INSTANCE || "dutyboard";
// `board`, not `api`: the hosted platform reserves `api` as a function name (its own
// console makes relative calls to /api/auth/* from a page that could be served on a
// function host) and refuses the deploy. The emulator does not, so the name has to be
// right here or the first hosted deploy is where you find out.
const FN_NAME = process.env.DUTYBOARD_FN_NAME || "board";
const DS = process.env.DUTYBOARD_DATASTORE || "dutyboard";
const AUTH = process.env.DUTYBOARD_AUTH || "dutyboard-auth";
const CHANNEL = process.env.DUTYBOARD_CHANNEL || "dutyboard-live";
const BLOB = process.env.DUTYBOARD_BLOB || "dutyboard-files";
const SEARCH = process.env.DUTYBOARD_SEARCH || "dutyboard-search";

if (!KEY) {
  console.error("✖ set ALTENGINE_KEY to an API key with 'full' on the functions instance");
  process.exit(1);
}

// The blast radius of this function, and nothing wider.
//   datastore full  — it deletes duties, threads and whole boards; delete sits above write
//   auth      write — verifyToken, and setClaims: adding someone to a board writes the
//                     `boards` claim their browser's reads are scoped by (functions/src/members.js)
//   channel   read  — publish plus subscribe-token minting, neither of which writes state
//   blob      full  — minting an upload URL is a write, and deleting an attachment (or a
//                     whole board) has to remove the object, which sits above write
//   search    full  — indexing a finished duty is a write, and deleting a board's documents
//                     is a delete, which sits above it
const grants = {
  [`datastore:${DS}`]: "full",
  [`auth:${AUTH}`]: "write",
  [`channel:${CHANNEL}`]: "write",
  [`blob:${BLOB}`]: "full",
  [`search:${SEARCH}`]: "full",
};

const code = await readFile(join(root, "functions", "dist", "bundle.js"), "utf8").catch(() => {
  console.error("✖ functions/dist/bundle.js not found — run `npm run build:fn` first");
  process.exit(1);
});

const res = await fetch(`${URL_BASE}/v1/functions/${encodeURIComponent(FN_INSTANCE)}/deploy`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ name: FN_NAME, code, grants, activate: true }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`✖ deploy failed (${res.status}): ${text}`);
  process.exit(1);
}
const out = JSON.parse(text);
console.log(`✔ deployed ${FN_NAME} v${out.version} to functions instance '${FN_INSTANCE}' (${out.size_bytes} bytes)`);
console.log(`  grants: ${Object.entries(grants).map(([k, v]) => `${k}=${v}`).join(" ")}`);

/**
 * Where it actually answers — ASKED, not guessed.
 *
 * This used to print `https://<instance>-fn.altengine.app/<fn>`, which is wrong on any
 * instance created since slugs were minted: the subdomain is a random label, not the name.
 * The first hosted deploy of this app printed a host that 404s, and that string is the one
 * thing here a person copies into VITE_API_URL. The listing endpoint knows the host, so it
 * is one more call and no guesswork.
 */
const local = URL_BASE.includes("127.0.0.1") || URL_BASE.includes("localhost");
if (local) {
  console.log(`  URL:    ${URL_BASE}/fn/${FN_INSTANCE}/${FN_NAME}`);
} else {
  const listed = await fetch(`${URL_BASE}/v1/functions/${encodeURIComponent(FN_INSTANCE)}`, {
    headers: { authorization: `Bearer ${KEY}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const url = (listed?.functions || []).find((f) => f.name === FN_NAME)?.url;
  console.log(url ? `  URL:    ${url}` : `  URL:    on subdomain '${listed?.host || "(ask the console)"}'`);
  console.log(`  Point the console at it with VITE_API_URL — the subdomain is minted, not the instance name.`);
}
