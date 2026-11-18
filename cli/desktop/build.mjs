#!/usr/bin/env node
// Builds DutyBoard for the desktop: cli/desktop/dist/DutyBoard-Desktop.exe.
//
//   node cli/desktop/build.mjs                    # version from package.json
//   node cli/desktop/build.mjs --version 2.31.0 --out release/DutyBoard-Desktop.exe
//
// Windows only for now, and from any machine: Wails needs no cgo there, so this cross-compiles from
// Linux as the CLI does. Everything is built in the order the next step needs it —
//
//   1. the typed bindings the window's TypeScript imports, from the Go services;
//   2. the window itself (frontend/dist), which the binary embeds;
//   3. the Windows resources (icon, manifest, version) as a .syso the linker picks up;
//   4. the binary.
//
// The function and console a binary provisions are embedded too when they have been staged
// (scripts/stage-cli-assets.mjs), exactly as for the CLI; without them it downloads them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const version = (arg("--version") || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).replace(/^v/, "");
const arch = arg("--arch") || "amd64";
const out = resolve(arg("--out") || join(here, "dist", "DutyBoard-Desktop.exe"));
// Windows wants four numbers; a version's pre-release tail ("-rc.1") is not one of them.
const [major = "0", minor = "0", patch = "0"] = version.split("-")[0].split(".");
const version4 = `${+major}.${+minor}.${+patch}.0`;

const target = { ...process.env, GOOS: "windows", GOARCH: arch, CGO_ENABLED: "0" };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, a, opt = {}) => execFileSync(cmd, a, { cwd: here, stdio: "inherit", ...opt });

console.log(`DutyBoard desktop ${version} (windows/${arch})`);

// The Wails tool, at the version go.mod pins, built for THIS machine — which is why it is built to a
// file rather than run with `go tool`: under GOOS=windows that would build a Windows tool on Linux.
// Without cgo, because with it the Linux build wants WebKitGTK's headers for a window this never opens.
const { GOOS: _os, GOARCH: _arch, ...host } = process.env;
const wails3 = join(here, "dist", ".tools", process.platform === "win32" ? "wails3.exe" : "wails3");
run("go", ["build", "-o", wails3, "github.com/wailsapp/wails/v3/cmd/wails3"], { env: { ...host, CGO_ENABLED: "0" } });

// 1. Bindings are read for the target, since the services are compiled for it.
run(wails3, ["generate", "bindings", "-ts", "-d", "frontend/bindings"], { env: target });

// 2. The window.
const frontend = join(here, "frontend");
const shell = process.platform === "win32"; // npm is a .cmd there
if (!existsSync(join(frontend, "node_modules"))) run(npm, ["ci", "--no-audit", "--no-fund"], { cwd: frontend, shell });
run(npm, ["run", "build"], { cwd: frontend, shell });

// 3. Resources. One .syso per architecture, named so Go links it into that build only.
const tmp = mkdtempSync(join(tmpdir(), "dutyboard-desktop-"));
try {
  const fill = (name) => {
    const p = join(tmp, name);
    writeFileSync(p, readFileSync(join(here, "build", "windows", name), "utf8").replaceAll("{{VERSION4}}", version4).replaceAll("{{VERSION}}", version));
    return p;
  };
  run(wails3, ["generate", "syso", "-arch", arch, "-icon", join("build", "windows", "icon.ico"), "-manifest", fill("wails.exe.manifest"), "-info", fill("info.json"), "-out", `wails_windows_${arch}.syso`], { env: host });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 4. The binary. `production` is Wails' release mode (no dev tools, the embedded runtime), and
// windowsgui is what makes it an app rather than a console program.
mkdirSync(dirname(out), { recursive: true });
run("go", ["build", "-tags", "production", "-trimpath", "-buildvcs=false", "-ldflags", `-w -s -H windowsgui -X github.com/altlimit/dutyboard/cli/internal/app.Version=${version}`, "-o", out, "."], { env: target });
console.log(`\n  ✓ ${out}`);
