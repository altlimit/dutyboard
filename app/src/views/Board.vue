<script setup>
import { computed, onUnmounted, ref, watch } from "vue";
import { aggregate, api, query, subscribeLive } from "../lib/altengine.js";
import { STATUS_COLUMNS, PRIORITIES, ago, columnOrder, sortColumn } from "../lib/duties.js";
import BoardColumn from "../components/BoardColumn.vue";

const props = defineProps({ projectId: { type: String, required: true } });

/** One page of a column. Small enough that a busy column does not bury the four next to
 *  it, and every card fetched is a card rendered: "Show more" fetches the next page rather
 *  than revealing rows that were already here, which is a control that pretends to do
 *  something. */
const PAGE = 12;

/**
 * A board is read in two halves, because it has two halves.
 *
 * Everything that is not done is the WORKING SET: what agents are holding, what is queued
 * behind it, what is waiting on you. It is bounded by how much work is actually in flight,
 * so it is read whole, in one query, and sorted into columns here — the counts are then
 * exact and no live column needs a cursor.
 *
 * `done` is the other half, and it is the only column that grows without end. It gets its
 * own query, newest first, and pages backwards on demand. Reading it with the working set
 * is what made a month-old board expensive: it is nearly all `done`, and it was dragging
 * five other columns through a fallback that only existed because of it.
 *
 * `in` is what makes the first half one request. The datastore treats it as an equality
 * for index selection, so `project_id = X AND status in (…) ORDER BY updated_at desc` is
 * served by the (owner_uid, project_id, status, updated_at:desc) index already declared in
 * backend/indexes.json. `status != "done"` would be a range, which cannot lead an order on
 * a different field.
 */
const LIVE_STATUSES = STATUS_COLUMNS.map((c) => c.key).filter((k) => k !== "done");
/** The point past which the working set stops being read whole. Reaching it means over two
 *  hundred unfinished duties on one board, at which point a mixed page could let one column
 *  starve another and each goes back to its own top-N. */
const WORKING_SET = 200;
/** How deep a refresh will re-read a column that someone has paged into. Bounded, because
 *  this runs on every event an agent produces. */
const MAX_DEPTH = 120;

/** Below this the board stops being columns and becomes one column behind chips. Wide
 *  enough that six columns still get ~170px each, which is the point where a title stops
 *  fitting on two lines. */
const WIDE = "(min-width: 1080px)";

const board = ref(null);
const columns = ref({});
/** Set once the working set outgrows a single page, and never unset for the life of the
 *  view: a board that big does not become small again while you are looking at it, and
 *  flapping between the two shapes would make the counts jump.
 *
 *  Declared here rather than beside the function that reads it, because `resetColumns()`
 *  runs at setup time and would hit the temporal dead zone. */
const paged = ref(false);
const agents = ref([]);

/**
 * Searching finished work.
 *
 * Only offered when the deployment has it — `/board/open` says so, rather than the page
 * finding out by making a call that fails. The results are their own view rather than a
 * sixth column: what you are looking for is not on this board's columns at all, it is
 * something that was finished and forgotten, and putting it in a column would imply it is
 * live work.
 */
const searchable = ref(false);
const searchQuery = ref("");
const searching = ref(false);
const hits = ref(null);
const reindexing = ref(false);
const reindexed = ref(0);

/**
 * Index work that finished before search was turned on.
 *
 * Offered exactly where someone hits the problem — an empty result on a board that plainly
 * has finished duties — because that is the only moment the explanation makes sense. Every
 * board that existed before this feature has an empty index once, and a search that answers
 * "nothing" for the whole history you turned it on to reach is worse than no search.
 */
async function reindex() {
  reindexing.value = true;
  error.value = "";
  reindexed.value = 0;
  try {
    let cursor;
    do {
      const res = await api("/board/reindex", { project_id: props.projectId, cursor });
      reindexed.value += res.indexed;
      cursor = res.more ? res.cursor : null;
    } while (cursor);
    await runSearch();
  } catch (err) {
    error.value = err.message;
  } finally {
    reindexing.value = false;
  }
}

async function runSearch() {
  const q = searchQuery.value.trim();
  if (!q) return clearSearch();
  searching.value = true;
  error.value = "";
  try {
    const res = await api("/duty/search", { project_id: props.projectId, query: q, limit: 25 });
    hits.value = res.hits || [];
  } catch (err) {
    error.value = err.message;
    hits.value = null;
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searchQuery.value = "";
  hits.value = null;
}
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
  paged.value = false;
  columns.value = Object.fromEntries(
    STATUS_COLUMNS.map((c) => [c.key, { rows: [], cursor: null, loading: true, total: null }]),
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
      order: columnOrder(status),
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

/**
 * Move one badge, from the event that moved it.
 *
 * The four transitions that touch an agent row send the row's three visible fields with
 * them (`ag`), which is the difference between one query per live event and two. An agent
 * nobody has seen before is appended rather than ignored: its first claim is exactly when
 * it should appear on the board.
 */
function applyAgent(ag) {
  if (!ag || !ag.id) return;
  const next = [...agents.value];
  const at = next.findIndex((a) => a.agent_id === ag.id);
  const row = { ...(at >= 0 ? next[at] : { agent_id: ag.id }), active_duty_id: ag.active, last_seen_at: ag.seen };
  if (at >= 0) next[at] = row;
  else next.push(row);
  // The strip is ordered by last_seen_at, and this event is by definition the newest.
  agents.value = next.sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
}

/** A full re-read of the strip. Only two things ask for it now: opening the board (through
 *  `/board/open`, server-side) and an event this page could not make sense of. Everything
 *  else patches. */
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

/** Sort the working set into its columns.
 *
 *  The rows arrive in ONE order — newest-first, which is what the single query asked for —
 *  and the columns do not all want that. `queued` wants the scheduler's order so its top is
 *  the duty an agent will claim next; `needs_decision` wants the longest-waiting question
 *  first. Every column here is complete, so sorting in the browser is exact rather than an
 *  approximation of a sort the server would have done — hence no cursor either.
 *  `done` is not touched: it is loaded separately. */
function bucketLive(rows) {
  for (const key of LIVE_STATUSES) {
    columns.value[key] = { rows: [], cursor: null, loading: false, total: columns.value[key].total };
  }
  for (const duty of rows) {
    const col = columns.value[duty.status];
    if (col && duty.status !== "done") col.rows.push(duty);
  }
  for (const key of LIVE_STATUSES) sortColumn(key, columns.value[key].rows);
}

/** The working set — one query, or one per column once it no longer fits in one.
 *
 *  Once it is paged, `keys` matters: refreshing every live column on every event would put
 *  the six-query cost back, on exactly the boards that could least afford it. */
async function loadLive(keys) {
  if (paged.value) {
    const cols = keys && keys.size ? LIVE_STATUSES.filter((k) => keys.has(k)) : LIVE_STATUSES;
    await Promise.all(cols.map((k) => loadColumn(k)));
    return;
  }
  const res = await query("duties", {
    where: [
      { field: "project_id", op: "=", value: props.projectId },
      { field: "status", op: "in", value: LIVE_STATUSES },
    ],
    order: [{ field: "updated_at", dir: "desc" }],
    limit: WORKING_SET,
  });
  const rows = (res.documents || []).map(flat);
  if (rows.length >= WORKING_SET) {
    paged.value = true;
    await Promise.all(LIVE_STATUSES.map((k) => loadColumn(k)));
    return;
  }
  bucketLive(rows);
}

/**
 * Reload the halves an event touched, or both when it named nothing.
 *
 * The working set is refreshed as a whole even when one status changed, because it is one
 * query either way — and a duty that moved between two live columns changed both.
 *
 * `agents` is separate because only a transition touches an agent row — claiming, or
 * parking a duty releases whoever held it — and enqueueing never does.
 */
async function refresh(keys, { agents = true } = {}) {
  error.value = "";
  const all = !keys || !keys.size;
  const jobs = [];
  if (all || [...keys].some((k) => k !== "done")) jobs.push(loadLive(all ? null : keys));
  if (all || keys.has("done")) jobs.push(loadColumn("done"));
  if (agents) jobs.push(loadAgents());
  await Promise.all(jobs);
  await loadTotals();
}

/**
 * The real size of each column, when the rows on screen are not all of them.
 *
 * A truncated column used to read `12+`, which on a board of 260 duties says almost
 * nothing. One grouped count answers for every column at once, and it is only asked for
 * when something is actually truncated — on a board that fits, the rows ARE the count and
 * a second query would be waste. `done` is always truncated by design, so this is also how
 * a board says how much it has finished.
 */
async function loadTotals() {
  const truncated = STATUS_COLUMNS.some((c) => columns.value[c.key].cursor);
  if (!truncated) {
    for (const c of STATUS_COLUMNS) columns.value[c.key].total = null;
    return;
  }
  try {
    const res = await aggregate("duties", {
      where: [{ field: "project_id", op: "=", value: props.projectId }],
      group: ["status"],
      metrics: [{ fn: "count", as: "n" }],
    });
    const byStatus = Object.fromEntries((res.groups || []).map((g) => [g.group.status, g.metrics.n]));
    for (const c of STATUS_COLUMNS) columns.value[c.key].total = byStatus[c.key] ?? 0;
  } catch {
    // Counts are a nicety. A board that cannot get them shows `12+`, which is what it
    // always showed, rather than an error over something nobody asked for.
    for (const c of STATUS_COLUMNS) columns.value[c.key].total = null;
  }
}

/** The whole board: the working set, and the top of `done`.
 *
 *  `agents: false` on the first load — `/board/open` is fetching the strip at the same
 *  moment, and reading it twice on the way in is the sort of thing nobody notices. */
async function loadAll(opts) {
  try {
    await refresh(null, opts);
  } catch (err) {
    error.value = err.message;
  }
}

/**
 * The board's name, its agents, and the socket — one request.
 *
 * These were three: a projects query, an agents query and a token mint. The function was
 * already reading the project row to authorise the mint, so the other two ride along on a
 * request that was being made anyway.
 */
async function openBoard() {
  try {
    const res = await api("/board/open", { project_id: props.projectId });
    board.value = res.project || null;
    agents.value = res.agents || [];
    searchable.value = res.search === true;
    connect(res.live || null);
  } catch (err) {
    error.value = err.message;
    connect(null);
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
  } else {
    applyAgent(ev.ag);
    if (touched) {
      const from = columnHolding(ev.id);
      if (from) touched.add(from);
      if (ev.status && columns.value[ev.status]) touched.add(ev.status);
    }
  }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const keys = touched;
    touched = new Set();
    // `agents` only when the event was unintelligible — an understood one has already
    // patched the strip, and re-reading the collection to confirm it is the query this
    // whole payload exists to avoid.
    refresh(keys, { agents: !keys });
  }, 400);
}

function connect(mint) {
  if (socket) socket.close();
  socket = subscribeLive(
    { projectId: props.projectId, mint },
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
    openBoard();
    loadAll({ agents: false });
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
        <form v-if="searchable" class="board-search" role="search" @submit.prevent="runSearch">
          <label class="sr-only" for="b-search">Search finished duties</label>
          <input
            id="b-search"
            v-model="searchQuery"
            type="search"
            placeholder="Search finished work…"
            :disabled="searching"
          />
          <button type="submit" :disabled="searching || !searchQuery.trim()">{{ searching ? "…" : "Search" }}</button>
        </form>
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
        <span v-for="a in agents" :key="a.agent_id" class="badge">
          {{ a.agent_id }} · {{ a.active_duty_id ? "working" : "idle" }} · seen {{ ago(a.last_seen_at) }}
        </span>
      </p>
    </section>

    <section v-if="hits" class="panel stack" aria-labelledby="hits-h">
      <div class="panel__head">
        <h2 id="hits-h">
          {{ hits.length }} finished {{ hits.length === 1 ? "duty" : "duties" }} matching
          <span class="mono">{{ searchQuery }}</span>
        </h2>
        <button type="button" @click="clearSearch">Back to the board</button>
      </div>
      <div v-if="!hits.length" class="stack">
        <p class="muted small" style="margin: 0">
          Nothing. Only finished duties are searchable, and one that has just finished takes a
          moment to appear.
        </p>
        <p v-if="reindexed" class="muted small" style="margin: 0">
          Indexed {{ reindexed }} finished {{ reindexed === 1 ? "duty" : "duties" }}. If this is
          still empty, nothing on this board matches.
        </p>
        <p v-else class="small" style="margin: 0">
          Work finished before search was turned on is not in the index yet.
          <button type="button" class="link" :disabled="reindexing" @click="reindex">
            {{ reindexing ? "Indexing…" : "Index this board's finished duties" }}
          </button>
        </p>
      </div>
      <ul v-else class="hits">
        <li v-for="h in hits" :key="h.duty_id">
          <router-link class="boardcard" :to="{ name: 'duty', params: { projectId, dutyId: h.duty_id } }">
            <strong>{{ h.title }}</strong>
            <span class="chips">
              <span class="badge" :class="h.status === 'failed' ? 'badge--immediate_blocker' : ''">{{ h.status }}</span>
              <span v-if="h.agent_id" class="nowrap">{{ h.agent_id }}</span>
              <span v-if="h.finished_at" class="nowrap">{{ ago(h.finished_at) }}</span>
            </span>
            <span v-if="h.outcome_summary" class="duty__ask" style="border-left-color: var(--ok)">
              {{ h.outcome_summary }}
            </span>
          </router-link>
        </li>
      </ul>
    </section>

    <!-- Wide: every column at once, sharing the window. -->
    <div v-if="wide && !hits" class="board" :style="{ '--cols': shownColumns.length }">
      <BoardColumn
        v-for="col in shownColumns"
        :key="col.key"
        :col="col"
        :state="columns[col.key]"
        :project-id="projectId"
        @more="loadColumn($event, { append: true })"
      />
    </div>

    <!-- Narrow: one column, chosen. `v-else-if` and not `v-else`: with search results on
         screen neither layout should render, and `v-else` would put the phone layout on a
         desktop the moment the wide branch went false. -->
    <template v-else-if="!hits">
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
          <span class="chip__n">
            {{ columns[col.key].total ?? count(col.key)
            }}{{ columns[col.key].total == null && columns[col.key].cursor ? "+" : "" }}
          </span>
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
