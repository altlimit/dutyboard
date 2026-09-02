<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { STATUS_COLUMNS, PRIORITIES, ago } from "../lib/duties.js";
import BoardColumn from "../components/BoardColumn.vue";

const props = defineProps({ projectId: { type: String, required: true } });

/** How much of a column is fetched at once, and how much of that is rendered before you
 *  ask for more. They are different numbers on purpose: the query is cheap and paging it
 *  costs a round trip, but a column that renders forty cards buries the four columns next
 *  to it — on a phone it buries the whole board. */
const PAGE = 50;
const FIRST = 8;
const STEP = 12;

/** Below this the board stops being columns and becomes one column behind chips. Wide
 *  enough that six columns still get ~170px each, which is the point where a title stops
 *  fitting on two lines. */
const WIDE = "(min-width: 1080px)";

const board = ref(null);
const columns = ref({});
const shown = ref({});
const agents = ref([]);
const error = ref("");
const liveState = ref("connecting");
const showForm = ref(false);
const draft = ref({ title: "", brief: "", priority: "next" });
const adding = ref(false);

// The phone layout's current column. `picked` stays null until someone chooses, so the
// default can follow the board (see `focusColumn`) without overriding a real choice.
const picked = ref(null);

const wideQuery = window.matchMedia(WIDE);
const wide = ref(wideQuery.matches);
const onWidth = (e) => (wide.value = e.matches);
wideQuery.addEventListener("change", onWidth);

let socket = null;
let refreshTimer = null;

const blank = () => Object.fromEntries(STATUS_COLUMNS.map((c) => [c.key, { rows: [], cursor: null, loading: true }]));
const resetColumns = () => {
  columns.value = blank();
  shown.value = Object.fromEntries(STATUS_COLUMNS.map((c) => [c.key, FIRST]));
};
resetColumns();

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

/** Show more of one column, fetching another page only when the loaded rows run out. */
function showMore(key) {
  shown.value[key] += STEP;
  const col = columns.value[key];
  if (shown.value[key] > col.rows.length && col.cursor) loadColumn(key, { append: true });
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

const count = (key) => columns.value[key].rows.length;
const needsYou = computed(() => count("needs_decision"));

/** Which columns to render at all.
 *
 *  `failed` is hidden while it is empty. It is a real state an agent can reach and it
 *  needs somewhere to appear — but on most boards it never happens, and a permanently
 *  empty sixth column costs every other column a fifth of its width. */
const shownColumns = computed(() => STATUS_COLUMNS.filter((c) => !c.whenUsed || count(c.key) > 0));

/** The phone layout's column: whatever was chosen, else the one that wants a person. */
const focusColumn = computed(() => {
  if (picked.value && shownColumns.value.some((c) => c.key === picked.value)) return picked.value;
  return needsYou.value ? "needs_decision" : "queued";
});

watch(
  () => props.projectId,
  () => {
    resetColumns();
    picked.value = null;
    loadBoard();
    loadAll();
    connect();
  },
  { immediate: true },
);

onUnmounted(() => {
  wideQuery.removeEventListener("change", onWidth);
  if (socket) socket.close();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="wrap wrap--board stack">
    <div class="row row--between">
      <div>
        <h1>{{ board ? board.name : projectId }}</h1>
        <p class="row small muted" style="margin: 0; gap: 0.6rem">
          <span class="mono">{{ projectId }}</span>
          <span
            class="livedot"
            :class="`livedot--${liveState}`"
            role="status"
            :aria-label="liveState === 'live' ? 'Live updates connected' : `Live updates ${liveState}`"
          >
            {{ liveState === "live" ? "Live" : liveState }}
          </span>
        </p>
      </div>
      <div class="row board-actions">
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

    <form v-if="showForm" class="panel panel--form stack" @submit.prevent="addDuty">
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
      <p class="row small muted" style="margin: 0">
        <span v-for="a in agents" :key="a.key" class="badge">
          {{ a.agent_id }} · {{ a.active_duty_id ? "working" : "idle" }} · seen {{ ago(a.last_seen_at) }}
        </span>
      </p>
    </section>

    <!-- Wide: every column at once, sharing the window. -->
    <div v-if="wide" class="board" :style="{ '--cols': shownColumns.length }">
      <BoardColumn
        v-for="col in shownColumns"
        :key="col.key"
        :col="col"
        :state="columns[col.key]"
        :shown="shown[col.key]"
        :project-id="projectId"
        @more="showMore"
      />
    </div>

    <!-- Narrow: one column, chosen. -->
    <template v-else>
      <div class="chips" role="group" aria-label="Show a status">
        <button
          v-for="col in shownColumns"
          :key="col.key"
          type="button"
          class="chip"
          :class="{ 'chip--attention': col.key === 'needs_decision' && needsYou }"
          :aria-pressed="focusColumn === col.key"
          @click="picked = col.key"
        >
          {{ col.label }}
          <span class="chip__n">{{ count(col.key) }}{{ columns[col.key].cursor ? "+" : "" }}</span>
        </button>
      </div>

      <BoardColumn
        :col="STATUS_COLUMNS.find((c) => c.key === focusColumn)"
        :state="columns[focusColumn]"
        :shown="shown[focusColumn]"
        :project-id="projectId"
        standalone
        @more="showMore"
      />
    </template>
  </div>
</template>
