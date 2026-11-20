<script setup>
// Every board at once, as one office building: a room of cubicles per board — a desk per role on its
// team — and a breakroom they share. Whoever has nothing in hand is in the breakroom; a duty crosses
// the floor as it is handed on. What waits on you is answered under the building, and any duty, or
// the recurring duty a desk is on call for, opens in a panel over it.
import { computed, onUnmounted, ref, watch } from "vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { isQuiet, runsByDuty } from "../lib/boards.js";
import { useBoards } from "../lib/useBoards.js";
import { useDutyPanel } from "../lib/useDutyPanel.js";
import OfficeBuilding from "../components/OfficeBuilding.vue";
import WaitingOnYou from "../components/WaitingOnYou.vue";
import QuickDuty from "../components/QuickDuty.vue";
import DutyDrawer from "../components/DutyDrawer.vue";
import ScheduleDrawer from "../components/ScheduleDrawer.vue";

const { all, loading, error, counts, runners, upcoming, loadRunners } = useBoards({ onRefresh: () => loadOffice() });

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

// A duty, or a recurring duty from the desk on call for it, read over the office — kept in the
// address with the board it is `on` (see useDutyPanel).
const { reading, readingSchedule, openDuty, openSchedule, closeDuty, closeSchedule } = useDutyPanel();
/** A "?" desk: its duty, open over the office, where it can be answered. */
function openAsking(key) {
  const d = asking.value.find((x) => x.key === key);
  if (d) openDuty({ projectId: d.project_id, dutyId: d.key });
}

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
  if (!ids.length) return;
  socket = subscribeLive({ mintWith: () => api("/live/boards", { project_ids: ids }) }, onEvent, (s) => (liveState.value = s));
}

const liveKey = computed(() => officeBoards.value.map((b) => b.project_id).join(","));
watch(() => all.value.length, (n) => n && loadOffice(), { immediate: true });
watch(liveKey, watchLive);
onUnmounted(() => {
  if (socket) socket.close();
  clearTimeout(dutyTimer);
  clearTimeout(runnerTimer);
});
</script>

<template>
  <div class="wrap wrap--board stack">
    <div>
      <h1>Office</h1>
      <p class="muted small" style="margin: 0">Each board is a room of cubicles, one per role. Whoever has nothing in hand is in the breakroom.</p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-else-if="!all.length" class="empty">No boards yet, so the building is empty. Create one, then put it on a machine.</p>
    <template v-else>
      <div class="row row--between">
        <p class="row small muted" style="margin: 0; gap: 0.6rem">
          <span v-if="liveState" class="livedot" :class="`livedot--${liveState}`" role="status">{{ liveState === "live" ? "Live" : liveState }}</span>
          <span>{{ officeBoards.length }} {{ officeBoards.length === 1 ? "room" : "rooms" }}</span>
          <button v-if="hiddenQuiet" type="button" class="link small" @click="showQuiet = true">Show {{ hiddenQuiet }} quiet {{ hiddenQuiet === 1 ? "board" : "boards" }}</button>
          <button v-else-if="showQuiet" type="button" class="link small" @click="showQuiet = false">Hide quiet boards</button>
        </p>
        <!-- At the top, and opening over the office: no scrolling down to file something. -->
        <QuickDuty ref="quick" :boards="officeBoards" @added="loadOfficeDuties" />
      </div>
      <p v-if="!officeLoaded" class="muted" role="status">Opening the office…</p>
      <template v-else>
        <OfficeBuilding
          :boards="officeBoards"
          :duties="officeDuties"
          :recent="officeDone"
          :next="upcoming ? upcoming.next : {}"
          :activity="activity"
          @ask="(key) => openAsking(key)"
          @add="(id) => quick && quick.open(id)"
          @open="openDuty"
          @schedule="openSchedule"
        />
        <WaitingOnYou ref="waiting" :duties="asking" :boards="boardsById" @answered="loadOfficeDuties" @open="openDuty" />
        <DutyDrawer v-if="reading" :key="reading.dutyId" :project-id="reading.projectId" :duty-id="reading.dutyId" @close="closeDuty" />
        <ScheduleDrawer v-else-if="readingSchedule" :key="readingSchedule.scheduleId" :project-id="readingSchedule.projectId" :schedule-id="readingSchedule.scheduleId" @close="closeSchedule" @open="openDuty" />
      </template>
    </template>
  </div>
</template>
