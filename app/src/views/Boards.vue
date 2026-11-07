<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { aggregate, api, query, refresh } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { COUNTS_REQUEST, countsByBoard, isQuiet, sortBoards, workParts } from "../lib/boards.js";
import { plain } from "../lib/markdown.js";
import { newRepoDraft, noRepo, profileDraft, profilePayload, requestNewRepo, runnerSummary } from "../lib/runners.js";
import ProfileForm from "../components/ProfileForm.vue";
import NewRepoFields from "../components/NewRepoFields.vue";

const router = useRouter();

const boards = ref([]);
const shared = ref([]);
const loading = ref(true);
const error = ref("");

/** Duties per board per status, from one grouped count. Null until it answers — and if it never
 *  does, the cards fall back to what they always showed rather than claiming every board is empty. */
const counts = ref(null);
/** The machines on each board, keyed by board. Filled in after the cards draw: presence is a call
 *  per machine, and the cards are worth seeing before it answers. */
const runners = ref({});
/** Questions agents have asked, across every board, longest-waiting first. */
const waiting = ref([]);
/** How many of them there are, which can be more than the page shows. */
const WAITING_SHOWN = 8;

const all = computed(() => [...boards.value, ...shared.value]);
const nameOf = computed(() => Object.fromEntries(all.value.map((b) => [b.project_id, b.name])));
const waitingTotal = computed(() =>
  counts.value ? Object.values(counts.value).reduce((n, c) => n + (c.needs_decision || 0), 0) : waiting.value.length,
);

// Sorted only once the counts are in, so the cards do not reshuffle under the pointer — and a
// board with nothing open and nothing moving for a fortnight folds into "Quiet" rather than
// taking a place in the grid. Unless every board is quiet, when folding them all would leave a
// page that looks empty.
const sortedOwn = computed(() => (counts.value ? sortBoards(boards.value, counts.value) : boards.value));
const quietOwn = computed(() => (counts.value ? sortedOwn.value.filter((b) => isQuiet(b, counts.value)) : []));
const foldQuiet = computed(() => quietOwn.value.length > 0 && quietOwn.value.length < sortedOwn.value.length);
const busyOwn = computed(() => (foldQuiet.value ? sortedOwn.value.filter((b) => !quietOwn.value.includes(b)) : sortedOwn.value));
const sortedShared = computed(() => (counts.value ? sortBoards(shared.value, counts.value) : shared.value));

/** The intro is for someone working out what a board is, not for someone with a page of them. */
const showIntro = computed(() => !loading.value && all.value.length < 2);

function card(b) {
  const c = counts.value && (counts.value[b.project_id] || { open: 0, last: 0 });
  const linked = runners.value[b.project_id] || [];
  let runner = linked.length ? runnerSummary(linked) : null;
  // A machine that is down is only news when something is waiting for it.
  if (runner && runner.tone === "off" && c && c.queued) runner = { tone: "warn", text: `${runner.text} · ${c.queued} waiting` };
  return {
    parts: workParts(c),
    runner,
    when: c ? (c.last ? `last activity ${ago(c.last)}` : "no duties yet") : null,
    idle: c && !c.open,
  };
}

const cards = computed(() => Object.fromEntries(all.value.map((b) => [b.project_id, card(b)])));

/** Everything on the page that changes while it is open: counts, questions, machines. Each part is
 *  best-effort — the list of boards is what this page is for, and none of these may take it down. */
async function loadStatus() {
  const [agg, asks] = await Promise.allSettled([
    aggregate("duties", COUNTS_REQUEST),
    query("duties", {
      where: [{ field: "status", op: "=", value: "needs_decision" }],
      order: [{ field: "updated_at", dir: "asc" }],
      limit: WAITING_SHOWN,
    }),
  ]);
  if (agg.status === "fulfilled") counts.value = countsByBoard(agg.value.groups);
  if (asks.status === "fulfilled") waiting.value = (asks.value.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));
}

async function loadRunners() {
  const ids = all.value.map((b) => b.project_id);
  if (!ids.length) return;
  try {
    runners.value = (await api("/projects/runners", { project_ids: ids })).runners || {};
  } catch {
    // A card without a runner line is what every card was before there was one.
  }
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
        <h1>Your boards</h1>
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
      <ProfileForm v-if="forRunner" v-model="profile" v-model:creating="creatingRepo" id-prefix="new" offer-new-repo :disabled="creating">
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
      <!-- What is waiting on you, from every board, before the boards themselves. An agent that
           asked a question has stopped on that duty; this is the one thing on the page that is
           blocked until you act, and finding it used to mean opening each board in turn. -->
      <section v-if="waiting.length" aria-labelledby="waiting-h" class="stack">
        <h2 id="waiting-h" style="margin: 0">
          Needs you <span class="badge badge--needs_decision">{{ waitingTotal }}</span>
        </h2>
        <ul class="asks">
          <li v-for="d in waiting" :key="d.key">
            <router-link class="duty" :to="{ name: 'duty', params: { projectId: d.project_id, dutyId: d.key } }">
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
        <p v-if="waitingTotal > waiting.length" class="muted" style="margin: 0">
          {{ waitingTotal - waiting.length }} more — the boards below say where.
        </p>
      </section>

      <!-- The whole card is the link. Two targets on one row — open, and settings — meant
           the obvious tap did the less likely thing about half the time; the board's own
           nav carries Settings, which is where you go once you are inside it. -->
      <ul v-if="boards.length" class="cards">
        <li v-for="b in busyOwn" :key="b.project_id">
          <router-link class="boardcard" :class="{ 'boardcard--idle': cards[b.project_id].idle }" :to="{ name: 'board', params: { projectId: b.project_id } }">
            <span class="boardcard__name">{{ b.name }}</span>
            <span class="boardcard__meta mono">{{ b.project_id }}</span>
            <span v-if="cards[b.project_id].parts.length" class="boardcard__work">
              <span v-for="p in cards[b.project_id].parts" :key="p.text" class="badge" :class="p.tone && `badge--${p.tone}`">{{ p.text }}</span>
            </span>
            <span v-else-if="counts && counts[b.project_id]" class="boardcard__meta">Nothing open</span>
            <span v-if="cards[b.project_id].runner" class="boardcard__meta livedot" :class="`livedot--${cards[b.project_id].runner.tone}`">{{ cards[b.project_id].runner.text }}</span>
            <span class="boardcard__meta">{{ cards[b.project_id].when || `created ${ago(b.created_at)}` }}</span>
          </router-link>
        </li>
      </ul>

      <p v-else class="empty">
        {{ shared.length ? "No boards of your own yet." : "No boards yet. Create one, then put it on a machine." }}
      </p>

      <details v-if="foldQuiet" class="quiet">
        <summary>Quiet boards ({{ quietOwn.length }}) <span class="muted">— nothing open, nothing moved in two weeks</span></summary>
        <ul class="cards">
          <li v-for="b in quietOwn" :key="b.project_id">
            <router-link class="boardcard boardcard--idle" :to="{ name: 'board', params: { projectId: b.project_id } }">
              <span class="boardcard__name">{{ b.name }}</span>
              <span class="boardcard__meta mono">{{ b.project_id }}</span>
              <span v-if="cards[b.project_id].runner" class="boardcard__meta livedot" :class="`livedot--${cards[b.project_id].runner.tone}`">{{ cards[b.project_id].runner.text }}</span>
              <span class="boardcard__meta">{{ cards[b.project_id].when || `created ${ago(b.created_at)}` }}</span>
            </router-link>
          </li>
        </ul>
      </details>

      <section v-if="shared.length" aria-labelledby="shared-h" class="stack">
        <h2 id="shared-h" style="margin: 0">Shared with you</h2>
        <ul class="cards">
          <li v-for="b in sortedShared" :key="b.project_id">
            <router-link class="boardcard" :class="{ 'boardcard--idle': cards[b.project_id].idle }" :to="{ name: 'board', params: { projectId: b.project_id } }">
              <span class="boardcard__name">{{ b.name }}</span>
              <span class="boardcard__meta">{{ b.owner_name ? `owned by ${b.owner_name}` : "shared with you" }}</span>
              <span v-if="cards[b.project_id].parts.length" class="boardcard__work">
                <span v-for="p in cards[b.project_id].parts" :key="p.text" class="badge" :class="p.tone && `badge--${p.tone}`">{{ p.text }}</span>
              </span>
              <span v-else-if="counts && counts[b.project_id]" class="boardcard__meta">Nothing open</span>
              <span v-if="cards[b.project_id].runner" class="boardcard__meta livedot" :class="`livedot--${cards[b.project_id].runner.tone}`">{{ cards[b.project_id].runner.text }}</span>
              <span v-if="cards[b.project_id].when" class="boardcard__meta">{{ cards[b.project_id].when }}</span>
            </router-link>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
