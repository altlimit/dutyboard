<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { aggregate, api, query, refresh } from "../lib/altengine.js";
import { ago, localWhen, until } from "../lib/duties.js";
import {
  COUNTS_REQUEST,
  TREND_DAYS,
  countsByBoard,
  finishesByDay,
  finishesRequest,
  isQuiet,
  lastDays,
  machinesOnline,
  runsByDuty,
  sortBoards,
  totals,
} from "../lib/boards.js";
import { plain } from "../lib/markdown.js";
import { newRepoDraft, noRepo, profileDraft, profilePayload, requestNewRepo, runnerSummary } from "../lib/runners.js";
import ProfileForm from "../components/ProfileForm.vue";
import NewRepoFields from "../components/NewRepoFields.vue";
import BoardTable from "../components/BoardTable.vue";
import TrendBars from "../components/TrendBars.vue";

const router = useRouter();

const boards = ref([]);
const shared = ref([]);
const loading = ref(true);
const error = ref("");

/** Duties per board per status, from one grouped count. Null until it answers — and if it never
 *  does, the tiles and the table's numbers stay blank rather than claiming every board is empty. */
const counts = ref(null);
/** The machines on each board, keyed by board. Filled in after the boards draw: presence is a call
 *  per machine, and the boards are worth seeing before it answers. */
const runners = ref({});
/** Questions agents have asked, across every board, longest-waiting first. */
const waiting = ref([]);
/** How many of them there are, which can be more than the page shows. */
const WAITING_SHOWN = 8;
/** Duties an agent holds right now, across every board, most recently heard from first. */
const running = ref([]);
const RUNNING_SHOWN = 6;
/** Finished work per day for the fortnight, or null when it could not be counted. */
const trend = ref(null);
/** What the schedules file next, from `/projects/upcoming` — null until it answers, and for
 *  good on a function too old to have it, when "Up next" and the column stay out of the way. */
const upcoming = ref(null);
const UPCOMING_SHOWN = 5;

const all = computed(() => [...boards.value, ...shared.value]);
const nameOf = computed(() => Object.fromEntries(all.value.map((b) => [b.project_id, b.name])));
const waitingTotal = computed(() =>
  counts.value ? Object.values(counts.value).reduce((n, c) => n + (c.needs_decision || 0), 0) : waiting.value.length,
);

// Sorted only once the counts are in, so the rows do not reshuffle under the pointer — and a
// board with nothing open and nothing moving for a fortnight folds into "Quiet" rather than
// taking a row in the table. Unless every board is quiet, when folding them all would leave a
// page that looks empty.
const sortedOwn = computed(() => (counts.value ? sortBoards(boards.value, counts.value) : boards.value));
const quietOwn = computed(() => (counts.value ? sortedOwn.value.filter((b) => isQuiet(b, counts.value)) : []));
const foldQuiet = computed(() => quietOwn.value.length > 0 && quietOwn.value.length < sortedOwn.value.length);
const busyOwn = computed(() => (foldQuiet.value ? sortedOwn.value.filter((b) => !quietOwn.value.includes(b)) : sortedOwn.value));
const sortedShared = computed(() => (counts.value ? sortBoards(shared.value, counts.value) : shared.value));

/** The intro is for someone working out what a board is, not for someone with a page of them. */
const showIntro = computed(() => !loading.value && all.value.length < 2);

/** One board's row: its counts, its machines in a line, its next scheduled run, when it last moved. */
function rowInfo(b) {
  const c = counts.value && (counts.value[b.project_id] || { open: 0, last: 0 });
  const linked = runners.value[b.project_id] || [];
  let runner = linked.length ? runnerSummary(linked) : null;
  // A machine that is down is only news when something is waiting for it.
  if (runner && runner.tone === "off" && c && c.queued) runner = { tone: "warn", text: `${runner.text} · ${c.queued} waiting` };
  return {
    c,
    runner,
    next: upcoming.value ? upcoming.value.next[b.project_id] || null : null,
    when: c ? (c.last ? ago(c.last) : "none yet") : `created ${ago(b.created_at)}`,
    idle: c && !c.open,
  };
}

const info = computed(() => Object.fromEntries(all.value.map((b) => [b.project_id, rowInfo(b)])));

// --- the tiles -------------------------------------------------------------

const sum = computed(() => (counts.value ? totals(counts.value) : null));
const runs = computed(() => runsByDuty(runners.value));
const online = computed(() => machinesOnline(runners.value));
const runnersKnown = computed(() => Object.keys(runners.value).length > 0);
const limitedCount = computed(() => running.value.filter((d) => runs.value[d.key]?.state === "limited").length);
const finished7 = computed(() => (trend.value ? lastDays(trend.value, 7, "done") : 0));
const failed7 = computed(() => (trend.value ? lastDays(trend.value, 7, "failed") : 0));
const finished14 = computed(() => (trend.value ? lastDays(trend.value, TREND_DAYS, "done") : 0));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the machine holding a running duty says about it, where that is more than "working". */
function runNote(d) {
  const r = runs.value[d.key];
  if (!r) return null;
  if (r.state === "limited") return { tone: "warn", text: "waiting out a usage limit" };
  if (r.state === "waiting") return { tone: "warn", text: r.detail || "waiting" };
  if (r.state === "error") return { tone: "warn", text: r.detail || "the machine reported an error" };
  if (r.state === "integrating") return { tone: "live", text: `integrating on ${r.machine}` };
  if (r.state === "parked") return { tone: "off", text: `parked on ${r.machine}` };
  return { tone: "live", text: `on ${r.machine}` };
}

const rowsOf = (res) => (res.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));

/** Everything on the page that changes while it is open: counts, questions, running work, the
 *  fortnight's finishes. Each part is best-effort — the list of boards is what this page is for,
 *  and none of these may take it down. */
async function loadStatus() {
  const [agg, asks, active, done] = await Promise.allSettled([
    aggregate("duties", COUNTS_REQUEST),
    query("duties", {
      where: [{ field: "status", op: "=", value: "needs_decision" }],
      order: [{ field: "updated_at", dir: "asc" }],
      limit: WAITING_SHOWN,
    }),
    query("duties", {
      where: [{ field: "status", op: "=", value: "active" }],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: RUNNING_SHOWN,
    }),
    aggregate("finishes", finishesRequest()),
  ]);
  if (agg.status === "fulfilled") counts.value = countsByBoard(agg.value.groups);
  if (asks.status === "fulfilled") waiting.value = rowsOf(asks.value);
  if (active.status === "fulfilled") running.value = rowsOf(active.value);
  if (done.status === "fulfilled") trend.value = finishesByDay(done.value.groups);
}

/** The machines on every board, and what the schedules file next: both function calls, both after
 *  the boards have drawn, and neither able to stop the page. */
async function loadRunners() {
  const ids = all.value.map((b) => b.project_id);
  if (!ids.length) return;
  await Promise.all([
    api("/projects/runners", { project_ids: ids })
      .then((res) => (runners.value = res.runners || {}))
      // A row without a machine line is what every row was before there was one.
      .catch(() => {}),
    api("/projects/upcoming", { project_ids: ids })
      .then((res) => (upcoming.value = { schedules: res.schedules || [], total: res.total || 0, next: res.next || {} }))
      // A function older than this page has no such route: leave "Up next" out rather than say "none".
      .catch(() => {}),
  ]);
}
const creating = ref(false);
const showForm = ref(false);
const name = ref("");
const slug = ref("");
const nameInput = ref(null);
// A board a `dutyboard` runner works is made with its profile; one for an agent you connect by
// hand with a token needs none. On by default, because the runner is how most boards are worked.
const forRunner = ref(true);
const profile = ref(profileDraft());
// A board can start from nothing: one of your machines makes its repository on GitHub, and its first
// duty builds the project's first version there.
const creatingRepo = ref(false);
const newRepo = ref(newRepoDraft());
const machines = ref([]);
// The repository is named after the board until someone names it otherwise.
let suggested = "";
watch([name, slug], () => {
  const next = (slug.value || name.value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (newRepo.value.name === suggested) newRepo.value.name = next;
  suggested = next;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const status = loadStatus();
    const res = await api("/projects/list");
    boards.value = res.projects;
    shared.value = res.shared || [];
    // Someone may have been added to a board since this page loaded, and this list is where they
    // would look for it. The function checked the token while answering; when it is behind, a
    // refresh now means the board opens with its duties rather than empty.
    // The counts were asked for alongside the list; a token that was behind is one that could
    // not count a newly shared board, so they are asked again once it is fresh.
    if (res.refresh) {
      await refresh().catch(() => {});
      await status;
      await loadStatus();
    } else {
      await status;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
  loadRunners();
}

/** While the page is in front of someone, it keeps up: on coming back to the tab, and once a
 *  minute while it stays open. A board page has a live channel; this one has nine boards'
 *  worth of them, and a minute-old count is not worth subscribing to all nine for. */
const REFRESH_EVERY_MS = 60_000;
let timer = null;
let lastRefresh = Date.now();
function refreshIfVisible() {
  if (document.visibilityState !== "visible" || loading.value) return;
  if (Date.now() - lastRefresh < REFRESH_EVERY_MS / 2) return;
  lastRefresh = Date.now();
  loadStatus();
  loadRunners();
}

/** Opening the form moves focus into it. A button that reveals fields somewhere below,
 *  leaving focus on itself, is a form a keyboard user has to go looking for. */
async function openForm() {
  showForm.value = true;
  api("/machines/list")
    .then((res) => {
      machines.value = res.machines || [];
      if (!newRepo.value.machine_id) newRepo.value.machine_id = newRepoDraft("", machines.value).machine_id;
    })
    .catch(() => {});
  await nextTick();
  if (nameInput.value) nameInput.value.focus();
}

async function create() {
  creating.value = true;
  error.value = "";
  try {
    const makeRepo = forRunner.value && creatingRepo.value && !noRepo(profile.value.workspace);
    const payload = forRunner.value ? profilePayload(profile.value) : {};
    if (makeRepo) payload.profile.repo_url = "";
    const res = await api("/projects/create", {
      name: name.value,
      project_id: slug.value || undefined,
      ...payload,
    });
    // The board exists now whatever happens next. A repository that could not be asked for is offered
    // again on its settings, so this goes there either way and says why.
    let repoError = "";
    if (makeRepo) {
      await requestNewRepo(api, res.project_id, { ...newRepo.value, name: newRepo.value.name || res.project_id }).catch((err) => {
        repoError = err.message;
      });
    }
    name.value = "";
    slug.value = "";
    profile.value = profileDraft();
    creatingRepo.value = false;
    newRepo.value = newRepoDraft("", machines.value);
    showForm.value = false;
    // Straight to where the next step is: putting it on a machine, or minting a token.
    const query = { created: forRunner.value ? "runner" : "token", ...(repoError ? { repo_error: repoError } : {}) };
    router.push({ name: "settings", params: { projectId: res.project_id }, query });
  } catch (err) {
    error.value = err.message;
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  load();
  timer = setInterval(refreshIfVisible, REFRESH_EVERY_MS);
  document.addEventListener("visibilitychange", refreshIfVisible);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener("visibilitychange", refreshIfVisible);
});
</script>

<template>
  <div class="wrap stack">
    <div class="row row--between">
      <div>
        <h1>Dashboard</h1>
        <p v-if="showIntro" class="muted" style="margin: 0">
          A board is one stream of work. A machine running <code class="mono">dutyboard</code> works it with
          Claude Code, Codex or Cursor, or an agent connects to it with a token — either way it only ever sees the duties on it.
        </p>
      </div>
      <button
        class="primary page-action"
        type="button"
        :aria-expanded="showForm"
        @click="showForm ? (showForm = false) : openForm()"
      >
        {{ showForm ? "Cancel" : "New board" }}
      </button>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>

    <!-- Behind a button, like "Add duty" on the board. Someone who already has boards came
         here to open one, and a permanent form pushes what they came for down the page. -->
    <form v-if="showForm" class="panel panel--form stack" @submit.prevent="create">
      <h2 style="margin: 0">New board</h2>
      <div class="field">
        <label for="b-name">Name</label>
        <input id="b-name" ref="nameInput" v-model="name" required maxlength="120" placeholder="Backend rewrite" />
      </div>
      <div class="field">
        <label for="b-slug">Board id <span class="muted">(optional)</span></label>
        <input id="b-slug" v-model="slug" maxlength="60" placeholder="derived from the name" />
        <p class="hint">Agents refer to the board by this id, so keep it short and stable. It cannot be changed later.</p>
      </div>
      <label class="choice choice--block">
        <input v-model="forRunner" type="checkbox" />
        <span>
          Worked by a <code class="mono">dutyboard</code> runner
          <span class="hint" style="display: block; margin: 0">
            A machine sets itself up for the project, drafts its rules for you to accept, and works its duties.
          </span>
        </span>
      </label>
      <ProfileForm v-if="forRunner" v-model="profile" :machines="machines" v-model:creating="creatingRepo" id-prefix="new" offer-new-repo :disabled="creating">
        <template #new-repo>
          <NewRepoFields v-model="newRepo" id-prefix="new-repo" :machines="machines" :disabled="creating" />
        </template>
      </ProfileForm>
      <div>
        <button class="primary" type="submit" :disabled="creating || !name || (forRunner && creatingRepo && !noRepo(profile.workspace) && !(newRepo.machine_id && newRepo.name))">
          {{ creating ? "Creating…" : "Create board" }}
        </button>
      </div>
    </form>

    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else>
      <!-- The whole of your boards in four numbers, before any one board. Each says what it counts
           in words under it; nothing here is a colour alone. -->
      <ul v-if="all.length" class="tiles" aria-label="Across your boards">
        <li class="tile" :class="{ 'tile--attention': waitingTotal }">
          <span class="tile__label">Needs you</span>
          <span class="tile__value">{{ counts || waiting.length ? waitingTotal : "–" }}</span>
          <span class="tile__foot">{{ waiting.length ? `oldest waiting ${ago(waiting[0].updated_at).replace(" ago", "")}` : "nothing waiting on you" }}</span>
        </li>
        <li class="tile">
          <span class="tile__label">Running</span>
          <span class="tile__value">{{ sum ? sum.active : "–" }}</span>
          <span class="tile__foot">
            <template v-if="limitedCount">{{ limitedCount }} at a usage limit</template>
            <template v-else-if="runnersKnown">{{ online ? `${plural(online, "machine")} online` : "no machine online" }}</template>
            <template v-else>&nbsp;</template>
          </span>
        </li>
        <li class="tile">
          <span class="tile__label">Queued</span>
          <span class="tile__value">{{ sum ? sum.queued : "–" }}</span>
          <span class="tile__foot">
            <template v-if="sum && sum.blocked">{{ sum.blocked }} more blocked behind other work</template>
            <template v-else-if="sum && sum.queued">waiting for an agent</template>
            <template v-else>nothing waiting to start</template>
          </span>
        </li>
        <li class="tile tile--trend">
          <span class="tile__label">Finished, last 7 days</span>
          <span class="tile__value">{{ trend ? finished7 : "–" }}</span>
          <span class="tile__foot">
            <template v-if="!trend">not counted on this server yet</template>
            <template v-else-if="!finished14">nothing finished in two weeks</template>
            <template v-else>{{ failed7 ? `${failed7} failed` : "none failed" }}</template>
          </span>
          <TrendBars v-if="trend && finished14" :days="trend" />
        </li>
      </ul>

      <!-- What wants you, and what is happening without you. Questions first and widest: an agent
           that asked one has stopped on that duty, and it is the one thing here blocked until you
           act. Beside them, what is being worked and what the schedules file next. -->
      <div v-if="all.length" class="overview">
        <section aria-labelledby="waiting-h" class="panel overview__main">
          <div class="panel__head">
            <h2 id="waiting-h">Needs you <span v-if="waitingTotal" class="badge badge--needs_decision">{{ waitingTotal }}</span></h2>
          </div>
          <ul v-if="waiting.length" class="feed feed--asks">
            <li v-for="d in waiting" :key="d.key">
              <router-link class="feed__item" :to="{ name: 'duty', params: { projectId: d.project_id, dutyId: d.key } }">
                <span class="duty__title">{{ d.title }}</span>
                <span class="duty__meta">
                  <span class="badge">{{ nameOf[d.project_id] || d.project_id }}</span>
                  <span v-if="d.assigned_agent_id" class="nowrap">asked by {{ d.assigned_agent_id }}</span>
                  <span class="nowrap">waiting since {{ ago(d.updated_at) }}</span>
                </span>
                <span v-if="d.last_question" class="duty__ask">{{ plain(d.last_question) }}</span>
              </router-link>
            </li>
          </ul>
          <p v-else class="feed__empty">Nothing is waiting on you. Agents' questions and suggested duties land here.</p>
          <p v-if="waitingTotal > waiting.length" class="feed__more">
            {{ waitingTotal - waiting.length }} more — the boards below say where.
          </p>
        </section>

        <div class="overview__side">
          <section aria-labelledby="running-h" class="panel">
            <div class="panel__head">
              <h2 id="running-h">Running now</h2>
            </div>
            <ul v-if="running.length" class="feed">
              <li v-for="d in running" :key="d.key">
                <router-link class="feed__item" :to="{ name: 'duty', params: { projectId: d.project_id, dutyId: d.key } }">
                  <span class="duty__title">{{ d.title }}</span>
                  <span class="duty__meta">
                    <span class="badge">{{ nameOf[d.project_id] || d.project_id }}</span>
                    <span v-if="d.assigned_agent_id" class="nowrap">{{ d.assigned_agent_id }}</span>
                    <span class="nowrap">{{ d.claimed_at ? `started ${ago(d.claimed_at)}` : `updated ${ago(d.updated_at)}` }}</span>
                  </span>
                  <span v-if="runNote(d)" class="livedot feed__note" :class="`livedot--${runNote(d).tone}`">{{ runNote(d).text }}</span>
                </router-link>
              </li>
            </ul>
            <p v-else class="feed__empty">Nothing is being worked right now.</p>
            <p v-if="sum && sum.active > running.length" class="feed__more">{{ sum.active - running.length }} more running.</p>
          </section>

          <section v-if="upcoming" aria-labelledby="next-h" class="panel">
            <div class="panel__head">
              <h2 id="next-h">Up next</h2>
              <span v-if="upcoming.total" class="muted feed__count">{{ plural(upcoming.total, "schedule") }}</span>
            </div>
            <ul v-if="upcoming.schedules.length" class="feed">
              <li v-for="s in upcoming.schedules.slice(0, UPCOMING_SHOWN)" :key="s.schedule_id">
                <router-link class="feed__item feed__item--row" :to="{ name: 'settings', params: { projectId: s.project_id }, query: { tab: 'recurring' } }">
                  <span class="feed__when">
                    <span class="feed__in">{{ until(s.next_due_at) }}</span>
                    <span class="feed__at">{{ localWhen(s.next_due_at) }}</span>
                  </span>
                  <span class="feed__what">
                    <span class="duty__title">{{ s.title }}</span>
                    <span class="duty__meta">
                      <span class="badge">{{ nameOf[s.project_id] || s.project_id }}</span>
                      <span v-if="s.checked" class="nowrap">checks first, files only if there is work</span>
                    </span>
                  </span>
                </router-link>
              </li>
            </ul>
            <p v-else class="feed__empty">No recurring duties. A board's settings can file one every day, week or month.</p>
          </section>
        </div>
      </div>

      <section aria-labelledby="boards-h" class="stack">
        <h2 v-if="all.length" id="boards-h" class="section-h">Boards</h2>
        <BoardTable v-if="busyOwn.length" :boards="busyOwn" :info="info" caption="Your boards" />
        <p v-else-if="!boards.length" class="empty">
          {{ shared.length ? "No boards of your own yet." : "No boards yet. Create one, then put it on a machine." }}
        </p>

        <details v-if="foldQuiet" class="quiet">
          <summary>Quiet boards ({{ quietOwn.length }}) <span class="muted">— nothing open, nothing moved in two weeks</span></summary>
          <BoardTable :boards="quietOwn" :info="info" caption="Quiet boards" />
        </details>
      </section>

      <section v-if="shared.length" aria-labelledby="shared-h" class="stack">
        <h2 id="shared-h" class="section-h">Shared with you</h2>
        <BoardTable :boards="sortedShared" :info="info" shared caption="Boards shared with you" />
      </section>
    </template>
  </div>
</template>
