<script setup>
// The office building: one room per board with a cubicle per role, and a breakroom every board
// shares. A role working a duty sits at its cubicle typing; one with nothing in hand is in the
// breakroom with a mug, its tray at the desk stacked with whatever waits for it. When a role is
// handed work it walks to its desk, and the duty itself crosses the room from one cubicle to the next.
//
// It draws only what the rows already say; every duty in it is a link to the duty. The drawing is
// for looking at; the same thing is said in words for a screen reader, and on hover or focus.
import { computed, nextTick, reactive, ref, watch } from "vue";
import PixelPerson from "./PixelPerson.vue";
import PixelSprite from "./PixelSprite.vue";
import { activityLine } from "../lib/runners.js";
import { SEATS, TRAY_SHOWN, buildingFloor, floorMoves, levelLabel } from "../lib/team.js";

const props = defineProps({
  // `[{ project_id, name, roster }]`; `roster` is `{ intake, roles }`, or null for a board with no team.
  boards: { type: Array, required: true },
  // The unfinished duties of all of them.
  duties: { type: Array, required: true },
  // What machines say they are doing, by duty.
  activity: { type: Object, default: () => ({}) },
  // One board's own office: its name is the heading, not a link.
  single: { type: Boolean, default: false },
});

/** People drawn in the breakroom before the rest are a number. */
const BREAK_SHOWN = 40;

const floor = computed(() => buildingFloor({ boards: props.boards, duties: props.duties, activity: props.activity }));
/** The cubicle being pointed at or focused, whose details the strip under the building shows. */
const pointed = ref(null);
const pointedRoom = computed(() => pointed.value && floor.value.rooms.find((r) => r.desks.some((d) => d.key === pointed.value)));
const pointedDesk = computed(() => pointedRoom.value && pointedRoom.value.desks.find((d) => d.key === pointed.value));
const loitering = computed(() => floor.value.breakroom.slice(0, BREAK_SHOWN));
const moreLoitering = computed(() => floor.value.breakroom.length - loitering.value.length);

const dutyLink = (d) => ({ name: "duty", params: { projectId: d.project_id, dutyId: d.key } });
/** Where a cubicle takes you: what it is working on, else the next thing in its tray, else the board. */
function deskLink(room, desk) {
  const d = (desk.working[0] && desk.working[0].duty) || desk.tray[0];
  if (d) return dutyLink(d);
  return props.single ? null : { name: "office", params: { projectId: room.board.project_id } };
}
function deskSays(desk) {
  if (desk.working.length) {
    const w = desk.working[0];
    const doing = w.activity ? activityLine(w.activity) : "working";
    return `${desk.role.name}: “${w.duty.title}” — ${doing}${desk.working.length > 1 ? `, and ${desk.working.length - 1} more` : ""}`;
  }
  return `${desk.role.name}: on a break${desk.tray.length ? `, ${desk.tray.length} waiting in the tray` : ""}`;
}

// --- movement ----------------------------------------------------------------------------------

const root = ref(null);
const walkers = ref([]); // [{ id, key, from: {x,y}, to: {x,y} }]
const papers = ref([]); // [{ id, title, from, to }]
const arriving = reactive({}); // person key → true while they walk there
let nextId = 0;
const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)");

function centre(selector) {
  const box = root.value;
  const el = box && box.querySelector(selector);
  if (!el) return null;
  const a = box.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return { x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2 };
}
const personAt = (key) => centre(`[data-person="${CSS.escape(key)}"]`);
const deskAt = (key) => centre(`[data-desk="${CSS.escape(key)}"]`);

// Runs before the page redraws, so where everyone was can still be measured; then after, for where
// they are going.
watch(
  floor,
  async (after, before) => {
    if (!before || !root.value || (reducedMotion && reducedMotion.matches)) return;
    const { walks, handoffs } = floorMoves(before, after);
    if (!walks.length && !handoffs.length) return;
    const starts = new Map(walks.map((w) => [w.key, personAt(w.key)]));
    const deskStarts = new Map(handoffs.map((h) => [h.from, deskAt(h.from)]));
    for (const w of walks) if (starts.get(w.key)) arriving[w.key] = true;
    await nextTick();
    for (const w of walks) {
      const from = starts.get(w.key);
      const to = personAt(w.key);
      if (from && to) walkers.value.push({ id: ++nextId, key: w.key, from, to });
      else delete arriving[w.key];
    }
    for (const h of handoffs) {
      const from = deskStarts.get(h.from);
      const to = deskAt(h.to);
      const duty = props.duties.find((d) => d.key === h.duty);
      if (from && to) papers.value.push({ id: ++nextId, title: duty ? duty.title : "", from, to });
    }
  },
  { flush: "pre" },
);

/** Moves one walker or paper along its path, then takes it off the floor. */
const started = new WeakSet();
function animate(el, item, kind) {
  if (!el || started.has(el)) return;
  started.add(el);
  const { from, to } = item;
  const lift = kind === "paper" ? Math.min(50, Math.abs(to.x - from.x) / 4 + 18) : 0;
  const frames =
    kind === "paper"
      ? [
          { transform: `translate(${from.x}px, ${from.y}px) translate(-50%, -50%) scale(0.8)`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { transform: `translate(${(from.x + to.x) / 2}px, ${Math.min(from.y, to.y) - lift}px) translate(-50%, -50%) scale(1)`, offset: 0.5 },
          { opacity: 1, offset: 0.85 },
          { transform: `translate(${to.x}px, ${to.y}px) translate(-50%, -50%) scale(0.8)`, opacity: 0 },
        ]
      : [
          { transform: `translate(${from.x}px, ${from.y}px) translate(-50%, -50%)` },
          { transform: `translate(${to.x}px, ${to.y}px) translate(-50%, -50%)` },
        ];
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = kind === "paper" ? 1300 : Math.min(2400, Math.max(700, distance * 3));
  const run = el.animate(frames, { duration, easing: kind === "paper" ? "ease-in-out" : "linear", fill: "forwards" });
  run.onfinish = () => {
    if (kind === "paper") papers.value = papers.value.filter((p) => p.id !== item.id);
    else {
      walkers.value = walkers.value.filter((w) => w.id !== item.id);
      delete arriving[item.key];
    }
  };
}
</script>

<template>
  <div ref="root" class="building" :class="{ 'building--single': single }">
    <!-- What the drawing shows, in words. -->
    <div class="sr-only">
      <h3>The breakroom</h3>
      <p v-if="!floor.breakroom.length">Nobody is on a break.</p>
      <ul v-else>
        <li v-for="p in floor.breakroom" :key="p.key">{{ p.role.name }}{{ single ? "" : ` of ${p.board.name}` }}, on a break{{ p.waiting ? `, ${p.waiting} waiting` : "" }}</li>
      </ul>
    </div>

    <section class="room room--break" aria-label="Breakroom">
      <header class="plate">
        <span class="plate__name">Breakroom</span>
        <span class="plate__note">{{ floor.breakroom.length ? `${floor.breakroom.length} on a break` : "empty — everyone is working" }}</span>
      </header>
      <div class="break">
        <div class="break__kitchen">
          <PixelSprite name="fridge" :scale="4" />
          <div class="break__counter">
            <PixelSprite class="break__coffee" name="coffee" :scale="3" />
            <PixelSprite name="counter" :scale="4" />
          </div>
        </div>
        <ul class="break__crowd" aria-hidden="true">
          <li
            v-for="p in loitering"
            :key="p.key"
            class="loiter"
            :class="{ 'is-arriving': arriving[p.key] }"
            :data-person="p.key"
            :title="`${p.role.name}${single ? '' : ` · ${p.board.name}`} — on a break${p.waiting ? ` (${p.waiting} waiting)` : ''}`"
          >
            <PixelPerson pose="stand" :seed="p.key" :size="26" />
            <span class="loiter__tag" :style="{ background: p.color }"></span>
          </li>
          <li v-if="moreLoitering" class="loiter loiter--more">+{{ moreLoitering }}</li>
        </ul>
        <div class="break__lounge">
          <PixelSprite name="table" :scale="3" />
          <PixelSprite name="couch" :scale="3" />
          <PixelSprite name="plant" :scale="3" />
        </div>
      </div>
    </section>

    <div class="rooms">
    <section v-for="room in floor.rooms" :key="room.board.project_id" class="room" :style="{ '--room': room.color }" :aria-label="`${room.board.name}'s office`">
      <header class="plate">
        <span v-if="single" class="plate__name">{{ room.board.name }}</span>
        <router-link v-else class="plate__name" :to="{ name: 'office', params: { projectId: room.board.project_id } }">{{ room.board.name }}</router-link>
        <router-link
          v-if="room.needsYou.length"
          class="plate__ask"
          :to="dutyLink(room.needsYou[0])"
          :title="room.needsYou.map((d) => d.title).join('\n')"
        >
          <span aria-hidden="true">?</span> {{ room.needsYou.length }} {{ room.needsYou.length === 1 ? "needs" : "need" }} you
        </router-link>
        <span v-if="room.blocked" class="plate__note">{{ room.blocked }} blocked</span>
        <span v-if="!room.teamed" class="plate__note">no team</span>
      </header>

      <ul class="cubes">
        <li v-for="desk in room.desks" :key="desk.key">
          <component
            :is="deskLink(room, desk) ? 'router-link' : 'div'"
            :to="deskLink(room, desk) || undefined"
            class="cube"
            :class="{ 'cube--working': desk.working.length }"
            :data-desk="desk.key"
            :aria-label="deskSays(desk)"
            @mouseenter="pointed = desk.key"
            @mouseleave="pointed = null"
            @focus="pointed = desk.key"
            @blur="pointed = null"
          >
            <span class="cube__seat">
              <span v-for="(w, i) in desk.working.slice(0, SEATS)" :key="w.duty.key" :data-person="i === 0 ? desk.key : undefined" :class="{ 'is-arriving': i === 0 && arriving[desk.key] }">
                <PixelPerson pose="desk" :seed="i === 0 ? desk.key : `${desk.key}:${i}`" :working="true" :size="34" />
              </span>
              <span v-if="!desk.working.length" class="cube__chair" aria-hidden="true"></span>
              <span v-if="desk.working.length > SEATS" class="cube__more" aria-hidden="true">+{{ desk.working.length - SEATS }}</span>
            </span>
            <span class="cube__desk" aria-hidden="true">
              <span class="cube__screen"></span>
              <span v-if="desk.tray.length" class="cube__tray">
                <span v-for="n in Math.min(desk.tray.length, 4)" :key="n" class="cube__paper"></span>
                <span class="cube__count">{{ desk.tray.length }}</span>
              </span>
            </span>
            <span class="cube__label" aria-hidden="true">{{ desk.role.name }}</span>
            <span v-if="desk.working.length" class="cube__bubble" aria-hidden="true"><i></i><i></i><i></i></span>
          </component>
        </li>
      </ul>
    </section>
    </div>

    <!-- What the cubicle under the pointer or the focus is doing, in words — in the building, so it
         is never clipped or off the screen. Screen readers have each cubicle's own label instead. -->
    <div class="info" aria-hidden="true">
      <template v-if="pointedDesk">
        <span class="info__who">
          <strong>{{ pointedDesk.role.name }}</strong>
          <span v-if="pointedDesk.role.level" class="info__level">{{ levelLabel(pointedDesk.role.level) }}</span>
          <span v-if="!single" class="info__board" :style="{ borderColor: pointedRoom.color }">{{ pointedRoom.board.name }}</span>
        </span>
        <span v-if="pointedDesk.working.length" class="info__line">
          <template v-for="(w, i) in pointedDesk.working" :key="w.duty.key">{{ i ? " · " : "" }}{{ w.duty.title }}<em v-if="w.activity"> — {{ activityLine(w.activity) }}</em></template>
        </span>
        <span v-else class="info__line">On a break{{ pointedDesk.tray.length ? "" : ", nothing waiting" }}</span>
        <span v-if="pointedDesk.tray.length" class="info__line info__line--dim">
          In the tray: {{ pointedDesk.tray.slice(0, TRAY_SHOWN).map((d) => d.title).join(" · ") }}{{ pointedDesk.tray.length > TRAY_SHOWN ? ` · and ${pointedDesk.tray.length - TRAY_SHOWN} more` : "" }}
        </span>
      </template>
      <span v-else class="info__line info__line--dim">Point at or focus a cubicle to see what it is working on and what is in its tray; select it to open the duty.</span>
    </div>

    <span v-for="w in walkers" :key="w.id" :ref="(el) => animate(el, w, 'walk')" class="walker" aria-hidden="true">
      <PixelPerson pose="stand" :seed="w.key" :size="26" />
    </span>
    <span v-for="p in papers" :key="p.id" :ref="(el) => animate(el, p, 'paper')" class="paper" aria-hidden="true">
      <span class="paper__sheet"></span>
      <span v-if="p.title" class="paper__label">{{ p.title }}</span>
    </span>
  </div>
</template>

<style scoped>
/* The walls are the gaps between rooms: the building's background shows through them. The breakroom
   runs the width of the building; the boards' rooms share the floor below it. */
.building {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 5px;
  background: var(--office-wall);
  border-radius: 6px;
}
.rooms { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 5px; }
.room {
  position: relative;
  min-width: 0;
  background-color: var(--office-floor);
  background-image: repeating-linear-gradient(0deg, transparent 0 17px, var(--office-floor-line) 17px 18px);
  padding: 0.5rem 0.55rem 0.7rem;
}
/* A door into the hall below. */
.room::after {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 50%;
  width: 34px;
  height: 5px;
  margin-left: -17px;
  background: var(--office-floor);
}
.room--break {
  background-color: var(--office-tile);
  background-image: conic-gradient(var(--office-tile-2) 25%, transparent 0 50%, var(--office-tile-2) 0 75%, transparent 0);
  background-size: 20px 20px;
}
.room--break::after { background: var(--office-tile); }

.plate { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.2rem 0.6rem; margin-bottom: 0.45rem; font-size: 0.8rem; }
.plate__name {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text);
  background: var(--surface);
  border: 2px solid var(--room, var(--office-wall));
  padding: 0.05rem 0.4rem;
  text-decoration: none;
  overflow-wrap: anywhere;
}
a.plate__name:hover { text-decoration: underline; }
.plate__note { color: var(--text-dim); font-size: 0.76rem; }
.plate__ask {
  font-size: 0.76rem;
  font-weight: 650;
  color: var(--warn);
  background: var(--warn-soft);
  border: 1px solid currentColor;
  padding: 0 0.4rem;
  border-radius: 999px;
  text-decoration: none;
}

/* --- the breakroom ---------------------------------------------------------------------------- */
.break { display: flex; align-items: flex-end; gap: 0.9rem; flex-wrap: wrap; min-height: 64px; }
.break__kitchen { display: flex; align-items: flex-end; gap: 4px; }
.break__counter { display: flex; flex-direction: column; align-items: flex-start; }
.break__coffee { margin-left: 8px; }
.break__lounge { display: flex; align-items: flex-end; gap: 6px; margin-left: auto; }
.break__crowd { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 4px 6px; flex: 1 1 10rem; min-width: 0; }
.loiter { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.loiter__tag { width: 10px; height: 3px; border-radius: 1px; }
.loiter--more { font-family: var(--mono); font-size: 0.78rem; color: var(--text-dim); align-self: center; }
@media (prefers-reduced-motion: no-preference) {
  .loiter:nth-child(3n) :deep(.person) { animation: sip 3.2s steps(1) infinite; }
  .loiter:nth-child(3n + 1) :deep(.person) { animation: sip 4.1s steps(1) infinite 1s; }
}
@keyframes sip {
  0%, 85% { transform: translateY(0); }
  86%, 100% { transform: translateY(-1px); }
}

/* --- cubicles --------------------------------------------------------------------------------- */
.cubes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 8px 6px; }
.cube {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 94px;
  padding-top: 5px;
  border: 3px solid var(--office-partition);
  border-bottom: 0;
  border-radius: 2px 2px 0 0;
  background: color-mix(in srgb, var(--room) 16%, var(--office-floor));
  color: var(--text);
  text-decoration: none;
}
a.cube:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.cube__seat { display: flex; align-items: flex-end; justify-content: center; gap: 1px; height: 34px; position: relative; z-index: 0; }
.cube__chair { width: 18px; height: 16px; margin-bottom: -2px; background: var(--office-chair); border-radius: 5px 5px 2px 2px; }
.cube__more { font-family: var(--mono); font-size: 0.68rem; color: var(--text-dim); align-self: center; }
.cube__desk {
  position: relative;
  z-index: 1;
  width: 86%;
  height: 11px;
  margin-top: -4px;
  background: var(--office-desk);
  border-bottom: 4px solid var(--office-desk-edge);
}
.cube__screen {
  position: absolute;
  left: 6px;
  bottom: 9px;
  width: 15px;
  height: 11px;
  background: var(--office-screen);
  border: 2px solid var(--office-desk-edge);
}
.cube--working .cube__screen { background: #6fb2ff; box-shadow: 0 0 6px #6fb2ff99; }
.cube__tray { position: absolute; right: 5px; bottom: 8px; display: flex; flex-direction: column-reverse; align-items: center; }
.cube__paper { width: 14px; height: 3px; background: #f4f1ea; border: 1px solid #a7a091; margin-top: -1px; }
.cube__count {
  position: absolute;
  top: -12px;
  right: -7px;
  min-width: 14px;
  font-family: var(--mono);
  font-size: 0.62rem;
  line-height: 14px;
  text-align: center;
  color: var(--accent-text);
  background: var(--room);
  border-radius: 7px;
  padding: 0 3px;
}
.cube__label {
  margin-top: auto;
  margin-bottom: 4px;
  max-width: 100%;
  padding: 0 4px;
  font-family: var(--mono);
  font-size: 0.66rem;
  line-height: 1.2;
  text-align: center;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cube__bubble {
  position: absolute;
  top: -9px;
  right: 6px;
  display: flex;
  gap: 2px;
  padding: 3px 4px;
  background: var(--surface);
  border: 2px solid var(--text);
  border-radius: 3px;
  z-index: 2;
}
.cube__bubble i { width: 3px; height: 3px; background: var(--text); }
@media (prefers-reduced-motion: no-preference) {
  .cube__bubble i { animation: typing 1.2s steps(1) infinite; }
  .cube__bubble i:nth-child(2) { animation-delay: 0.2s; }
  .cube__bubble i:nth-child(3) { animation-delay: 0.4s; }
}
@keyframes typing {
  0%, 60% { opacity: 1; }
  61%, 100% { opacity: 0.2; }
}

/* The strip under the building that says what the pointed-at cubicle is doing. */
.info {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.8rem;
  min-height: 2.6rem;
  padding: 0.45rem 0.7rem;
  font-size: 0.82rem;
  background: var(--surface);
  color: var(--text);
}
.info__who { display: inline-flex; align-items: baseline; gap: 0.45rem; }
.info__level { font-family: var(--mono); font-size: 0.7rem; color: var(--text-dim); }
.info__board { font-family: var(--mono); font-size: 0.7rem; border: 2px solid; padding: 0 0.3rem; }
.info__line { min-width: 0; overflow-wrap: anywhere; }
.info__line em { color: var(--text-dim); font-style: normal; }
.info__line--dim { color: var(--text-dim); }

/* --- movement --------------------------------------------------------------------------------- */
.is-arriving { visibility: hidden; }
.walker, .paper { position: absolute; top: 0; left: 0; z-index: 4; pointer-events: none; }
/* Nothing in flight may widen the page on a phone. */
.building { overflow: clip; }
.paper { display: flex; align-items: center; gap: 0.3rem; opacity: 0; }
.paper__sheet { width: 12px; height: 15px; background: #f4f1ea; border: 2px solid var(--accent); box-shadow: 2px 2px 0 var(--office-wall); }
.paper__label {
  font-family: var(--mono);
  font-size: 0.68rem;
  background: var(--accent);
  color: var(--accent-text);
  padding: 0 0.3rem;
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (prefers-reduced-motion: no-preference) {
  .walker :deep(.person) { animation: walk 0.3s steps(2, jump-none) infinite alternate; }
}
@keyframes walk {
  from { transform: translateY(0); }
  to { transform: translateY(-2px); }
}
</style>
