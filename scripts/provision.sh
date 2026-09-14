#!/bin/sh
# DutyBoard — from nothing to a running board, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/altlimit/dutyboard/main/scripts/provision.sh | sh
#
# or, in a checkout:
#
#   ./scripts/provision.sh            # local emulator, everything provisioned and deployed
#   ./scripts/provision.sh --hosted   # against hosted altengine (needs ALTENGINE_KEY)
#
# What it does, in order: installs the tools (alt, then sitegen, the altengine emulator and
# the `dutyboard` binary through it), gets the source, installs the npm dependencies, starts
# the emulator if nothing is answering, builds the function, the console and the site, and has
# `dutyboard --provision-only` provision the instances and their config and deploy what was
# just built.
#
# WHY THIS IS STILL SHELL. Provisioning itself is the `dutyboard` binary (cli/), which needs
# nothing else installed. What it deploys from a checkout has to be built first, though —
# Node for the function and console, sitegen for the site — and this is the part that runs
# before any of that exists. To provision without a checkout at all:
#
#   alt install altlimit/dutyboard && dutyboard --provision-only
#
# Safe to re-run. Every step is idempotent: an instance that exists is left alone, an
# index that exists is not duplicated, and an emulator that is already up is used rather
# than restarted (so a re-run does not throw away the board you were testing on).

set -eu

# --- output -------------------------------------------------------------------------
# Colour only when stdout is a terminal — this often runs from a pipe, and escape codes
# in a CI log are noise.
if [ -t 1 ]; then B="$(printf '\033[1m')"; D="$(printf '\033[2m')"; R="$(printf '\033[0m')"
else B=""; D=""; R=""; fi

step() { printf '\n%s==>%s %s%s\n' "$B" "$R" "$B" "$1$R"; }
say()  { printf '    %s\n' "$1"; }
note() { printf '    %s%s%s\n' "$D" "$1" "$R"; }
warn() { printf '  ! %s\n' "$1" >&2; }
die()  { printf '\n  %s✖ %s%s\n' "$B" "$1" "$R" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- options ------------------------------------------------------------------------
TARGET="${DUTYBOARD_TARGET:-local}"
DIR="${DUTYBOARD_DIR:-dutyboard}"
BRANCH="${DUTYBOARD_BRANCH:-main}"
REPO="${DUTYBOARD_REPO:-https://github.com/altlimit/dutyboard.git}"
START_EMULATOR=1
RUN_SMOKE=0

usage() {
  cat <<'EOF'
DutyBoard provisioner

  ./scripts/provision.sh [options]

  --hosted            provision hosted altengine instead of a local emulator
                      (requires ALTENGINE_KEY; see the README for the two steps
                      that can only be done in the console)
  --dir DIR           where to clone, when not already in a checkout (default: ./dutyboard)
  --branch NAME       branch to clone (default: main)
  --no-start          do not start the emulator, even if nothing is answering
  --smoke             run the end-to-end smoke test when everything is up
  -h, --help          this

Environment:
  ALTENGINE_URL       API origin (default: http://127.0.0.1:9191 local, https://api.altengine.net hosted)
  ALTENGINE_KEY       API key with 'full' on the functions instance (hosted only; 'dev' locally)
  DUTYBOARD_ORIGINS   comma-separated origins the console is served from, for CORS
  GITHUB_TOKEN        raises the GitHub API rate limit, and is needed for private repos
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hosted) TARGET=hosted ;;
    --local) TARGET=local ;;
    --dir) DIR="${2:?--dir needs a path}"; shift ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift ;;
    --no-start) START_EMULATOR=0 ;;
    --smoke) RUN_SMOKE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1'" "run with --help to see what there is" ;;
  esac
  shift
done

case "$TARGET" in
  local)  ALTENGINE_URL="${ALTENGINE_URL:-http://127.0.0.1:9191}"; ALTENGINE_KEY="${ALTENGINE_KEY:-dev}" ;;
  hosted) ALTENGINE_URL="${ALTENGINE_URL:-https://api.altengine.net}"
          [ -n "${ALTENGINE_KEY:-}" ] || die "--hosted needs an API key" \
            "Create one in the console (Settings → API keys) with:" \
            "  • control access to instances and functions" \
            "  • data access to datastore, auth and channel" \
            "then:  ALTENGINE_KEY=ak_… ./scripts/provision.sh --hosted" ;;
esac
export ALTENGINE_URL ALTENGINE_KEY

printf '%sDutyBoard%s — provisioning %s (%s)\n' "$B" "$R" "$TARGET" "$ALTENGINE_URL"

# --- 1. tools -------------------------------------------------------------------------
#
# alt installs binaries from GitHub Releases into ~/.local/share/alt/bin with no sudo and
# no package manager, which is the only reason this can be one command on a machine that
# has none of these tools.
step "Tools"

ALT_BIN="${ALT_BIN:-$HOME/.local/share/alt/bin}"
case ":$PATH:" in *":$ALT_BIN:"*) ;; *) PATH="$ALT_BIN:$PATH"; export PATH ;; esac

have curl || die "curl is required"
have git || die "git is required"

if ! have alt; then
  say "installing alt…"
  curl -fsSL https://raw.githubusercontent.com/altlimit/alt/main/scripts/install.sh | sh >/dev/null \
    || die "could not install alt" "see https://github.com/altlimit/alt"
fi
say "alt        $(alt --version 2>/dev/null || echo present)"

if ! have node; then
  die "node is required (20 or newer)" \
    "It is the one thing alt cannot install for you — the build and the provisioner are Node." \
    "  https://nodejs.org  ·  or:  alt install nodejs/node   (unofficial builds vary)"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) is too old — 20 or newer is required"
say "node       $(node -v)"

# The provisioner. A release binary if there is one; otherwise `go run` from the checkout, which
# needs Go — so a machine with neither is told which to install rather than failing later.
if ! have dutyboard; then
  say "installing dutyboard…"
  alt install altlimit/dutyboard >/dev/null 2>&1 || note "no dutyboard release to install yet — will use go run"
fi
if have dutyboard; then
  say "dutyboard  $(dutyboard --version 2>/dev/null || echo present)"
elif have go; then
  say "go         $(go version | cut -d' ' -f3) (for go run ./cli/cmd/dutyboard)"
else
  die "neither dutyboard nor go is available" \
    "  alt install altlimit/dutyboard      once a release exists" \
    "  https://go.dev/dl                  to run it from this checkout"
fi

# sitegen builds the marketing site; without it `npm run build` produces only the console.
if ! have sitegen; then
  say "installing sitegen…"
  alt install altlimit/sitegen >/dev/null || die "could not install sitegen" \
    "  alt install altlimit/sitegen"
fi
say "sitegen    present"

# The emulator. Only the local target needs it, and there is no published release yet, so
# a source checkout next door is a real fallback rather than a courtesy.
if [ "$TARGET" = local ] && [ "$START_EMULATOR" = 1 ] && ! have altengine; then
  say "installing altengine…"
  if alt install altlimit/altengine >/dev/null 2>&1; then
    say "altengine  present"
  else
    warn "no altengine release to install (the repo may be private — set GITHUB_TOKEN)"
    note "will look for a source checkout instead"
  fi
fi

# --- 2. the source --------------------------------------------------------------------
step "Source"

if [ -f package.json ] && [ -f functions/src/index.js ] && grep -q '"name": "dutyboard"' package.json 2>/dev/null; then
  ROOT="$(pwd)"
  say "using this checkout: $ROOT"
elif [ -d "$DIR/.git" ]; then
  ROOT="$(cd "$DIR" && pwd)"
  say "using existing clone: $ROOT"
else
  say "cloning $REPO…"
  # Never prompt. A private repo with no credentials should fail in a second with an
  # explanation, not hang forever waiting for a password on a stdin that is this script.
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR" 2>/dev/null \
    || die "could not clone $REPO" \
      "If it is private, use SSH and make sure your key is loaded:" \
      "  DUTYBOARD_REPO=git@github.com:altlimit/dutyboard.git ./provision.sh" \
      "Or clone it yourself and run this from inside."
  ROOT="$(cd "$DIR" && pwd)"
fi
cd "$ROOT"

step "Dependencies"
# `npm ci` only for a fresh tree: it DELETES node_modules first, which is the right thing
# on a new clone and the wrong thing on a re-run in a checkout someone is working in.
if [ -f package-lock.json ] && [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >/dev/null || die "npm ci failed"
else
  npm install --no-audit --no-fund >/dev/null || die "npm install failed"
fi
say "npm packages installed"

# --- 3. the emulator ------------------------------------------------------------------
#
# Started only if nothing is already answering. `-data` keeps its state inside this
# project (gitignored), so a restart does not lose the board you were working on.
emulator_up() { curl -fsS -m 2 -o /dev/null "$ALTENGINE_URL/healthz" 2>/dev/null; }

if [ "$TARGET" = local ]; then
  step "Emulator"
  if emulator_up; then
    say "already running at $ALTENGINE_URL"
  elif [ "$START_EMULATOR" = 0 ]; then
    die "nothing answering at $ALTENGINE_URL and --no-start was given" "  altengine dev"
  else
    mkdir -p "$ROOT/.altengine"
    BIN=""
    if have altengine; then
      BIN="altengine"
    elif [ -d "$ROOT/../altenginedev/cli" ] && have go; then
      say "building the emulator from ../altenginedev/cli…"
      (cd "$ROOT/../altenginedev/cli" && go build -o "$ROOT/.altengine/altengine" ./cmd/altengine) \
        || die "could not build the emulator from source"
      BIN="$ROOT/.altengine/altengine"
    else
      die "no altengine emulator available" \
        "Either install it:        alt install altlimit/altengine" \
        "or point at a hosted org: ALTENGINE_KEY=ak_… ./scripts/provision.sh --hosted"
    fi
    say "starting: $BIN dev -data .altengine"
    nohup "$BIN" dev -data "$ROOT/.altengine" >"$ROOT/.altengine/dev.log" 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
      emulator_up && break
      sleep 1
    done
    emulator_up || die "the emulator did not come up within 30s" "  tail .altengine/dev.log"
    say "up at $ALTENGINE_URL   (log: .altengine/dev.log)"
  fi
fi

# --- 4. build, then provision and deploy it ------------------------------------------
step "Building the function, the console and the site"
npm run --silent build

step "Provisioning and deploying"
LOCAL_FLAG=""
[ "$TARGET" = local ] && LOCAL_FLAG="--local"
if have dutyboard; then
  dutyboard --provision-only $LOCAL_FLAG --source "$ROOT"
else
  (cd "$ROOT/cli" && go run ./cmd/dutyboard --provision-only $LOCAL_FLAG --source "$ROOT")
fi

if [ "$RUN_SMOKE" = 1 ] && [ "$TARGET" = local ]; then
  step "Smoke test"
  npm run --silent smoke
fi

# --- 5. what to do now ----------------------------------------------------------------
printf '\n%s✔ DutyBoard is provisioned%s\n\n' "$B" "$R"
if [ "$TARGET" = local ]; then
  say "Start everything:   taskr \"Start All\"      (or: npm run dev)"
  say "Console:            http://localhost:5173/app/"
  say "Marketing site:     http://localhost:8888/"
  say "Built output:       public/            (npm run preview serves it as production would)"
else
  say "The console is published to your static instance unless that instance serves a site"
  say "the provisioner did not publish — the output above says which."
fi
printf '\n'
