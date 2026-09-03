#!/usr/bin/env node
// Serve public/ the way a static host has to serve it.
//
//   npm run build && npm run preview          # http://127.0.0.1:4173
//
// Not a dev server: no watching, no transforms, no module graph. It serves the built
// bytes, which is the point — `npm run dev` already tells you whether the code works, and
// what this answers instead is whether the DEPLOYMENT works.
//
// The whole reason it exists is one rule. The console is a single-page app under /app, so
// every path below it has to return /app/index.html with a 200 — not a redirect, and not
// a 404. A host that does not do that serves the board's own URLs as "not found" the first
// time anyone reloads one, and nothing in a dev server will ever show you that. This is
// the local stand-in for that rule until the static service that applies it exists.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  // /agent.md is a documented URL, and octet-stream would make a browser download the
  // operating protocol rather than show it.
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** A readable file at this path, or null. Directories resolve to their index.html. */
async function resolve(pathname) {
  // normalize() collapses `..`, and the prefix check is what stops a crafted path from
  // reading outside public/ — this serves a directory to whoever connects, so it does not
  // get to assume the client is the browser we shipped.
  const candidate = normalize(join(root, decodeURIComponent(pathname)));
  if (candidate !== root && !candidate.startsWith(root + "/")) return null;
  const info = await stat(candidate).catch(() => null);
  if (info?.isDirectory()) return resolve(pathname.replace(/\/*$/, "/") + "index.html");
  return info?.isFile() ? candidate : null;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  let file = await resolve(pathname);

  // THE REWRITE. Only for /app, and only for a request that looks like a page rather than
  // a missing asset: answering a 404 script with index.html turns a clear failure into a
  // syntax error in the console.
  if (!file && pathname.startsWith("/app/") && !extname(pathname)) {
    file = await resolve("/app/index.html");
  }

  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`404 ${pathname}\n`);
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[extname(file)] || "application/octet-stream",
    // Served for inspection, not for speed. A cached copy of the thing you just rebuilt is
    // the one way this could lie to you.
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`public/ → http://${host}:${port}`);
  console.log(`  marketing site  http://${host}:${port}/`);
  console.log(`  console         http://${host}:${port}/app/`);
});
