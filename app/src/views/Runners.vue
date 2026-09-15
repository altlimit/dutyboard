<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../lib/altengine.js";
import { config } from "../config.js";
import { ago } from "../lib/duties.js";
import { runStateLabel } from "../lib/runners.js";

// Your machines: the computers running `dutyboard` for you, what each is working on, and the
// controls that are the program's settings — there is no settings file to edit on the machine.

const machines = ref([]);
const boards = ref([]);
const loading = ref(true);
const error = ref("");
const busy = ref(false);
const notice = ref("");
const setupFor = ref({}); // machine_id → { project_id, path }

const installCommand = computed(() => `alt install altlimit/dutyboard\ndutyboard --server ${config.api} --root /path/for/projects`);

async function load({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  error.value = "";
  try {
    const [m, b] = await Promise.all([api("/machines/list"), api("/projects/list")]);
    machines.value = m.machines || [];
    boards.value = [...(b.projects || []), ...(b.shared || [])];
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
onMounted(() => {
  load();
  timer = setInterval(() => {
    if (!document.hidden && !busy.value) load({ quiet: true });
  }, 10_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>Your machines</h1>
        <p class="muted" style="margin: 0">
          Computers running <code class="mono">dutyboard</code> for you. Each one claims duties from the boards
          linked to it and works them with the board's agent — Claude Code or Codex — in a git worktree of its own.
        </p>
        <p class="small" style="margin: 0.4rem 0 0">
          API URL, for pairing a machine: <code class="mono">{{ config.api }}</code>
          <button type="button" class="link small" @click="copy(config.api)">Copy</button>
        </p>
      </div>
      <router-link class="btn" :to="{ name: 'pair' }">Pair a machine</router-link>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <section v-else-if="!machines.length" class="panel stack" aria-labelledby="first-h">
      <h2 id="first-h" style="margin: 0">Add your first machine</h2>
      <p style="margin: 0">On the computer that should do the work, with Claude Code or Codex installed and signed in:</p>
      <pre class="token" style="white-space: pre-wrap">{{ installCommand }}</pre>
      <div><button type="button" @click="copy(installCommand)">Copy</button></div>
      <p class="small muted" style="margin: 0">
        It prints a code and opens this console to approve it. Then choose which boards it works — here, or on a
        board's settings. It clones each board's repository into its projects folder.
      </p>
    </section>

    <ul v-else class="machines">
      <li v-for="m in machines" :key="m.machine_id" class="panel stack">
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

        <ul v-if="m.requests.length" class="runs small">
          <li v-for="r in m.requests" :key="r.request_id">Setting up {{ r.project_id }} in <span class="mono">{{ r.path }}</span>: {{ r.status }}</li>
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
