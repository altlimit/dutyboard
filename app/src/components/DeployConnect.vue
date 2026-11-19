<script setup>
// The deploy key, from the board's settings: each of your machines that works this board, whether it
// can deploy to altengine, and a Connect that has it sign in with altengine for exactly the targets
// its boards deploy to. The machine keeps the key; nothing secret comes through here. The address a
// browser ends on is pasted back only when the consent page was opened somewhere the machine's
// loopback cannot be reached, and it is useless without what the machine kept.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../lib/altengine.js";

const props = defineProps({ projectId: { type: String, required: true } });

const machines = ref([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const following = ref({}); // request_id → request
const pasted = ref({}); // request_id → value

const KEY = "deploy_key";
const SENT = "Sent — connecting…";
const itemOf = (m) => (m.readiness?.items || []).find((it) => it.key === KEY) || null;
const requestOf = (m) =>
  Object.values(following.value).find((r) => r.machine_id === m.machine_id) ||
  (m.requests || []).find((r) => r.kind === "sign_in" && r.tool === KEY && (r.status === "pending" || r.status === "running"));
const mine = computed(() => machines.value.filter((m) => (m.links || []).some((l) => l.project_id === props.projectId)));

function statusOf(m) {
  const it = itemOf(m);
  if (!it) return { tone: "unknown", text: m.online ? "has not said yet — it checks within a minute of starting" : "offline" };
  if (it.state === "ok") return { tone: "ok", text: it.detail || "connected" };
  return { tone: "todo", text: it.detail || "not connected" };
}
const canConnect = (m) => m.online && (itemOf(m)?.actions || []).includes("sign_in");
function whyNot(m) {
  if (!m.online) return `${m.name} is offline`;
  if (!itemOf(m)) return `${m.name} has not reported what it needs yet`;
  return `${m.name} cannot connect from here — run dutyboard --deploy-key on it (an emulator, or an older dutyboard)`;
}

async function load() {
  try {
    const res = await api("/machines/list");
    machines.value = res.machines || [];
    const add = {};
    for (const m of machines.value) {
      for (const r of m.requests || []) {
        if (r.kind === "sign_in" && r.tool === KEY && (r.status === "pending" || r.status === "running") && !following.value[r.request_id]) add[r.request_id] = r;
      }
    }
    if (Object.keys(add).length) following.value = { ...following.value, ...add };
  } catch (err) {
    error.value = err.message;
  } finally {
    loaded.value = true;
  }
}

async function connect(m) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const { request } = await api("/machine/request", { machine_id: m.machine_id, kind: "sign_in", tool: KEY });
    following.value = { ...following.value, [request.request_id]: request };
    notice.value = `Asked ${m.name} to connect. The link to open shows here in a moment.`;
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
    following.value = { ...following.value, [r.request_id]: { ...r, prompt: { ...r.prompt, needs_input: false, message: SENT } } };
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
        if (r.prompt && r.prompt.message === SENT && request.prompt && request.prompt.needs_input) request.prompt = r.prompt;
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
  // Its checklist line changes once it has checked itself again.
  if (finished) setTimeout(load, 2500);
}

let timer = null;
onMounted(() => {
  load();
  timer = setInterval(follow, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section aria-labelledby="deploy-connect-h" class="panel stack">
    <h2 id="deploy-connect-h" style="margin: 0">Deploying to altengine</h2>
    <p class="muted small" style="margin: 0">
      Each machine that works this board deploys with an altengine key of its own, kept on that machine. Connect has it
      sign in with altengine for the targets saved above — write on each site, full on each functions instance, and
      nothing else. Save first if you have just changed them; connect again after adding one.
    </p>
    <p v-if="notice" class="notice" role="status" style="margin: 0">{{ notice }}</p>
    <p v-if="error" class="notice notice--error" role="alert" style="margin: 0">{{ error }}</p>

    <p v-if="loaded && !mine.length" class="small muted" style="margin: 0">
      None of your machines works this board. A machine's owner connects it from its line here, or from the Machines page.
    </p>
    <ul v-else class="ready__list">
      <li v-for="m in mine" :key="m.machine_id" :class="`ready__item ready__item--${statusOf(m).tone}`">
        <span class="ready__mark" aria-hidden="true">{{ statusOf(m).tone === "ok" ? "✓" : statusOf(m).tone === "todo" ? "!" : "?" }}</span>
        <div>
          <strong>{{ m.name }}</strong>
          <span class="small muted"> — {{ statusOf(m).text }}</span>

          <div v-if="requestOf(m)" class="ready__work stack">
            <template v-for="r in [requestOf(m)]" :key="r.request_id">
              <p class="small" style="margin: 0" role="status">
                Connecting… <span class="muted">{{ r.status === "pending" ? `waiting for ${m.name} to start` : "" }}</span>
              </p>
              <template v-if="r.prompt && r.prompt.url">
                <p class="small" style="margin: 0">{{ r.prompt.message }}</p>
                <p style="margin: 0">
                  <a :href="r.prompt.url" target="_blank" rel="noopener noreferrer" class="btn">Open altengine</a>
                </p>
                <form v-if="r.prompt.needs_input" class="row" @submit.prevent="sendInput(r)">
                  <label class="sr-only" :for="`deploy-paste-${r.request_id}`">Address the page ended on</label>
                  <input
                    :id="`deploy-paste-${r.request_id}`"
                    v-model="pasted[r.request_id]"
                    class="mono"
                    autocomplete="off"
                    placeholder="Only if it would not load: paste its address"
                  />
                  <button type="submit" :disabled="busy || !(pasted[r.request_id] || '').trim()">Send</button>
                </form>
              </template>
            </template>
          </div>
          <div v-else class="row" style="margin-top: 0.3rem">
            <button type="button" :disabled="busy || !canConnect(m)" :title="canConnect(m) ? '' : whyNot(m)" @click="connect(m)">
              {{ statusOf(m).tone === "ok" ? "Connect again" : "Connect" }}<span class="sr-only"> {{ m.name }} to altengine</span>
            </button>
            <span v-if="!canConnect(m)" class="small muted">{{ whyNot(m) }}</span>
            <span v-else-if="m.remote_setup === 'ask'" class="small muted">someone at {{ m.name }} accepts it by running <code class="mono">dutyboard</code> there</span>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ready__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.ready__item { display: grid; grid-template-columns: 1.4rem 1fr; gap: 0.4rem; align-items: start; }
.ready__mark { font-weight: 700; text-align: center; }
.ready__item--ok .ready__mark { color: var(--ok); }
.ready__item--todo .ready__mark { color: var(--warn); }
.ready__item--optional .ready__mark,
.ready__item--unknown .ready__mark { color: var(--text-dim); }
.ready__work { margin-top: 0.4rem; padding: 0.6rem; border: 1px solid var(--border); border-radius: 6px; }
.ready__work input { flex: 1 1 14rem; min-width: 0; }
</style>
