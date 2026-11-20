#!/usr/bin/env node
// Put the released deploy folders into the site, so the deploy link has something to read:
//
//   site/public/deploy/v2.37.0/altengine.json   (and board.mjs, console/…)
//   site/public/deploy/latest/…                 a copy of the newest
//
//   npm run build:site && node scripts/fetch-deploys.mjs [--keep 5] [--local dist/deploy]
//
// The site is replaced whole on every deploy, so each build brings back the recent releases' folders
// from the releases themselves (dutyboard-deploy_<version>.tar.gz, made by scripts/build-deploy.mjs
// in the release workflow). A deployment made from latest/ upgrades from latest/; the versioned
// folders are there for anyone who wants to deploy, or stay on, one release.
//
// --local adds a folder built here as latest/ — for trying a deploy before it is released.
//
// Needs only node and tar. GH_TOKEN, if set, is used for the GitHub API (it is public either way).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const keep = Number(flag("--keep", "5"));
const local = flag("--local", "");
const repo = process.env.GITHUB_REPOSITORY || "altlimit/dutyboard";
const out = join(root, "site/public/deploy");

const headers = { accept: "application/vnd.github+json", "user-agent": "dutyboard-site-build" };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function releases() {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
  if (!res.ok) throw new Error(`listing releases: ${res.status} ${await res.text()}`);
  const all = await res.json();
  const out = [];
  for (const r of all) {
    if (r.draft || r.prerelease) continue;
    const asset = (r.assets || []).find((a) => /^dutyboard-deploy_.+\.tar\.gz$/.test(a.name));
    if (asset) out.push({ version: r.tag_name.replace(/^v/, ""), url: asset.browser_download_url });
    if (out.length >= keep) break;
  }
  return out; // newest first, as GitHub lists them
}

async function unpack(url, into) {
  const res = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const tmp = mkdtempSync(join(tmpdir(), "dutyboard-deploy-"));
  const tgz = join(tmp, "deploy.tar.gz");
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", into]);
  rmSync(tmp, { recursive: true, force: true });
  if (!existsSync(join(into, "altengine.json"))) throw new Error(`${url} has no altengine.json`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let newest = null;
try {
  for (const r of await releases()) {
    await unpack(r.url, join(out, `v${r.version}`));
    newest ||= r.version;
    console.log(`  deploy/v${r.version}/`);
  }
} catch (err) {
  // A site build must not fail because GitHub was slow: the marketing pages still go out, and the
  // next build brings the deploy folders back.
  console.warn(`! could not fetch the released deploy folders: ${err.message}`);
}

if (local) {
  cpSync(join(root, local), join(out, "latest"), { recursive: true });
  const v = JSON.parse(readFileSync(join(out, "latest/altengine.json"), "utf8")).version;
  console.log(`  deploy/latest/  ← ${local} (v${v}, not released)`);
} else if (newest) {
  cpSync(join(out, `v${newest}`), join(out, "latest"), { recursive: true });
  console.log(`  deploy/latest/  = v${newest}`);
} else {
  console.warn("! no release carries a deploy folder yet: deploy/latest/ is empty");
}
