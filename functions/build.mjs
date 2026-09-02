#!/usr/bin/env node
// Bundle functions/src into the single self-contained ES module the functions service
// takes. The service does no bundling and resolves no imports, so this is not an
// optimisation step — it is the only thing that turns these files into something
// deployable.
//
// Bundling here rather than server-side also means an import that does not resolve
// fails now, with a filename and a line number, instead of after a deploy.

import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist", "bundle.js");

// The platform's own cap. Hitting it means a dependency crept in that should not have.
const MAX_BYTES = 1024 * 1024;

await mkdir(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "src", "index.js")],
  outfile,
  bundle: true,
  format: "esm",
  // Workers, not Node: no filesystem, no process, no npm at runtime.
  platform: "neutral",
  target: "es2022",
  minify: false, // a readable stack in the error groups is worth more than the bytes
  legalComments: "none",
});

const { size } = await stat(outfile);
if (size > MAX_BYTES) {
  console.error(`✖ bundle is ${(size / 1024).toFixed(0)} KiB — the limit is 1024 KiB`);
  process.exit(1);
}
console.log(`✔ functions/dist/bundle.js  ${(size / 1024).toFixed(1)} KiB`);
