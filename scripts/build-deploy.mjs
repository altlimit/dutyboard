#!/usr/bin/env node
// Build what "Deploy to altengine" deploys: a folder with DutyBoard's manifest, its function and its
// console, every file named by URL relative to the manifest and pinned by its sha256.
//
//   npm run build:fn && npm run build:app && node scripts/build-deploy.mjs [--out dist/deploy]
//
// The folder is published per release at https://www.dutyboard.com/deploy/v<version>/ (and
// /deploy/latest/), and a deploy link points at its altengine.json:
//
//   https://console.altengine.net/deploy?manifest=https%3A%2F%2Fwww.dutyboard.com%2Fdeploy%2Flatest%2Faltengine.json
//
// Whoever opens it signs in to altengine, picks an organization, and deploys or upgrades their own
// DutyBoard as themselves. Nothing here holds a key.
//
// What the manifest declares is what the `dutyboard` provisioner made with the API, and under the
// same names, so a deployment it made can be adopted by the link and upgraded from then on:
//
//   <app>          datastore, functions (the `board` function)
//   <app>-auth     auth           <app>-live     channel        <app>-files    blob
//   <app>-search   search         <app>-tasks    tasks          <app>-console  static (the console)
//
// Some fields here are not in altengine's manifest yet — `suffix`, `initialConfig`, and the
// `${key:origin}` / `${key:url}` references. They are what DutyBoard asked the platform for; see
// cli/internal/provision for what each replaces.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const out = join(root, flag("--out", "dist/deploy"));

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const bundle = join(root, "functions/dist/bundle.js");
const consoleDir = join(root, "app/dist");
for (const [what, p] of [["the function (npm run build:fn)", bundle], ["the console (npm run build:app)", join(consoleDir, "index.html")]]) {
  if (!existsSync(p)) {
    console.error(`missing ${what}: ${relative(root, p)}`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "console"), { recursive: true });

// --- the function -----------------------------------------------------------------------------
// The bundle as it is: the instance names it uses come from env (see functions/src/index.js), not
// from a line written in front of it as the provisioner did.
const code = readFileSync(bundle);
writeFileSync(join(out, "board.mjs"), code);

// --- the console ------------------------------------------------------------------------------
// The built app, plus what the provisioner added beside it. Its config.js says nothing; the console
// then reads /altengine.json, which altengine generates (runtimeConfig below). See app/src/runtime.js.
cpSync(consoleDir, join(out, "console"), { recursive: true });
writeFileSync(join(out, "console/agent.md"), readFileSync(join(root, "agent/OPERATING.md")));
// Consoles used to live under /app, and links to them carry the route after the #.
mkdirSync(join(out, "console/app"), { recursive: true });
writeFileSync(
  join(out, "console/app/index.html"),
  `<!doctype html><meta charset="utf-8"><title>DutyBoard</title><script>location.replace("../" + location.hash)</script><a href="../">DutyBoard</a>`,
);

function files(dir, base = dir, acc = {}) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, base, acc);
    else {
      const bytes = readFileSync(p);
      acc["/" + relative(base, p).split("\\").join("/")] = { hash: sha256(bytes), size: bytes.length };
    }
  }
  return acc;
}
const site = files(join(out, "console"));

// --- the data ---------------------------------------------------------------------------------
const declared = json("backend/indexes.json");
const indexes = [];
for (const [collection, specs] of Object.entries(declared)) {
  if (collection.startsWith("_")) continue;
  for (const s of specs) indexes.push({ collection, fields: s.fields, ...(s.unique ? { unique: true } : {}) });
}
const access = json("backend/access.json")["datastore:dutyboard"];
const signup = json("backend/signup.json");

// The browsers' push services: the function may reach these and nothing else. In step with
// PUSH_HOSTS in functions/src/webpush.js.
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "*.notify.windows.com"];

const manifest = {
  altengine: 1,
  name: "dutyboard",
  title: "DutyBoard",
  description: "A board of duties that AI agents work on your own machines, with you deciding what ships.",
  version,
  homepage: "https://www.dutyboard.com",
  instances: {
    datastore: {
      service: "datastore",
      config: { autoId: "uuid", autoIndex: true },
      indexes,
    },
    // Presence is how the console knows a machine is online.
    live: { service: "channel", config: { presence: true } },
    auth: {
      service: "auth",
      suffix: "auth",
      config: {
        // Read-only row rules for the console: every write goes through the function.
        access: { "datastore:${datastore}": access },
        settings: { allowedOrigins: ["${console:origin}"] },
      },
      // Only for a new deployment: the first person to sign up becomes its first owner. An owner who
      // closes sign-up later keeps it closed through every upgrade.
      initialConfig: { settings: { allowSignup: true }, signup },
    },
    files: { service: "blob" },
    search: { service: "search", suffix: "search" },
    tasks: {
      service: "tasks",
      suffix: "tasks",
      queues: {
        // A token's webhook deliveries. No target: each task names the URL it is for. In step with
        // WEBHOOK_QUEUE in functions/src/webhooks.js.
        webhooks: {
          mode: "push",
          target: null,
          retry: { maxAttempts: 10, minBackoffSeconds: 10, maxBackoffSeconds: 3600, maxAgeSeconds: 86400 },
          maxConcurrent: 10,
          deadlineSeconds: 30,
        },
      },
    },
    functions: {
      service: "functions",
      env: {
        DUTYBOARD_DATASTORE: "${datastore}",
        DUTYBOARD_AUTH: "${auth}",
        DUTYBOARD_CHANNEL: "${live}",
        DUTYBOARD_BLOB: "${files}",
        DUTYBOARD_SEARCH: "${search}",
        DUTYBOARD_TASKS: "${tasks}",
        // The functions instance is named exactly the app: how an upgrade link names what it updates.
        DUTYBOARD_APP: "${functions}",
        // Where a machine being paired sends a person to approve it.
        DUTYBOARD_CONSOLE_URL: "${console:url}",
      },
      config: { corsOrigins: ["${console:origin}"], allowedHosts: PUSH_HOSTS },
      functions: {
        board: {
          module: { url: "./board.mjs", sha256: sha256(code) },
          grants: {
            "datastore:${datastore}": "full",
            "auth:${auth}": "write",
            "channel:${live}": "write",
            "blob:${files}": "full",
            "search:${search}": "full",
            "tasks:${tasks}": "write",
          },
          // The board's own clock: recurring duties are filed when nobody is at a keyboard.
          schedules: ["* * * * *"],
          // A machine's poll asks a handful of calls per board it works, and works up to 25 boards.
          subRequests: 500,
        },
      },
    },
    console: {
      service: "static",
      site: { base: "./console/", files: site },
      runtimeConfig: { path: "/altengine.json", expose: ["datastore", "auth", "live", "functions"] },
    },
  },
};

writeFileSync(join(out, "altengine.json"), JSON.stringify(manifest, null, 2) + "\n");
const kib = (n) => `${Math.round(n / 1024)} KiB`;
const siteBytes = Object.values(site).reduce((n, f) => n + f.size, 0);
console.log(`DutyBoard v${version} → ${relative(root, out)}/`);
console.log(`  altengine.json   ${Object.keys(manifest.instances).length} instances, ${indexes.length} indexes`);
console.log(`  board.mjs        ${kib(code.length)}`);
console.log(`  console/         ${Object.keys(site).length} files, ${kib(siteBytes)}`);
