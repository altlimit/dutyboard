<script setup>
// Your boards: every one in a table, or all of them at once as an office building — a room of
// cubicles per board, and one breakroom they share. Making a board starts here too.
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { isQuiet, runsByDuty, sortBoards } from "../lib/boards.js";
import { newRepoDraft, noRepo, profileDraft, profilePayload, requestNewRepo, runnerSummary } from "../lib/runners.js";
import { useBoards } from "../lib/useBoards.js";
import ProfileForm from "../components/ProfileForm.vue";
import NewRepoFields from "../components/NewRepoFields.vue";
import BoardTable from "../components/BoardTable.vue";
import OfficeBuilding from "../components/OfficeBuilding.vue";
import WaitingOnYou from "../components/WaitingOnYou.vue";
import QuickDuty from "../components/QuickDuty.vue";

const router = useRouter();
const route = useRoute();

const { boards, shared, all, loading, error, counts, runners, upcoming, loadRunners } = useBoards({
  onRefresh: () => office.value && loadOffice(),
});

// --- the table ---------------------------------------------------------------------------------

// Sorted only once the counts are in, so the rows do not reshuffle under the pointer — and a board
// with nothing open and nothing moving for a fortnight folds into "Quiet" rather than taking a row.
// Unless every board is quiet, when folding them all would leave a page that looks empty.
const sortedOwn = computed(() => (counts.value ? sortBoards(boards.value, counts.value) : boards.value));
const quietOwn = computed(() => (counts.value ? sortedOwn.value.filter((b) => isQuiet(b, counts.value)) : []));
const foldQuiet = computed(() => quietOwn.value.length > 0 && quietOwn.value.length < sortedOwn.value.length);
const busyOwn = computed(() => (foldQuiet.value ? sortedOwn.value.filter((b) => !quietOwn.value.includes(b)) : sortedOwn.value));
const sortedShared = computed(() => (counts.value ? sortBoards(shared.value, counts.value) : shared.value));

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

// --- the office --------------------------------------------------------------------------------

/** Which view, kept in the address so a reload or a link lands on the same one. */
const office = computed(() => route.query.view === "office");
const showView = (view) => router.replace({ query: { ...route.query, view: view === "office" ? "office" : undefined } });

/** Rooms the building draws. Past this a person has a campus, and the busiest boards get the rooms. */
const MAX_ROOMS = 24;
/** Boards one live token watches; the server holds it to the same. */
const MAX_LIVE = 40;
/** Unfinished duties read per status, across every board. */
const PER_STATUS = 200;

const showQuiet = ref(false);
const rosters = ref({});
const officeDuties = ref([]);
/** Duties finished lately: one that leaves a desk is shown as done, not just gone. */
const officeDone = ref([]);
const officeLoaded = ref(false);
const liveState = ref("");

/**
 * Yours then shared, in the order the list of boards comes in — not by activity, which would move
 * the rooms around while you watch. Quiet ones only when asked for.
 */
const officeBoards = computed(() => {
  const ordered = all.value;
  const shown = counts.value && !showQuiet.value ? ordered.filter((b) => !isQuiet(b, counts.value)) : ordered;
  return shown.slice(0, MAX_ROOMS).map((b) => ({ ...b, roster: rosters.value[b.project_id] || null }));
});
const hiddenQuiet = computed(() => (counts.value && !showQuiet.value ? all.value.filter((b) => isQuiet(b, counts.value)).length : 0));
const activity = computed(() => runsByDuty(runners.value));
/** Questions waiting on you, answered under the building; a "?" in it brings one here. */
const asking = computed(() => officeDuties.value.filter((d) => d.status === "needs_decision").sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0)));
const boardsById = computed(() => Object.fromEntries(officeBoards.value.map((b) => [b.project_id, b])));
const waiting = ref(null);
const quick = ref(null);

const rowsOf = (res) => (res.documents || []).map((d) => ({ ...d.data, key: String(d.key) }));

/** Every board's unfinished duties, three reads — the same shapes the dashboard already asks for. */
async function loadOfficeDuties() {
  const read = (status, dir) =>
    query("duties", { where: [{ field: "status", op: "=", value: status }], order: [{ field: "updated_at", dir }], limit: PER_STATUS }).then(rowsOf);
  const [active, queued, asks, done] = await Promise.all([
    read("active", "desc"),
    read("queued", "desc"),
    read("needs_decision", "asc"),
    query("duties", { where: [{ field: "status", op: "=", value: "done" }], order: [{ field: "updated_at", dir: "desc" }], limit: 30 }).then(rowsOf),
  ]);
  // Together, so a duty that left a desk and the record of it being done arrive in the same reading.
  officeDone.value = done;
  officeDuties.value = [...active, ...queued, ...asks];
}

async function loadRosters() {
  const ids = all.value.map((b) => b.project_id);
  if (!ids.length) return;
  try {
    rosters.value = (await api("/projects/rosters", { project_ids: ids })).rosters || {};
  } catch {
    // A DutyBoard from before teams: every board is drawn with one agent's cubicle.
    rosters.value = {};
  }
}

async function loadOffice() {
  try {
    await Promise.all([loadOfficeDuties(), officeLoaded.value ? null : loadRosters()]);
    officeLoaded.value = true;
  } catch (err) {
    error.value = err.message;
  }
}

// Live, while the office is open: one socket for the boards it draws. A duty that moves re-reads the
// floor; a machine that reports re-reads the machines; a team that changed re-reads the teams.
let socket = null;
let dutyTimer = null;
let runnerTimer = null;
function onEvent(frame) {
  const ev = frame && frame.data;
  if (!ev) return;
  if (ev.t === "runner") {
    if (!runnerTimer) runnerTimer = setTimeout(() => ((runnerTimer = null), loadRunners()), 1500);
    return;
  }
  if (ev.t === "board") {
    if (ev.what === "roster") loadRosters();
    return;
  }
  if (ev.t === "notes") return;
  if (!dutyTimer) dutyTimer = setTimeout(() => ((dutyTimer = null), loadOfficeDuties().catch(() => {})), 500);
}
function watchLive() {
  if (socket) socket.close();
  socket = null;
  const ids = officeBoards.value.map((b) => b.project_id).slice(0, MAX_LIVE);
  if (!office.value || !ids.length) return;
  socket = subscribeLive({ mintWith: () => api("/live/boards", { project_ids: ids }) }, onEvent, (s) => (liveState.value = s));
}

const liveKey = computed(() => (office.value ? officeBoards.value.map((b) => b.project_id).join(",") : ""));
watch([office, () => all.value.length], ([open]) => open && all.value.length && loadOffice(), { immediate: true });
watch(liveKey, watchLive);
onUnmounted(() => {
  if (socket) socket.close();
  clearTimeout(dutyTimer);
  clearTimeout(runnerTimer);
});

// --- a new board -------------------------------------------------------------------------------

const creating = ref(false);
/** A new board starts with the team that fits it unless its owner says otherwise. */
const withTeam = ref(true);
const TEAM_FOR = {
  repo: "A Duty Officer reads each duty first; an Architect, Engineer or Senior Engineer does it; QA verifies it before anything merges.",
  files: "A Duty Officer reads each duty first, a Specialist does the task, and a Checker opens every file before it comes back to you.",
  service: "A Duty Officer reads each duty first, an Operator makes the change in the account, and a Reviewer reads it back before it is called done.",
};
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
      ...(forRunner.value ? { roster: withTeam.value ? "auto" : "none" } : {}),
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


// From the dashboard's "Create one".
watch(
  () => route.query.new,
  (wanted) => {
    if (wanted && !showForm.value) {
      openForm();
      router.replace({ query: { ...route.query, new: undefined } });
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="wrap stack" :class="{ 'wrap--board': office }">
    <div class="row row--between">
      <div>
        <h1>Boards</h1>
        <p class="muted small" style="margin: 0">
          {{ office ? "Each board is a room of cubicles, one per role. Whoever has nothing in hand is in the breakroom." : "Every board, the ones that need you first." }}
        </p>
      </div>
      <div class="row">
        <div class="seg" role="group" aria-label="View">
          <button type="button" class="seg__btn" :aria-pressed="!office" @click="showView('list')">List</button>
          <button type="button" class="seg__btn" :aria-pressed="office" @click="showView('office')">Office</button>
        </div>
        <button
          class="primary"
          type="button"
          :aria-expanded="showForm"
          @click="showForm ? (showForm = false) : openForm()"
        >
          {{ showForm ? "Cancel" : "New board" }}
        </button>
      </div>
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
      <label v-if="forRunner" class="choice choice--block">
        <input v-model="withTeam" type="checkbox" :disabled="creating" />
        <span>
          Start with a team
          <span class="hint" style="display: block; margin: 0">
            {{ TEAM_FOR[profile.workspace] || TEAM_FOR.repo }} Each role works to a written standard, so you do not have to ask for
            secure, tested, readable work. Change the team, or turn it off, in the board's settings.
          </span>
        </span>
      </label>
      <div>
        <button class="primary" type="submit" :disabled="creating || !name || (forRunner && creatingRepo && !noRepo(profile.workspace) && !(newRepo.machine_id && newRepo.name))">
          {{ creating ? "Creating…" : "Create board" }}
        </button>
      </div>
    </form>

    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else-if="!office">
      <section aria-labelledby="boards-h" class="stack">
        <h2 v-if="all.length" id="boards-h" :class="shared.length ? 'section-h' : 'sr-only'">Yours</h2>
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

    <template v-else>
      <p v-if="!all.length" class="empty">No boards yet, so the building is empty. Create one, then put it on a machine.</p>
      <template v-else>
        <p class="row small muted" style="margin: 0; gap: 0.6rem">
          <span v-if="liveState" class="livedot" :class="`livedot--${liveState}`" role="status">{{ liveState === "live" ? "Live" : liveState }}</span>
          <span>{{ officeBoards.length }} {{ officeBoards.length === 1 ? "room" : "rooms" }}</span>
          <button v-if="hiddenQuiet" type="button" class="link small" @click="showQuiet = true">Show {{ hiddenQuiet }} quiet {{ hiddenQuiet === 1 ? "board" : "boards" }}</button>
          <button v-else-if="showQuiet" type="button" class="link small" @click="showQuiet = false">Hide quiet boards</button>
        </p>
        <p v-if="!officeLoaded" class="muted" role="status">Opening the office…</p>
        <template v-else>
          <OfficeBuilding
            :boards="officeBoards"
            :duties="officeDuties"
            :recent="officeDone"
            :next="upcoming ? upcoming.next : {}"
            :activity="activity"
            @ask="(key) => waiting && waiting.open(key)"
            @add="(id) => quick && quick.open(id)"
          />
          <QuickDuty ref="quick" :boards="officeBoards" @added="loadOfficeDuties" />
          <WaitingOnYou ref="waiting" :duties="asking" :boards="boardsById" @answered="loadOfficeDuties" />
        </template>
      </template>
    </template>
  </div>
</template>
