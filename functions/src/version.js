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
