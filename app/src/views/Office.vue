<script setup>
// One board as an office: its room of cubicles, one per role, and the breakroom its idle roles wait
// in — the same building the Boards page draws for every board, here with what is beside it: who is
// waiting on you, the latest handoffs, and what has just been finished.
//
// It shows nothing the Duties page does not. It is the same rows, drawn so that someone can watch
// work move — who has it, who it went to, where it is stuck — without reading a column of cards.
// Every duty named here is a link to the duty itself.
import { computed, onUnmounted, ref, watch } from "vue";
import BoardNav from "../components/BoardNav.vue";
import OfficeBuilding from "../components/OfficeBuilding.vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { plain } from "../lib/markdown.js";
import { activityByDuty } from "../lib/runners.js";
import { officeFeed, roleNames } from "../lib/team.js";

const props = defineProps({ projectId: { type: String, required: true } });

/** Unfinished work is read whole, as on the Duties page; past this a board is too big to draw as desks. */
const WORKING_SET = 200;
const DONE_SHOWN = 6;
const LIVE_STATUSES = ["queued", "active", "needs_decision", "blocked"];

const board = ref(null);
const roles = ref([]);
const duties = ref([]);
const done = ref([]);
const runners = ref([]);
const loading = ref(true);
const error = ref("");
const liveState = ref("connecting");
const truncated = ref(false);

const pointer = computed(() => (board.value && board.value.roster) || null);
const names = computed(() => roleNames(roles.value));
const activity = computed(() => activityByDuty(runners.value));
/** The building holds one room: this board's, with its team. */
const rooms = computed(() => (board.value ? [{ project_id: props.projectId, name: board.value.name, roster: pointer.value && pointer.value.intake ? { intake: pointer.value.intake, roles: roles.value } : null }] : []));
const teamed = computed(() => !!(pointer.value && pointer.value.intake && roles.value.length));
const needsYou = computed(() => duties.value.filter((d) => d.status === "needs_decision").sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0)));
const blocked = computed(() => duties.value.filter((d) => d.status === "blocked"));
const finished = computed(() => [...done.value].sort((a, b) => (b.finished_at || b.updated_at || 0) - (a.finished_at || a.updated_at || 0)));
const feed = computed(() => officeFeed([...duties.value, ...done.value], names.value));
const machinesOnline = computed(() => runners.value.filter((r) => r.online !== false).length);

const flat = (doc) => ({ ...doc.data, key: String(doc.key) });

async function loadDuties() {
  const [live, finished] = await Promise.all([
    query("duties", {
      where: [
        { field: "project_id", op: "=", value: props.projectId },
        { field: "status", op: "in", value: LIVE_STATUSES },
      ],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: WORKING_SET,
    }),
    query("duties", {
      where: [
        { field: "project_id", op: "=", value: props.projectId },
        { field: "status", op: "=", value: "done" },
      ],
      order: [{ field: "updated_at", dir: "desc" }],
      limit: DONE_SHOWN,
    }),
  ]);
  duties.value = (live.documents || []).map(flat);
  truncated.value = duties.value.length >= WORKING_SET;
  done.value = (finished.documents || []).map(flat);
}

async function loadTeam() {
  if (!(pointer.value && pointer.value.intake)) return (roles.value = []);
  try {
    roles.value = (await api("/board/roster", { project_id: props.projectId })).roles || [];
  } catch {
    roles.value = [];
  }
}

let socket = null;
let dutyTimer = null;
let runnerTimer = null;

async function open() {
  loading.value = true;
  error.value = "";
  try {
    const res = await api("/board/open", { project_id: props.projectId });
    board.value = res.project || null;
    runners.value = res.runners || [];
    await Promise.all([loadTeam(), loadDuties()]);
    connect(res.live || null);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function connect(mint) {
  if (socket) socket.close();
  socket = subscribeLive({ projectId: props.projectId, mint }, onEvent, (s) => (liveState.value = s));
}

function onEvent(frame) {
  const ev = frame && frame.data;
  if (!ev) return;
  if (ev.t === "runner") {
    if (runnerTimer) return;
    runnerTimer = setTimeout(async () => {
      runnerTimer = null;
      runners.value = (await api("/board/runners", { project_id: props.projectId }).catch(() => ({ runners: runners.value }))).runners || [];
    }, 1000);
    return;
  }
  if (ev.t === "board") {
    if (ev.what === "roster") api("/board/open", { project_id: props.projectId }).then((res) => ((board.value = res.project || board.value), loadTeam())).catch(() => {});
    return;
  }
  if (dutyTimer) return;
  dutyTimer = setTimeout(() => {
    dutyTimer = null;
    loadDuties().catch((err) => (error.value = err.message));
  }, 400);
}

watch(
  () => props.projectId,
  async () => {
    if (socket) socket.close();
    board.value = null;
    duties.value = [];
    done.value = [];
    await open();
  },
  { immediate: true },
);
onUnmounted(() => {
  if (socket) socket.close();
  if (dutyTimer) clearTimeout(dutyTimer);
  if (runnerTimer) clearTimeout(runnerTimer);
});

const dutyLink = (d) => ({ name: "duty", params: { projectId: props.projectId, dutyId: d.key } });
</script>

<template>
  <div class="wrap wrap--board stack">
    <BoardNav :project-id="projectId" :name="board?.name" active="office" />
    <div class="row row--between">
      <div>
        <h1>{{ board ? board.name : projectId }} <span class="muted" style="font-weight: 500">— the office</span></h1>
        <p class="row small muted" style="margin: 0; gap: 0.6rem">
          <span class="livedot" :class="`livedot--${liveState}`" role="status">{{ liveState === "live" ? "Live" : liveState }}</span>
          <span v-if="runners.length">{{ machinesOnline }} of {{ runners.length }} {{ runners.length === 1 ? "machine" : "machines" }} online</span>
          <span v-else>No machine works this board yet</span>
          <span v-if="teamed">{{ roles.length }} roles</span>
        </p>
      </div>
      <router-link class="btn" :to="{ name: 'board', params: { projectId } }">Add or manage duties</router-link>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else-if="board">
      <p v-if="!teamed" class="notice">
        This board has no team, so there is one cubicle: each duty is worked start to finish by whichever agent claims it.
        <router-link :to="{ name: 'settings', params: { projectId }, query: { tab: 'team' } }">Give it a team</router-link>
        to see duties pass from role to role.
      </p>
      <p v-if="truncated" class="notice notice--warn">This board has more unfinished duties than the office draws. The most recently touched {{ WORKING_SET }} are shown.</p>

      <div class="office">
        <section aria-labelledby="floor-h" style="min-width: 0">
          <h2 id="floor-h" class="sr-only">The team</h2>
          <OfficeBuilding :boards="rooms" :duties="duties" :activity="activity" single />
        </section>

        <aside class="rooms">
          <section class="room room--you" aria-labelledby="room-you-h">
            <h2 id="room-you-h" class="room__h">Meeting room <span class="room__sub">waiting for you · {{ needsYou.length }}</span></h2>
            <ul v-if="needsYou.length" class="room__list">
              <li v-for="d in needsYou.slice(0, 5)" :key="d.key">
                <router-link :to="dutyLink(d)">{{ d.title }}</router-link>
                <span v-if="d.last_question" class="room__note">{{ plain(d.last_question) }}</span>
              </li>
            </ul>
            <p v-else class="room__empty">Nobody is waiting on you.</p>
            <p v-if="needsYou.length > 5" class="muted small" style="margin: 0">and {{ needsYou.length - 5 }} more</p>
          </section>

          <section v-if="blocked.length" class="room" aria-labelledby="room-blocked-h">
            <h2 id="room-blocked-h" class="room__h">Waiting room <span class="room__sub">behind other work · {{ blocked.length }}</span></h2>
            <ul class="room__list">
              <li v-for="d in blocked.slice(0, 4)" :key="d.key"><router-link :to="dutyLink(d)">{{ d.title }}</router-link></li>
            </ul>
          </section>

          <section class="room" aria-labelledby="room-feed-h">
            <h2 id="room-feed-h" class="room__h">Across the floor <span class="room__sub">latest handoffs</span></h2>
            <ul v-if="feed.length" class="room__list">
              <li v-for="e in feed" :key="e.key">
                <router-link :to="{ name: 'duty', params: { projectId, dutyId: e.duty_id } }">{{ e.title }}</router-link>
                <span class="room__note" :class="{ 'room__note--back': e.sent_back }">{{ e.text }} · {{ ago(e.at) }}</span>
              </li>
            </ul>
            <p v-else class="room__empty">{{ teamed ? "No duty has been handed on yet." : "Handoffs appear here once the board has a team." }}</p>
          </section>

          <section class="room room--done" aria-labelledby="room-done-h">
            <h2 id="room-done-h" class="room__h">Out tray <span class="room__sub">finished</span></h2>
            <ul v-if="finished.length" class="room__list">
              <li v-for="d in finished" :key="d.key">
                <router-link :to="dutyLink(d)">{{ d.title }}</router-link>
                <span class="room__note">{{ ago(d.finished_at || d.updated_at) }}</span>
              </li>
            </ul>
            <p v-else class="room__empty">Nothing finished yet.</p>
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.office { display: grid; grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem); gap: 1rem; align-items: start; }
@media (max-width: 1000px) {
  .office { grid-template-columns: minmax(0, 1fr); }
}

.rooms { display: grid; gap: 0.75rem; min-width: 0; }
.room { border: 2px solid var(--border); border-radius: 4px; background: var(--surface); padding: 0.7rem 0.8rem; min-width: 0; }
.room--you { border-color: var(--warn); }
.room__h { margin: 0 0 0.35rem; font-family: var(--mono); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.02em; }
.room__sub { font-family: inherit; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--text-dim); font-size: 0.78rem; margin-left: 0.3rem; }
.room__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; font-size: 0.88rem; }
.room__list li { min-width: 0; }
.room__list a { color: var(--text); font-weight: 550; overflow-wrap: anywhere; }
.room__note { display: block; font-size: 0.78rem; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.room__note--back { color: var(--warn); }
.room__empty { margin: 0; font-size: 0.85rem; color: var(--text-dim); }
</style>
