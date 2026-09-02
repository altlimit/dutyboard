<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { STATUS_COLUMNS, PRIORITIES, ago } from "../lib/duties.js";
import DutyCard from "../components/DutyCard.vue";

const props = defineProps({ projectId: { type: String, required: true } });

const PAGE = 50;

const board = ref(null);
const columns = ref(Object.fromEntries(STATUS_COLUMNS.map((c) => [c.key, { rows: [], cursor: null, loading: true }])));
const agents = ref([]);
const error = ref("");
const liveState = ref("connecting");
const showForm = ref(false);
const draft = ref({ title: "", brief: "", priority: "next" });
const adding = ref(false);

let socket = null;
let refreshTimer = null;

/** `{key, data, created, updated}` from the wire, flattened into one object. */
const flat = (doc) => ({ ...doc.data, key: String(doc.key) });

async function loadColumn(status, { append = false } = {}) {
  const col = columns.value[status];
  col.loading = true;
  try {
    const res = await query("duties", {
      where: [
        { field: "project_id", op: "=", value: props.projectId },
        { field: "status", op: "=", value: status },
      ],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: PAGE,
      cursor: append ? col.cursor || undefined : undefined,
    });
    const rows = (res.documents || []).map(flat);
    col.rows = append ? [...col.rows, ...rows] : rows;
    // A cursor means there is more. Saying so is the point: a column silently capped at
    // 50 looks exactly like a column with 50 things in it.
    col.cursor = rows.length === PAGE ? res.cursor : null;
  } catch (err) {
    error.value = err.message;
  } finally {
    col.loading = false;
  }
}

async function loadAgents() {
  try {
    const res = await query("agents", {
      where: [{ field: "project_id", op: "=", value: props.projectId }],
      order: [{ field: "last_seen_at", dir: "desc" }],
      limit: 10,
    });
    agents.value = (res.documents || []).map(flat);
  } catch {
    /* the agent strip is decoration — a board without it is still a board */
  }
}

async function loadAll() {
  error.value = "";
  await Promise.all([...STATUS_COLUMNS.map((c) => loadColumn(c.key)), loadAgents()]);
}

async function loadBoard() {
  try {
    const res = await query("projects", { where: [{ field: "__key__", op: "=", value: props.projectId }], limit: 1 });
    board.value = (res.documents || []).map(flat)[0] || null;
  } catch (err) {
    error.value = err.message;
  }
}

/** Live events name a duty and a status, but a move is two columns changing at once and
 *  several can land together. Coalescing into one refresh is both simpler and cheaper
 *  than trying to patch rows in place from a payload that deliberately carries no data. */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadAll();
  }, 400);
}

function connect() {
  if (socket) socket.close();
  socket = subscribeLive(
    { projectId: props.projectId },
    () => scheduleRefresh(),
    (s) => (liveState.value = s),
  );
}

async function addDuty() {
  adding.value = true;
  error.value = "";
  try {
    await api("/duty/enqueue", {
      project_id: props.projectId,
      title: draft.value.title,
      brief: draft.value.brief,
      priority: draft.value.priority,
    });
    draft.value = { title: "", brief: "", priority: "next" };
    showForm.value = false;
    await loadAll();
  } catch (err) {
    error.value = err.message;
  } finally {
    adding.value = false;
  }
}

const needsYou = computed(() => columns.value.needs_decision.rows.length);

watch(
  () => props.projectId,
  () => {
    loadBoard();
    loadAll();
    connect();
  },
  { immediate: true },
);

onMounted(() => {});
onUnmounted(() => {
  if (socket) socket.close();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>{{ board ? board.name : projectId }}</h1>
        <p class="muted small mono" style="margin: 0">{{ projectId }}</p>
      </div>
      <div class="row">
        <span
          class="livedot"
          :class="`livedot--${liveState}`"
          role="status"
          :aria-label="liveState === 'live' ? 'Live updates connected' : `Live updates ${liveState}`"
        >
          {{ liveState === "live" ? "Live" : liveState }}
        </span>
        <button type="button" @click="loadAll">Refresh</button>
        <button class="primary" type="button" @click="showForm = !showForm" :aria-expanded="showForm">
          {{ showForm ? "Cancel" : "Add duty" }}
        </button>
      </div>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <p v-if="needsYou" class="notice notice--warn" role="status">
      {{ needsYou }} {{ needsYou === 1 ? "duty is" : "duties are" }} waiting on an answer from you. Agents have
      already moved on to other work — answering puts each one back at the front of the queue.
    </p>

    <form v-if="showForm" class="panel stack" @submit.prevent="addDuty">
      <h2>Add a duty</h2>
      <div class="field">
        <label for="d-title">Title</label>
        <input id="d-title" v-model="draft.title" required maxlength="200" placeholder="Configure the auth provider" />
      </div>
      <div class="field">
        <label for="d-brief">Brief</label>
        <textarea
          id="d-brief"
          v-model="draft.brief"
          required
          maxlength="4000"
          placeholder="What needs doing, and what done looks like."
        ></textarea>
        <p class="hint">An agent may pick this up with no other context. Write it for that reader.</p>
      </div>
      <div class="field">
        <label for="d-priority">Priority</label>
        <select id="d-priority" v-model="draft.priority">
          <option v-for="p in PRIORITIES" :key="p.key" :value="p.key">{{ p.label }} — {{ p.hint }}</option>
        </select>
      </div>
      <div>
        <button class="primary" type="submit" :disabled="adding || !draft.title || !draft.brief">
          {{ adding ? "Adding…" : "Add to the queue" }}
        </button>
      </div>
    </form>

    <section v-if="agents.length" aria-labelledby="agents-h">
      <h2 id="agents-h" class="sr-only">Agents on this board</h2>
      <p class="row small muted">
        <span v-for="a in agents" :key="a.key" class="badge">
          {{ a.agent_id }} · {{ a.active_duty_id ? "working" : "idle" }} · seen {{ ago(a.last_seen_at) }}
        </span>
      </p>
    </section>

    <div class="board">
      <section v-for="col in STATUS_COLUMNS" :key="col.key" class="column" :aria-labelledby="`col-${col.key}`">
        <div class="column__head">
          <h2 :id="`col-${col.key}`" style="margin: 0; font-size: 0.95rem">{{ col.label }}</h2>
          <span class="column__count">{{ columns[col.key].rows.length }}{{ columns[col.key].cursor ? "+" : "" }}</span>
        </div>
        <p class="sr-only">{{ col.hint }}</p>

        <ul class="column__list">
          <li v-for="duty in columns[col.key].rows" :key="duty.key">
            <DutyCard :duty="duty" :project-id="projectId" />
          </li>
        </ul>

        <p v-if="columns[col.key].loading" class="muted small" style="margin-top: 0.5rem">Loading…</p>
        <p v-else-if="!columns[col.key].rows.length" class="muted small" style="margin-top: 0.5rem">Nothing here.</p>

        <button
          v-if="columns[col.key].cursor"
          type="button"
          style="margin-top: 0.5rem; width: 100%"
          @click="loadColumn(col.key, { append: true })"
        >
          Load more
        </button>
      </section>
    </div>
  </div>
</template>
