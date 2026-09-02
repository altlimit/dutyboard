<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { STATUS_COLUMNS, PRIORITIES, ago } from "../lib/duties.js";
import BoardColumn from "../components/BoardColumn.vue";

const props = defineProps({ projectId: { type: String, required: true } });

/** One page of a column. Small enough that a busy column does not bury the four next to
 *  it, and every card fetched is a card rendered: "Show more" fetches the next page rather
 *  than revealing rows that were already here, which is a control that pretends to do
 *  something. */
const PAGE = 12;
/**
 * One page of the WHOLE board, read in a single query and sorted into columns here.
 *
 * Opening a board used to cost six queries — one per status, including `failed`, which has
 * to be asked about even when it is empty, because "is it empty" is the question. Almost
 * every board fits in one page, and one page read once is the same rows.
 *
 * Over this many duties there is no honest way to do it in one request: a mixed page would
 * let a busy column starve the others, so each column goes back to its own top-N and its
 * own cursor. The cost of being wrong about which case you are in is one extra query.
 */
const BOARD_PAGE = 60;
/** How deep a refresh will re-read a column that someone has paged into. Bounded, because
 *  this runs on every event an agent produces. */
const MAX_DEPTH = 120;

/** Below this the board stops being columns and becomes one column behind chips. Wide
 *  enough that six columns still get ~170px each, which is the point where a title stops
 *  fitting on two lines. */
const WIDE = "(min-width: 1080px)";

const board = ref(null);
const columns = ref({});
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

const resetColumns = () => {
  columns.value = Object.fromEntries(
    STATUS_COLUMNS.map((c) => [c.key, { rows: [], cursor: null, loading: true }]),
  );
};
resetColumns();

/** `{key, data, created, updated}` from the wire, flattened into one object. */
const flat = (doc) => ({ ...doc.data, key: String(doc.key) });

async function loadColumn(status, { append = false } = {}) {
  const col = columns.value[status];
  // A refresh re-reads as deep as the column already goes. Re-reading one page instead
  // would collapse a column someone had expanded, every time any agent did anything.
  const limit = append ? PAGE : Math.min(Math.max(PAGE, col.rows.length), MAX_DEPTH);
  col.loading = true;
  try {
    const res = await query("duties", {
      where: [
        { field: "project_id", op: "=", value: props.projectId },
        { field: "status", op: "=", value: status },
      ],
      order: [{ field: "updated_at", dir: "desc" }],
      limit,
      cursor: append ? col.cursor || undefined : undefined,
    });
    const rows = (res.documents || []).map(flat);
    col.rows = append ? [...col.rows, ...rows] : rows;
    // A full page means there may be another. Saying so is the point: a column silently
    // capped looks exactly like a column with that many things in it.
    col.cursor = rows.length === limit ? res.cursor : null;
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

/** Sort one page of the whole board into columns. Rows arrive newest-first, so each
 *  column comes out newest-first without sorting again. A status not in STATUS_COLUMNS
 *  cannot occur — those six are the whole enum — and would be dropped if it did. */
function bucket(rows) {
  const next = Object.fromEntries(
    STATUS_COLUMNS.map((c) => [c.key, { rows: [], cursor: null, loading: false }]),
  );
  for (const duty of rows) if (next[duty.status]) next[duty.status].rows.push(duty);
  columns.value = next;
}

/** Reload some columns, or all of them when `keys` is empty.
 *
 *  `agents` is separate because only a transition touches an agent row — claiming, or
 *  parking a duty releases whoever held it — and enqueueing never does. */
async function refresh(keys, { agents = true } = {}) {
  error.value = "";
  const cols = keys && keys.size ? [...keys] : STATUS_COLUMNS.map((c) => c.key);
  await Promise.all([...cols.map((k) => loadColumn(k)), ...(agents ? [loadAgents()] : [])]);
}

/** The whole board: one query if it fits, six if it does not. */
async function loadAll() {
  error.value = "";
  let rows;
  try {
    const res = await query("duties", {
      where: [{ field: "project_id", op: "=", value: props.projectId }],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: BOARD_PAGE,
    });
    rows = (res.documents || []).map(flat);
  } catch (err) {
    // Falling back to six more queries here would just fail six more times.
    error.value = err.message;
    return;
  }
  if (rows.length < BOARD_PAGE) {
    bucket(rows);
    await loadAgents();
    return;
  }
  await refresh(null);
}

async function loadBoard() {
  try {
    const res = await query("projects", { where: [{ field: "__key__", op: "=", value: props.projectId }], limit: 1 });
    board.value = (res.documents || []).map(flat)[0] || null;
  } catch (err) {
    error.value = err.message;
  }
}

/** Which column currently shows this duty, if any. A move is two columns changing — the
 *  one it went to, which the event names, and the one it came from, which only we know. */
function columnHolding(dutyKey) {
  for (const c of STATUS_COLUMNS) {
    if (columns.value[c.key].rows.some((d) => d.key === dutyKey)) return c.key;
  }
  return null;
}

/**
 * Coalesce events into one refresh of only the columns they touch.
 *
 * Several events land together — an interrupt moves a parent and creates a child — so
 * they are collected for a moment and then read once. Refreshing the whole board instead
 * meant six queries for every single thing any agent did, on every open tab.
 */
let touched = new Set();
function scheduleRefresh(frame) {
  const ev = frame && frame.data;
  if (!ev || !ev.id) {
    touched = null; // an event we do not understand: re-read everything rather than guess
  } else if (touched) {
    const from = columnHolding(ev.id);
    if (from) touched.add(from);
    if (ev.status && columns.value[ev.status]) touched.add(ev.status);
  }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const keys = touched;
    touched = new Set();
    refresh(keys);
  }, 400);
}

function connect() {
  if (socket) socket.close();
  socket = subscribeLive(
    { projectId: props.projectId },
    (frame) => scheduleRefresh(frame),
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
    // A new duty is queued, by definition — no other column can have changed, so no other
    // column needs re-reading.
    await refresh(new Set(["queued"]), { agents: false });
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
        :project-id="projectId"
        @more="loadColumn($event, { append: true })"
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
        :project-id="projectId"
        standalone
        @more="loadColumn($event, { append: true })"
      />
    </template>
  </div>
</template>
