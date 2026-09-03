#!/usr/bin/env node
// Bundle functions/src into the single self-contained ES module the functions service
// takes. The service does no bundling and resolves no imports, so this is not an
// optimisation step — it is the only thing that turns these files into something
// deployable.
//
// Bundling here rather than server-side also means an import that does not resolve
// fails now, with a filename and a line number, instead of after a deploy.

import { build } from "esbuild";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist", "bundle.js");

// The platform's own cap. Hitting it means a dependency crept in that should not have.
const MAX_BYTES = 1024 * 1024;

// package.json is the single source of the version; see functions/src/version.js.
const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

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
  define: { __DUTYBOARD_VERSION__: JSON.stringify(pkg.version) },
});

const { size } = await stat(outfile);
if (size > MAX_BYTES) {
  console.error(`✖ bundle is ${(size / 1024).toFixed(0)} KiB — the limit is 1024 KiB`);
  process.exit(1);
}

// The platform resolves NO imports. A bundle carrying one deploys fine and then fails at
// the first request, in production, with a module error — so it is checked here, where the
// answer is a filename instead of an incident. esbuild only leaves an import behind for
// something it could not bundle (a bare specifier it was told to keep external, a URL), and
// that is exactly the mistake worth catching.
const code = await readFile(outfile, "utf8");
const leftover = [...code.matchAll(/^\s*(?:import\s[^;]*?from\s*|import\s*)["']([^"']+)["']/gm)].map((m) => m[1]);
if (leftover.length) {
  console.error(`✖ bundle still imports: ${[...new Set(leftover)].join(", ")}`);
  console.error(`  The functions service resolves no imports — everything must be inlined.`);
  process.exit(1);
}
if (!/export\s*\{[^}]*\bas default\b|export default/.test(code)) {
  console.error("✖ bundle has no default export — the service expects `export default { fetch }`");
  process.exit(1);
}
console.log(`✔ functions/dist/bundle.js  ${(size / 1024).toFixed(1)} KiB`);
