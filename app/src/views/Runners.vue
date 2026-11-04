<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../lib/altengine.js";
import { config } from "../config.js";
import { ago } from "../lib/duties.js";
import { runStateLabel } from "../lib/runners.js";
import { CONSOLE_VERSION, differs, serviceVersion } from "../lib/version.js";

// Your machines: the computers running `dutyboard` for you, what each is working on, and the
// controls that are the program's settings — there is no settings file to edit on the machine.

const machines = ref([]);
const boards = ref([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const notice = ref("");
const setupFor = ref({}); // machine_id → { project_id, path }

// The three halves of a DutyBoard — this console, the board function, and each machine — are
// released together and updated separately. When one lags, the symptom is a feature that is simply
// missing, which is a slow thing to work out from the outside. So they are put side by side.
const boardVersion = ref("");
const behind = computed(() => {
  const out = [];
  if (differs(CONSOLE_VERSION, boardVersion.value)) out.push("the board itself");
  for (const m of machines.value) if (differs(m.cli_version, CONSOLE_VERSION)) out.push(m.name);
  return out;
});

const consoleVersion = CONSOLE_VERSION;
const installCommand = "alt install altlimit/dutyboard\ndutyboard";
const headlessCommand = computed(() => `alt install altlimit/dutyboard\ndutyboard --server ${config.api} --root /path/for/projects --service`);

// `dutyboard` in a terminal ends by opening this page on the machine it just set up: #/machines?setup=<id>.
const route = useRoute();
const focus = computed(() => String(route.query.setup || ""));

// What duties need from a machine, as it last said: the items its boards wait on first, then the rest.
const readiness = (m) => (m.readiness && m.readiness.items) || [];
const waitingOn = (m) => readiness(m).filter((it) => it.needed && it.state === "todo");
const shown = (m) => {
  const items = readiness(m);
  // With no board on it yet, every agent is worth seeing: the first board picks one.
  if (!m.links.length) return items;
  return items.filter((it) => it.needed || it.state === "ok");
};
const unneeded = (m) => (m.links.length ? readiness(m).filter((it) => !it.needed && it.state !== "ok") : []);
const mark = (state) => (state === "ok" ? "✓" : state === "todo" ? "!" : "?");

// Installs and sign-ins asked for from here, followed until they finish: an open one shows on its
// checklist line — the link to open, the code to enter, a field for what to paste back.
const following = ref({}); // request_id → request
const toolRequest = (m, key) =>
  Object.values(following.value).find((r) => r.machine_id === m.machine_id && r.tool === key) ||
  (m.requests || []).find((r) => r.tool === key && (r.kind === "install_tool" || r.kind === "sign_in"));
const pasted = ref({}); // request_id → value
const openSetups = (m) => (m.requests || []).filter((r) => r.kind === "setup" || r.kind === "create_repo");

async function toolWork(m, it, kind) {
  const verb = kind === "install_tool" ? "Install" : "Sign in to";
  if (kind === "install_tool" && !confirm(`Install ${it.label} on ${m.name}? It runs ${it.label}'s own installer there, as you.`)) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const { request } = await api("/machine/request", { machine_id: m.machine_id, kind, tool: it.key });
    following.value = { ...following.value, [request.request_id]: request };
    notice.value = `${verb} ${it.label}: asked ${m.name}.${kind === "sign_in" ? " The link to open shows here in a moment." : ""}`;
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function sendInput(r) {
  const value = (pasted.value[r.request_id] || "").trim();
  if (!value) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/machine/request/input", { request_id: r.request_id, value });
    pasted.value = { ...pasted.value, [r.request_id]: "" };
    following.value = { ...following.value, [r.request_id]: { ...r, prompt: { ...r.prompt, needs_input: false, message: "Sent — signing in…" } } };
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function follow() {
  const open = Object.values(following.value).filter((r) => r.status === "pending" || r.status === "running");
  if (!open.length) return;
  const next = { ...following.value };
  let finished = false;
  await Promise.all(
    open.map(async (r) => {
      try {
        const { request } = await api("/machine/request/get", { request_id: r.request_id });
        // A value just sent is not shown as asked for again while the machine picks it up.
        if (r.prompt && r.prompt.message === "Sent — signing in…" && request.prompt && request.prompt.needs_input) request.prompt = r.prompt;
        next[r.request_id] = request;
        if (request.status === "done" || request.status === "failed") {
          finished = true;
          if (request.status === "done") notice.value = `Done: ${request.result}.`;
          else error.value = request.result || "It did not work.";
          delete next[r.request_id];
        }
      } catch {
        /* the next pass tries again */
      }
    }),
  );
  following.value = next;
  if (finished) setTimeout(() => load({ quiet: true }), 2500);
}

function checkAgain(m) {
  act(() => api("/machines/retry", { machine_id: m.machine_id }), `Asked ${m.name} to check again — its answer shows here in a few seconds.`);
  setTimeout(() => load({ quiet: true }), 8000);
}

async function load({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  error.value = "";
  try {
    const [m, b] = await Promise.all([api("/machines/list"), api("/projects/list")]);
    machines.value = m.machines || [];
    boards.value = [...(b.projects || []), ...(b.shared || [])];
    // An install or sign-in already under way — asked for in another tab, or before a reload — is
    // followed like one asked for here.
    const add = {};
    for (const mm of machines.value) {
      for (const r of mm.requests || []) {
        if ((r.kind === "install_tool" || r.kind === "sign_in") && !following.value[r.request_id]) add[r.request_id] = r;
      }
    }
    if (Object.keys(add).length) following.value = { ...following.value, ...add };
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function act(fn, message) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
    notice.value = message || "";
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const update = (m, change, message) => act(() => api("/machines/update", { machine_id: m.machine_id, ...change }), message);

function revoke(m) {
  if (!confirm(`Revoke ${m.name}? It stops working at once and forgets every board. Running it again pairs it as a new machine.`)) return;
  act(() => api("/machines/revoke", { machine_id: m.machine_id }), `${m.name} is revoked.`);
}

function retry(m, link) {
  act(
    () => api("/machines/retry", { machine_id: m.machine_id, project_id: link.project_id }),
    `Asked ${m.name} to check ${link.project_id} again — its answer shows here in a few seconds.`,
  );
  setTimeout(() => load({ quiet: true }), 8000);
}

function unlink(m, link) {
  if (!confirm(`Take ${m.name} off ${link.project_id}? Duties it is working on there stay held until it is linked again or someone moves them.`)) return;
  act(() => api("/machines/unlink", { machine_id: m.machine_id, project_id: link.project_id }), `${m.name} no longer works ${link.project_id}.`);
}

function requestSetup(m) {
  const req = setupFor.value[m.machine_id] || {};
  act(
    () => api("/machine/request", { machine_id: m.machine_id, project_id: req.project_id }),
    `Asked ${m.name} to work ${req.project_id}. If it is online it clones the repository and starts within a minute.`,
  );
  setupFor.value[m.machine_id] = {};
}

const draft = (m) => (setupFor.value[m.machine_id] ||= { project_id: "", path: "" });
const unlinkedBoards = (m) => boards.value.filter((b) => !m.links.some((l) => l.project_id === b.project_id));

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = "Copied.";
  } catch {
    /* selectable on screen anyway */
  }
}

// Machines span boards, and a person watches this page rather than one board's channel, so it
// re-reads on a short interval while it is open — and only while the tab is visible.
let timer = null;
onMounted(async () => {
  await load();
  if (focus.value) {
    await nextTick();
    document.getElementById(`machine-${focus.value}`)?.scrollIntoView({ block: "start" });
  }
  serviceVersion().then((v) => (boardVersion.value = v));
  timer = setInterval(() => {
    if (!document.hidden && !busy.value) load({ quiet: true });
  }, 10_000);
  // A sign-in in progress moves faster than that: a link, then a code, then done.
  fast = setInterval(() => {
    if (!document.hidden) follow();
  }, 2_000);
});
let fast = null;
onUnmounted(() => {
  clearInterval(timer);
  clearInterval(fast);
});
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>Your machines</h1>
        <p class="muted" style="margin: 0">
          Computers running <code class="mono">dutyboard</code> for you. Each one claims duties from the boards
          linked to it and works them with the board's agent — Claude Code, Codex or Cursor — in a git worktree of its own.
        </p>
        <p class="small" style="margin: 0.4rem 0 0">
          API URL, for pairing a machine: <code class="mono">{{ config.api }}</code>
          <button type="button" class="link small" @click="copy(config.api)">Copy</button>
        </p>
      </div>
      <router-link class="btn" :to="{ name: 'pair' }">Pair a machine</router-link>
    </div>

    <section aria-labelledby="versions-h" class="panel stack">
      <h2 id="versions-h" style="margin: 0">Versions</h2>
      <p class="small muted" style="margin: 0">
        Console <strong>{{ consoleVersion }}</strong> ·
        board <strong>{{ boardVersion || "…" }}</strong>
        <template v-for="m in machines" :key="m.machine_id">
          · {{ m.name }} <strong>{{ m.cli_version || "?" }}</strong>
        </template>
      </p>
      <p v-if="behind.length" class="hint" style="margin: 0">
        Not everything is on {{ consoleVersion }}: {{ behind.join(", ") }}. A feature that is missing
        rather than broken is usually this. Update a machine where it runs; update the board and this
        console with <code class="mono">dutyboard --provision-only</code>.
      </p>
      <p v-else-if="boardVersion" class="hint" style="margin: 0">Everything here is on {{ consoleVersion }}.</p>
    </section>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <section v-else-if="!machines.length" class="panel stack" aria-labelledby="first-h">
      <h2 id="first-h" style="margin: 0">Add your first machine</h2>
      <p style="margin: 0">On the computer that should do the work:</p>
      <pre class="token" style="white-space: pre-wrap">{{ installCommand }}</pre>
      <div><button type="button" @click="copy(installCommand)">Copy</button></div>
      <p class="small muted" style="margin: 0">
        It asks which DutyBoard to connect to, prints a code to approve here, sets itself to start by itself and comes
        back to this page, which then shows what the machine still needs: Claude Code, Codex or Cursor signed in, the
        GitHub CLI, a commit author.
      </p>
      <details>
        <summary class="small">A machine with no screen — a server, or over SSH</summary>
        <pre class="token" style="white-space: pre-wrap">{{ headlessCommand }}</pre>
        <div><button type="button" @click="copy(headlessCommand)">Copy</button></div>
        <p class="small muted" style="margin: 0">
          It prints the code and a link, waits for you to approve it here, sets itself to start at boot, and exits. Then
          choose which boards it works — here, or on a board's settings.
        </p>
      </details>
    </section>

    <ul v-else class="machines">
      <li v-for="m in machines" :id="`machine-${m.machine_id}`" :key="m.machine_id" class="panel stack" :class="{ 'machine--focus': focus === m.machine_id }">
        <div class="row row--between">
          <div>
            <h2 style="margin: 0">
              {{ m.name }}
              <span class="livedot" :class="m.online ? 'livedot--live' : 'livedot--off'">
                {{ m.online === null ? "presence unknown" : m.online ? "online" : "offline" }}
              </span>
              <span v-if="m.paused" class="badge badge--needs_decision">paused</span>
            </h2>
            <p class="small muted" style="margin: 0">
              {{ m.os }} {{ m.arch }} · dutyboard {{ m.cli_version || "?" }} · agents
              <span class="mono">{{ m.agent_prefix }}/…</span> · seen {{ m.last_seen_at ? ago(m.last_seen_at) : "never" }}
            </p>
          </div>
          <div class="row">
            <button type="button" :disabled="busy" @click="update(m, { paused: !m.paused }, m.paused ? `${m.name} resumed.` : `${m.name} paused: it starts nothing new until resumed.`)">
              {{ m.paused ? "Resume" : "Pause" }}
            </button>
            <button type="button" class="danger" :disabled="busy" @click="revoke(m)">Revoke</button>
          </div>
        </div>

        <p v-if="focus === m.machine_id" class="notice" role="status" style="margin: 0">
          <template v-if="m.online">{{ m.name }} is paired and running.</template>
          <template v-else>{{ m.name }} is paired; it shows as online once <code class="mono">dutyboard</code> runs there.</template>
          Below is what duties need from it. Put a board on it under <em>Settings and setup</em>, or from a board's settings.
        </p>

        <section class="ready stack" :aria-labelledby="`ready-h-${m.machine_id}`">
          <div class="row row--between">
            <h3 :id="`ready-h-${m.machine_id}`" style="margin: 0">
              What duties need from it
              <span v-if="m.readiness && waitingOn(m).length" class="badge badge--needs_decision">{{ waitingOn(m).length }} to fix</span>
            </h3>
            <span class="small muted">
              <template v-if="m.readiness">checked {{ ago(m.readiness.checked_at) }} · </template>
              <button type="button" class="link small" :disabled="busy" @click="checkAgain(m)">Check again</button>
            </span>
          </div>
          <p v-if="!m.readiness" class="small muted" style="margin: 0">
            {{ m.online ? "Not reported yet. A machine checks within a minute of starting; one running an older dutyboard never does — update it." : "Shown once it is online." }}
          </p>
          <ul v-else class="ready__list">
            <li v-for="it in shown(m)" :key="it.key" :class="`ready__item ready__item--${it.state}`">
              <span class="ready__mark" aria-hidden="true">{{ mark(it.state) }}</span>
              <div>
                <strong>{{ it.label }}</strong>
                <span class="sr-only">: {{ it.state === "ok" ? "ready" : it.state === "todo" ? "needs fixing" : "unknown" }}</span>
                <span v-if="it.boards && it.boards.length" class="small muted"> — for {{ it.boards.join(", ") }}</span>
                <p v-if="it.detail" class="small" style="margin: 0.1rem 0 0">{{ it.detail }}</p>
                <p v-if="it.fix && it.state !== 'ok' && !toolRequest(m, it.key)" class="small" style="margin: 0.2rem 0 0">
                  On {{ m.name }}: <code class="mono">{{ it.fix }}</code>
                  <button type="button" class="link small" @click="copy(it.fix)">Copy</button>
                </p>
                <p v-else-if="it.fix && it.state === 'ok'" class="small muted" style="margin: 0.2rem 0 0">Worth doing: <code class="mono">{{ it.fix }}</code></p>

                <div v-if="toolRequest(m, it.key)" class="ready__work stack">
                  <template v-for="r in [toolRequest(m, it.key)]" :key="r.request_id">
                    <p class="small" style="margin: 0" role="status">
                      {{ r.kind === "install_tool" ? "Installing" : "Signing in" }}…
                      <span class="muted">{{ r.status === "pending" ? `waiting for ${m.name} to start` : "" }}</span>
                    </p>
                    <template v-if="r.prompt && r.prompt.url">
                      <p class="small" style="margin: 0">{{ r.prompt.message }}</p>
                      <p style="margin: 0">
                        <a :href="r.prompt.url" target="_blank" rel="noopener noreferrer" class="btn">Open the sign-in page</a>
                      </p>
                      <p v-if="r.prompt.code" style="margin: 0">
                        Code: <code class="mono ready__code">{{ r.prompt.code }}</code>
                        <button type="button" class="link small" @click="copy(r.prompt.code)">Copy</button>
                      </p>
                      <form v-if="r.prompt.needs_input" class="row" @submit.prevent="sendInput(r)">
                        <label class="sr-only" :for="`paste-${r.request_id}`">Code from the sign-in page</label>
                        <input :id="`paste-${r.request_id}`" v-model="pasted[r.request_id]" class="mono" autocomplete="off" placeholder="Paste the code the page shows" />
                        <button type="submit" :disabled="busy || !(pasted[r.request_id] || '').trim()">Send</button>
                      </form>
                    </template>
                  </template>
                </div>
                <div v-else-if="it.actions && it.actions.length && it.state === 'todo'" class="row" style="margin-top: 0.3rem">
                  <button
                    v-if="it.actions.includes('install')"
                    type="button"
                    :disabled="busy || !m.online"
                    :title="m.online ? '' : `${m.name} is offline`"
                    @click="toolWork(m, it, 'install_tool')"
                  >
                    Install<span class="sr-only"> {{ it.label }}</span>
                  </button>
                  <button
                    v-if="it.actions.includes('sign_in')"
                    type="button"
                    :disabled="busy || !m.online"
                    :title="m.online ? '' : `${m.name} is offline`"
                    @click="toolWork(m, it, 'sign_in')"
                  >
                    Sign in<span class="sr-only"> to {{ it.label }}</span>
                  </button>
                  <span v-if="m.remote_setup === 'ask'" class="small muted">someone at {{ m.name }} accepts it by running <code class="mono">dutyboard</code> there</span>
                </div>
              </div>
            </li>
          </ul>
          <p v-if="unneeded(m).length" class="small muted" style="margin: 0">
            Not needed by its boards: {{ unneeded(m).map((it) => it.label).join(", ") }}.
          </p>
        </section>

        <div v-if="m.links.length" class="tablewrap">
          <table>
            <caption class="sr-only">Boards {{ m.name }} works</caption>
            <thead>
              <tr>
                <th scope="col">Board</th>
                <th scope="col">Folder</th>
                <th scope="col">Now</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in m.links" :key="l.project_id">
                <td><router-link :to="{ name: 'board', params: { projectId: l.project_id } }">{{ l.project_id }}</router-link></td>
                <td class="mono small">{{ l.path_hint || "—" }}</td>
                <td>
                  <p v-if="l.problem" class="notice notice--warn small" style="margin: 0 0 0.3rem">{{ l.problem }}</p>
                  <p v-if="l.notice" class="notice small" style="margin: 0 0 0.3rem">{{ l.notice }}</p>
                  <button v-if="l.problem || l.notice" type="button" class="link small" :disabled="busy" @click="retry(m, l)">
                    Retry now<span class="sr-only"> for {{ l.project_id }}</span>
                  </button>
                  <span v-if="!l.runs.length" class="muted">idle</span>
                  <ul v-else class="runs">
                    <li v-for="r in l.runs" :key="r.duty_id">
                      <router-link :to="{ name: 'duty', params: { projectId: l.project_id, dutyId: r.duty_id } }" class="mono small">{{ r.duty_id }}</router-link>
                      {{ runStateLabel(r.state) }}<span v-if="r.detail" class="muted small"> — {{ r.detail }}</span>
                    </li>
                  </ul>
                </td>
                <td><button type="button" class="link small" :disabled="busy" @click="unlink(m, l)">Unlink</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted small" style="margin: 0">No boards linked yet.</p>

        <ul v-if="openSetups(m).length" class="runs small">
          <li v-for="r in openSetups(m)" :key="r.request_id">
            Setting up {{ r.project_id }} in <span class="mono">{{ r.path }}</span>: {{ r.status }}
            <span v-if="r.status === 'pending' && m.remote_setup === 'ask'" class="muted">
              — waiting for someone at {{ m.name }} to run <code class="mono">dutyboard</code> there and accept it
            </span>
          </li>
        </ul>

        <details>
          <summary>Settings and setup</summary>
          <div class="stack" style="margin-top: 0.75rem">
            <form class="stack" @submit.prevent="requestSetup(m)">
              <div class="field">
                <label :for="`s-board-${m.machine_id}`">Work a board on this machine</label>
                <select :id="`s-board-${m.machine_id}`" v-model="draft(m).project_id" required>
                  <option value="" disabled>Choose a board</option>
                  <option v-for="b in unlinkedBoards(m)" :key="b.project_id" :value="b.project_id">{{ b.name }} ({{ b.project_id }})</option>
                </select>
              </div>
              <p class="hint" style="margin: 0">It clones the board's repository into its projects folder and starts on its duties.</p>
              <div><button type="submit" :disabled="busy || !draft(m).project_id">Work this board</button></div>
            </form>

            <div class="field">
              <label :for="`s-max-${m.machine_id}`">Sessions at once</label>
              <input :id="`s-max-${m.machine_id}`" type="number" min="1" max="10" :value="m.max_sessions" @change="update(m, { max_sessions: Number($event.target.value) }, 'Saved.')" />
              <p class="hint">Across every board. Claude's plan limits are shared, so more sessions use them up faster.</p>
            </div>
            <div class="field">
              <label :for="`s-remote-${m.machine_id}`">Setups asked for here</label>
              <select :id="`s-remote-${m.machine_id}`" :value="m.remote_setup" @change="update(m, { remote_setup: $event.target.value }, 'Saved.')">
                <option value="auto">Happen automatically</option>
                <option value="ask">Wait for someone at the machine</option>
              </select>
            </div>
          </div>
        </details>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.machine--focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.ready { border-top: 1px solid var(--border, rgba(127, 127, 127, 0.25)); padding-top: 0.75rem; }
.ready__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.ready__item { display: grid; grid-template-columns: 1.4rem 1fr; gap: 0.4rem; align-items: start; }
.ready__mark { font-weight: 700; text-align: center; }
.ready__item--ok .ready__mark { color: var(--ok); }
.ready__item--todo .ready__mark { color: var(--warn); }
.ready__item--unknown .ready__mark { color: var(--text-dim); }
.ready code { overflow-wrap: anywhere; }
.ready code + .link { margin-left: 0.4rem; }
.ready__work { margin-top: 0.4rem; padding: 0.6rem; border: 1px solid var(--border); border-radius: 6px; }
.ready__code { font-size: 1.15rem; letter-spacing: 0.08em; }
.ready__work input { flex: 1 1 14rem; min-width: 0; }
</style>
