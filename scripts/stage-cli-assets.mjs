#!/usr/bin/env node
// Stage what a release binary of `dutyboard` carries into cli/internal/assets/web/, where
// `//go:embed` picks it up.
//
//   npm run build && node scripts/stage-cli-assets.mjs && (cd cli && go build ./cmd/dutyboard)
//
// The layout is the one cli/internal/assets documents, and the same layout is tarred into the
// release's dutyboard-web_<version>.tar.gz for builds that carry nothing (`go install`). Staging is
// a copy, not a build: it refuses to run on a tree that has not been built, rather than embedding a
// function or console from whenever `npm run build` last happened to run.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "cli", "internal", "assets", "web");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const need = [
  ["functions/dist/bundle.js", "npm run build:fn"],
  ["public/app/index.html", "npm run build:app"],
];
for (const [file, fix] of need) {
  if (!existsSync(join(root, file))) {
    console.error(`✖ ${file} is missing — run \`${fix}\` (or \`npm run build\`) first`);
    process.exit(1);
  }
}

// Everything but the placeholder that keeps the directory in git.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, ".keep"), "");

const copy = (from, to) => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(join(root, from), join(out, to), { recursive: true });
};
copy("functions/dist/bundle.js", "function/bundle.js");
copy("public/app", "console");
copy("agent/OPERATING.md", "agent.md");
if (existsSync(join(root, "public/llms.txt"))) copy("public/llms.txt", "llms.txt");
for (const f of ["indexes.json", "access.json", "signup.json"]) copy(`backend/${f}`, `backend/${f}`);
writeFileSync(join(out, "VERSION"), version + "\n");

console.log(`✔ staged DutyBoard v${version} for the CLI in ${out.slice(root.length + 1)}`);
