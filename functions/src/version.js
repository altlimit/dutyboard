// One version, from package.json.
//
// It used to be written out three times — package.json, the /health response, and the MCP
// serverInfo — and two of those were copies nobody would think to update at release. A
// version that lies is worse than no version: it is the first thing anyone reads when
// deciding whether a bug is already fixed.
//
// esbuild substitutes the literal at bundle time (see functions/build.mjs). The `typeof`
// guard is what lets these files still be imported directly by tooling that does not go
// through the bundler — scripts/smoke.mjs reads the route table that way — where the
// define does not exist and "dev" is the honest answer.
export const VERSION = typeof __DUTYBOARD_VERSION__ === "string" ? __DUTYBOARD_VERSION__ : "dev";

/** Whether release `a` is older than release `b`. A build with no release number is never older. */
export function olderRelease(a, b) {
  const parse = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "")) || []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
