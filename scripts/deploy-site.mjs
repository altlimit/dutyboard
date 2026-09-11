#!/usr/bin/env node
// Publish public/ — marketing site and console together — to an altengine static instance.
//
//   npm run build && ALTENGINE_KEY=ak_… npm run deploy:site
//
// The same three calls `altengine static deploy` makes, kept in the repo for the same reason
// scripts/deploy.mjs is: a release should be one npm script with this app's instance names
// already filled in, and CI should run the same code a person runs by hand.
//
//   1. POST the manifest — every file's path, size and sha256. The answer says which of them
//      the platform does not already have.
//   2. PUT those, and only those, straight to storage. Files are content-addressed, so a
//      redeploy where one page changed uploads one page.
//   3. POST activate — a pointer move. Nothing is served until this call, so a half-finished
//      upload is not a broken site, it is a deployment nobody points at.
//
// HASHING HAPPENS HERE, not on the server, because the server can only tell us what it is
// missing if we tell it what we have. That is the whole reason step 2 is usually empty.
//
// Rolling back is `altengine static rollback <id>`, or the same activate call with an older
// deployment id: those files are still stored, so it costs nothing and uploads nothing.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);

const URL_BASE = (process.env.ALTENGINE_URL || "https://api.altengine.net").replace(/\/+$/, "");
const KEY = process.env.ALTENGINE_KEY || "";
const INSTANCE = flag("--instance") || process.env.DUTYBOARD_STATIC_INSTANCE || "dutyboard";
const DIR = resolve(root, flag("--dir") || process.env.DUTYBOARD_SITE_DIR || "public");
const DRY = has("--dry-run");
const NO_ACTIVATE = has("--no-activate");

// How many files are PUT at once. Enough to keep a link busy on a site of small assets, low
// enough not to look like an attack from one machine.
const PARALLEL = 8;

if (!KEY && !DRY) {
  console.error("✖ set ALTENGINE_KEY to an API key with 'write' on the static instance");
  process.exit(1);
}

/** A label for this deployment. Nobody types one on every deploy, and a list of deployments is
 *  only useful if the rows can be told apart — so the commit, and whether it was clean. */
function gitLabel() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString().trim();
    // Says the build did not come from a clean tree, which is exactly what you want to know
    // when a deployment behaves unlike the commit it claims to be.
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "";
  }
}
const MESSAGE = flag("--message") || process.env.DUTYBOARD_SITE_MESSAGE || gitLabel();

/**
 * Every file under `dir`, hashed.
 *
 * NOTHING IS SKIPPED, dotfiles least of all: `.well-known/` is where ACME challenges and
 * security.txt live, and a deploy that quietly dropped them is discovered weeks later by
 * something else failing. If it is in the build output, it is part of the site.
 *
 * A symlink is followed when it resolves inside the tree and REFUSED when it does not —
 * following one out would publish whatever it points at, which on a developer's machine is a
 * short walk from an SSH key.
 */
async function walk(dir) {
  const out = [];
  const base = resolve(dir);
  const inside = (p) => (p + sep).startsWith(base + sep);

  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const local = join(current, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const target = await realpath(local).catch(() => null);
        if (!target) throw new Error(`${relative(base, local)} is a broken symlink`);
        if (!inside(target)) {
          throw new Error(
            `${relative(base, local)} is a symlink pointing outside ${dir} (to ${target}) — ` +
              "deploying it would publish a file that is not part of this site",
          );
        }
        isDir = (await lstat(target)).isDirectory();
      }
      if (isDir) {
        await visit(local);
        continue;
      }
      const bytes = await readFile(local);
      out.push({
        path: "/" + relative(base, local).split(sep).join("/"),
        local,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(base);
  // Deterministic order, so two runs over the same tree print the same thing.
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

async function api(method, path, body) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const e = JSON.parse(text).error;
      if (e && e.message) msg = `${e.message} (${e.code})`;
    } catch {
      /* not JSON — the status line and body are all there is */
    }
    // The two answers that mean "not this altengine" rather than "you got it wrong". Worth
    // naming, because both arrive as a code that reads like a typo in the instance name.
    if (res.status === 404 && /data-plane endpoint/.test(text)) {
      throw new Error(
        `${URL_BASE} has no static service — it predates website hosting, so there is nothing ` +
          "to deploy to yet. `npm run preview` serves public/ locally in the meantime.",
      );
    }
    if (res.status === 501) {
      throw new Error(
        "the emulator does not store deployments — serve the build locally with `npm run preview`, " +
          "and point this at the hosted service (ALTENGINE_URL=https://api.altengine.net).",
      );
    }
    throw new Error(`${method} ${path} failed (${res.status}): ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

/** One presigned PUT. `content-length` is signed into the URL but cannot be set by hand in
 *  fetch — sending the whole buffer as the body is what makes it exact. */
async function put(upload, file) {
  const headers = {};
  for (const [k, v] of Object.entries(upload.required_headers || {})) {
    if (k.toLowerCase() === "content-length") continue;
    headers[k] = v;
  }
  const res = await fetch(upload.upload_url, {
    method: upload.method || "PUT",
    headers,
    body: await readFile(file.local),
  });
  if (!res.ok) throw new Error(`uploading ${file.path}: ${res.status} ${res.statusText}`);
}

/** Upload a page of files, `PARALLEL` at a time. Errors are collected rather than aborting
 *  mid-flight: a half-uploaded deployment was never activated, nothing points at it, and the
 *  next run re-uses everything that did land. */
async function putAll(uploads, byHash, onDone) {
  const queue = [...uploads];
  let firstErr = null;
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const file = byHash.get(u.path_hash);
      if (!file) {
        firstErr ||= new Error(`the platform asked for a file we do not have (${u.path_hash.slice(0, 12)}) — re-run the deploy`);
        return;
      }
      try {
        await put(u, file);
        onDone();
      } catch (err) {
        firstErr ||= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, uploads.length) }, worker));
  if (firstErr) throw firstErr;
}

const kib = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

// ---------------------------------------------------------------------------------------

const files = await walk(DIR).catch((err) => {
  console.error(`✖ ${err.message}`);
  console.error("  run `npm run build` first — public/ is the build output, and it is gitignored");
  process.exit(1);
});
if (!files.length) {
  console.error(`✖ ${DIR} is empty — run \`npm run build\``);
  process.exit(1);
}

const total = files.reduce((n, f) => n + f.size, 0);
// One entry per distinct hash: a file at two paths is one upload.
const byHash = new Map(files.map((f) => [f.hash, f]));
console.log(`${files.length} files, ${kib(total)} in ${relative(root, DIR) || "."}`);

// The console is a single-page app under /app, and its router uses hash URLs precisely so
// that no host-side rewrite is needed. `spa: true` on a static instance serves the ROOT
// index.html for any miss, which here would answer /app/anything with the marketing page —
// so this deployment wants it off, which is the default. See README, "The one rewrite it
// needs".
if (!files.some((f) => f.path === "/app/index.html")) {
  console.log("  note: no /app/index.html — this build has the site but not the console");
}

if (DRY) {
  console.log("(dry run — nothing uploaded; the platform decides which of these it already has)");
  process.exit(0);
}

const manifest = Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }]));
const created = await api("POST", `/v1/static/${encodeURIComponent(INSTANCE)}/deployments`, {
  files: manifest,
  ...(MESSAGE ? { message: MESSAGE } : {}),
}).catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});

const id = created.deployment_id;
console.log(`deployment ${id}${MESSAGE ? ` (${MESSAGE})` : ""} — ${created.missing_count} of ${created.file_count} to upload`);

let uploads = created.uploads || [];
let cursor = created.cursor || null;
let done = 0;
// Until the cursor is null, not until a page comes back empty: those are the same thing
// today and only one of them is the contract.
for (;;) {
  if (uploads.length) {
    await putAll(uploads, byHash, () => {
      done += 1;
      if (done % 25 === 0) console.log(`  … ${done}/${created.missing_count}`);
    }).catch((err) => {
      console.error(`✖ ${err.message}`);
      process.exit(1);
    });
  }
  if (!cursor) break;
  // Paged on purpose: a first deploy of a large site has more missing files than one response
  // may carry, and a client that assumed one page would activate a deployment missing half
  // its files. Page until the cursor is null.
  const page = await api("GET", `/v1/static/${encodeURIComponent(INSTANCE)}/deployments/${id}/uploads?cursor=${encodeURIComponent(cursor)}`);
  uploads = page.uploads || [];
  cursor = page.cursor || null;
}
if (created.missing_count) console.log(`✔ uploaded ${done} file${done === 1 ? "" : "s"}`);
else console.log("✔ nothing to upload — the platform already had every file");

if (NO_ACTIVATE) {
  console.log(`✔ deployment ${id} is ready but NOT live (--no-activate)`);
  console.log(`  publish it with: altengine static rollback ${id}`);
  process.exit(0);
}

const live = await api("POST", `/v1/static/${encodeURIComponent(INSTANCE)}/deployments/${id}/activate`).catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
console.log(`✔ live: ${live.url || `(instance '${INSTANCE}')`} — ${live.file_count} files, ${kib(live.total_bytes)}`);
