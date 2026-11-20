<script setup>
// The board as an office: a desk per role, what each is working on, what is waiting in its tray, and
// duties visibly passing from one desk to the next as they are handed on.
//
// It shows nothing the Duties page does not. It is the same rows, drawn so that someone can watch
// work move — who has it, who it went to, where it is stuck — without reading a column of cards.
// Every duty named here is a link to the duty itself.
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import BoardNav from "../components/BoardNav.vue";
import PixelPerson from "../components/PixelPerson.vue";
import { api, query, subscribeLive } from "../lib/altengine.js";
import { ago } from "../lib/duties.js";
import { plain } from "../lib/markdown.js";
import { activityByDuty, activityLine } from "../lib/runners.js";
import { DESK_SHOWN, levelLabel, officeFeed, officeFloor, roleNames, roleTraits } from "../lib/team.js";

const props = defineProps({ projectId: { type: String, required: true } });

/** Unfinished work is read whole, as on the Duties page; past this a board is too big to draw as desks. */
const WORKING_SET = 200;
const DONE_SHOWN = 6;
const LIVE_STATUSES = ["queued", "active", "needs_decision", "blocked"];
/** People at one desk before the rest are a number: a role can be working several duties at once. */
const SEATS = 3;

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
const floor = computed(() => officeFloor({ roles: roles.value, pointer: pointer.value, duties: duties.value, done: done.value, activity: activityByDuty(runners.value) }));
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
  // A duty handed from one desk to another is the thing worth watching: show it crossing the floor.
  if (ev.handoff) fly(ev.id, ev.handoff);
  if (dutyTimer) return;
  dutyTimer = setTimeout(() => {
    dutyTimer = null;
    loadDuties().catch((err) => (error.value = err.message));
  }, 400);
}

// --- handoffs crossing the floor --------------------------------------------------------------

const floorEl = ref(null);
const flights = ref([]); // [{ id, title, sentBack, from: {x,y}, to: {x,y} }]
const arriving = ref({}); // role id → true, for a moment, when a duty lands on its desk
let flightId = 0;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The middle of a desk, relative to the floor the flights are drawn over. */
function deskPoint(roleId) {
  const root = floorEl.value;
  const el = root && root.querySelector(`[data-desk="${CSS.escape(roleId || "")}"]`);
  if (!root || !el) return null;
  const a = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2 };
}

function land(roleId) {
  arriving.value = { ...arriving.value, [roleId]: true };
  setTimeout(() => {
    const { [roleId]: _gone, ...rest } = arriving.value;
    arriving.value = rest;
  }, 1200);
}

function fly(dutyId, handoff) {
  const from = deskPoint(handoff.from);
  const to = deskPoint(handoff.to);
  const duty = duties.value.find((d) => d.key === dutyId);
  if (!from || !to || reducedMotion.matches) return land(handoff.to);
  flights.value = [...flights.value, { id: ++flightId, title: duty ? duty.title : "A duty", sentBack: !!handoff.sent_back, from, to, to_role: handoff.to }];
}

/** Start a flight once its element exists, and take it off the floor when it lands. */
const started = new WeakSet();
function launch(el, flight) {
  if (!el || started.has(el)) return;
  started.add(el);
  const lift = Math.min(60, Math.abs(flight.to.x - flight.from.x) / 4 + 24);
  const animation = el.animate(
    [
      { transform: `translate(${flight.from.x}px, ${flight.from.y}px) translate(-50%, -50%) scale(0.85)`, opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { transform: `translate(${(flight.from.x + flight.to.x) / 2}px, ${Math.min(flight.from.y, flight.to.y) - lift}px) translate(-50%, -50%) scale(1)`, offset: 0.5 },
      { opacity: 1, offset: 0.88 },
      { transform: `translate(${flight.to.x}px, ${flight.to.y}px) translate(-50%, -50%) scale(0.85)`, opacity: 0 },
    ],
    { duration: 1400, easing: "ease-in-out", fill: "forwards" },
  );
  animation.onfinish = () => {
    flights.value = flights.value.filter((f) => f.id !== flight.id);
    land(flight.to_role);
  };
}

watch(
  () => props.projectId,
  async () => {
    if (socket) socket.close();
    board.value = null;
    duties.value = [];
    done.value = [];
    flights.value = [];
    await open();
    await nextTick();
  },
  { immediate: true },
);
onUnmounted(() => {
  if (socket) socket.close();
  if (dutyTimer) clearTimeout(dutyTimer);
  if (runnerTimer) clearTimeout(runnerTimer);
});

const seats = (desk) => (desk.working.length ? desk.working.slice(0, SEATS) : [null]);
const dutyLink = (d) => ({ name: "duty", params: { projectId: props.projectId, dutyId: d.key } });
/** What a desk is doing, in words — for a screen reader, and for anyone the drawing is not enough for. */
function deskSummary(desk) {
  const doing = desk.working.length ? `working on ${desk.working.map((w) => `“${w.duty.title}”`).join(" and ")}` : "not working on anything";
  return `${desk.role.name}: ${doing}; ${desk.waiting.length} waiting.`;
}
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
          <span v-if="floor.teamed">{{ roles.length }} roles</span>
        </p>
      </div>
      <router-link class="btn" :to="{ name: 'board', params: { projectId } }">Add or manage duties</router-link>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <template v-else-if="board">
      <p v-if="!floor.teamed" class="notice">
        This board has no team, so there is one desk: each duty is worked start to finish by whichever agent claims it.
        <router-link :to="{ name: 'settings', params: { projectId }, query: { tab: 'team' } }">Give it a team</router-link>
        to see duties pass from role to role.
      </p>
      <p v-if="truncated" class="notice notice--warn">This board has more unfinished duties than the office draws. The most recently touched {{ WORKING_SET }} are shown.</p>

      <div class="office">
        <section ref="floorEl" class="floor" aria-labelledby="floor-h">
          <h2 id="floor-h" class="sr-only">The team's desks</h2>
          <ul class="desks">
            <li
              v-for="desk in floor.desks"
              :key="desk.role.id"
              class="desk"
              :class="{ 'desk--working': desk.working.length, 'desk--arriving': arriving[desk.role.id] }"
              :data-desk="desk.role.id"
            >
              <p class="sr-only">{{ deskSummary(desk) }}</p>
              <header class="desk__plate">
                <span class="desk__name">{{ desk.role.name }}</span>
                <span v-if="desk.role.level" class="desk__level" :title="`Runs on a ${levelLabel(desk.role.level).toLowerCase()} model`">{{ levelLabel(desk.role.level) }}</span>
              </header>
              <p class="desk__for" :title="desk.role.summary">
                <template v-if="roleTraits(desk.role).length">{{ roleTraits(desk.role).map((t) => t.label).join(" · ") }}</template>
                <template v-else>{{ desk.role.summary }}</template>
              </p>

              <div class="desk__scene" aria-hidden="true">
                <div class="desk__people">
                  <PixelPerson v-for="(seat, i) in seats(desk)" :key="i" :seed="`${desk.role.id}:${i}`" :working="!!seat" :size="64" />
                  <span v-if="desk.working.length > SEATS" class="desk__extra">+{{ desk.working.length - SEATS }}</span>
                </div>
                <div class="desk__top">
                  <span class="desk__screen"></span>
                  <span class="desk__papers">
                    <span v-for="n in Math.min(desk.waiting.length, 5)" :key="n" class="desk__paper"></span>
                  </span>
                </div>
              </div>

              <div class="desk__now">
                <template v-if="desk.working.length">
                  <p v-for="w in desk.working.slice(0, SEATS)" :key="w.duty.key" class="desk__work">
                    <router-link :to="dutyLink(w.duty)">{{ w.duty.title }}</router-link>
                    <span v-if="w.activity" class="desk__doing">{{ activityLine(w.activity) }}</span>
                    <span v-else class="desk__doing">working since {{ ago(w.duty.claimed_at || w.duty.updated_at) }}</span>
                  </p>
                </template>
                <p v-else class="desk__idle">{{ desk.waiting.length ? (machinesOnline ? "About to start" : "Waiting for a machine to come online") : "Nothing on the desk" }}</p>
              </div>

              <div v-if="desk.waiting.length" class="desk__tray">
                <span class="desk__tray-h">In tray · {{ desk.waiting.length }}</span>
                <ul>
                  <li v-for="d in desk.waiting.slice(0, DESK_SHOWN)" :key="d.key">
                    <router-link :to="dutyLink(d)">{{ d.title }}</router-link>
                    <span v-if="d.handoff && d.handoff.sent_back" class="badge badge--needs_decision" title="A reviewer sent it back with findings">sent back</span>
                  </li>
                </ul>
                <span v-if="desk.waiting.length > DESK_SHOWN" class="muted small">and {{ desk.waiting.length - DESK_SHOWN }} more</span>
              </div>
            </li>
          </ul>

          <span
            v-for="f in flights"
            :key="f.id"
            :ref="(el) => launch(el, f)"
            class="flight"
            :class="{ 'flight--back': f.sentBack }"
            aria-hidden="true"
          >
            <span class="flight__paper"></span>
            <span class="flight__label">{{ f.title }}</span>
          </span>
        </section>

        <aside class="rooms">
          <section class="room room--you" aria-labelledby="room-you-h">
            <h2 id="room-you-h" class="room__h">Meeting room <span class="room__sub">waiting for you · {{ floor.needsYou.length }}</span></h2>
            <ul v-if="floor.needsYou.length" class="room__list">
              <li v-for="d in floor.needsYou.slice(0, 5)" :key="d.key">
                <router-link :to="dutyLink(d)">{{ d.title }}</router-link>
                <span v-if="d.last_question" class="room__note">{{ plain(d.last_question) }}</span>
              </li>
            </ul>
            <p v-else class="room__empty">Nobody is waiting on you.</p>
            <p v-if="floor.needsYou.length > 5" class="muted small" style="margin: 0">and {{ floor.needsYou.length - 5 }} more</p>
          </section>

          <section v-if="floor.blocked.length" class="room" aria-labelledby="room-blocked-h">
            <h2 id="room-blocked-h" class="room__h">Waiting room <span class="room__sub">behind other work · {{ floor.blocked.length }}</span></h2>
            <ul class="room__list">
              <li v-for="d in floor.blocked.slice(0, 4)" :key="d.key"><router-link :to="dutyLink(d)">{{ d.title }}</router-link></li>
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
            <p v-else class="room__empty">{{ floor.teamed ? "No duty has been handed on yet." : "Handoffs appear here once the board has a team." }}</p>
          </section>

          <section class="room room--done" aria-labelledby="room-done-h">
            <h2 id="room-done-h" class="room__h">Out tray <span class="room__sub">finished</span></h2>
            <ul v-if="floor.done.length" class="room__list">
              <li v-for="d in floor.done" :key="d.key">
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

/* The floor: a faint grid, like tiles, so the desks read as standing in a room. */
.floor {
  position: relative;
  border: 2px solid var(--border-strong);
  border-radius: 6px;
  padding: 1rem;
  background-color: var(--surface);
  background-image: linear-gradient(var(--surface-2) 1px, transparent 1px), linear-gradient(90deg, var(--surface-2) 1px, transparent 1px);
  background-size: 24px 24px;
  overflow: hidden;
}
.desks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); gap: 1rem; }
.desk {
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: 4px;
  padding: 0.7rem 0.8rem 0.8rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.desk--working { border-color: var(--accent); }
.desk--arriving { border-color: var(--ok); box-shadow: 0 0 0 4px var(--ok-soft); }

.desk__plate { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.desk__name { font-family: var(--mono); font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; font-size: 0.85rem; overflow-wrap: anywhere; }
.desk__level { font-family: var(--mono); font-size: 0.7rem; color: var(--text-dim); border: 1px solid var(--border-strong); padding: 0 0.3rem; white-space: nowrap; }
.desk__for { margin: 0; font-size: 0.78rem; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* The person sits behind the desk: the desk top overlaps the bottom of the character. */
.desk__scene { display: flex; flex-direction: column; align-items: center; margin-top: 0.35rem; }
.desk__people { display: flex; align-items: flex-end; justify-content: center; gap: 0.15rem; min-height: 64px; }
.desk__extra { font-family: var(--mono); font-size: 0.8rem; color: var(--text-dim); padding-bottom: 0.6rem; }
.desk__top {
  position: relative;
  width: min(100%, 13rem);
  height: 22px;
  margin-top: -8px;
  background: var(--border);
  border: 2px solid var(--border-strong);
  border-bottom-width: 5px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0 0.5rem;
}
.desk__screen { width: 26px; height: 18px; margin-top: -14px; background: var(--surface-2); border: 2px solid var(--border-strong); }
.desk--working .desk__screen { background: var(--accent); }
@media (prefers-reduced-motion: no-preference) {
  .desk--working .desk__screen { animation: screen-glow 1.2s steps(2, jump-none) infinite; }
}
@keyframes screen-glow {
  from { opacity: 1; }
  to { opacity: 0.6; }
}
.desk__papers { display: flex; flex-direction: column-reverse; gap: 1px; margin-top: -10px; }
.desk__paper { width: 20px; height: 3px; background: var(--surface); border: 1px solid var(--border-strong); }

.desk__now { min-height: 2.6rem; }
.desk__work { margin: 0; font-size: 0.88rem; line-height: 1.3; }
.desk__work + .desk__work { margin-top: 0.3rem; }
.desk__work a { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.desk__doing { display: block; font-size: 0.78rem; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk__idle { margin: 0; font-size: 0.85rem; color: var(--text-dim); }

.desk__tray { border-top: 1px dashed var(--border-strong); padding-top: 0.4rem; font-size: 0.83rem; }
.desk__tray-h { font-family: var(--mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim); }
.desk__tray ul { list-style: none; margin: 0.2rem 0 0; padding: 0; display: grid; gap: 0.15rem; }
.desk__tray li { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
.desk__tray a { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* A duty in the air between two desks. Positioned by the animation that carries it. */
.flight { position: absolute; top: 0; left: 0; z-index: 2; display: flex; align-items: center; gap: 0.35rem; pointer-events: none; opacity: 0; }
.flight__paper { width: 14px; height: 18px; background: var(--surface); border: 2px solid var(--accent); box-shadow: 2px 2px 0 var(--border-strong); }
.flight__label { font-family: var(--mono); font-size: 0.72rem; background: var(--accent); color: var(--accent-text); padding: 0.05rem 0.35rem; max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flight--back .flight__paper { border-color: var(--warn); }
.flight--back .flight__label { background: var(--warn); }

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
