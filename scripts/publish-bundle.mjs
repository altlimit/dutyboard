// Put the function bundle where an agent can fetch it: https://www.dutyboard.com/board.js
//
// `functions_deploy` takes the code INLINE — the platform bundles nothing and resolves no
// imports — so an agent provisioning DutyBoard from llms.txt needs one self-contained ES
// module at a stable URL. That is exactly what `npm run build:fn` already produces; this
// only copies it into the published site.
//
// It runs AFTER `build:site`, because sitegen builds with -clean and would delete it.
//
// This is a supply-chain position: whatever is here is what other people deploy into their
// own altengine accounts. It is byte-identical to `npm run build:fn` from the repo, which
// is the only reason it is reasonable to ask anyone to run it.

import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "functions", "dist", "bundle.js");
const to = join(root, "public", "board.js");

try {
  statSync(from);
} catch {
  console.error("✖ functions/dist/bundle.js not found — run `npm run build:fn` first");
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`✔ public/board.js  ${(statSync(to).size / 1024).toFixed(1)} KiB`);
