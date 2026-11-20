<script setup>
// The office building: one room per board with a cubicle per role, and a breakroom every board
// shares. It is meant to be read at a glance, so every person at a desk says what they are on:
//
//   working   a speech bubble with the duty's title, the screen lit, typing;
//   asking    an amber "?" bubble with the duty waiting on a person — they stay at their desk;
//   just done a while at the desk — a different while for each, so they do not all get up at once —
//             after handing a duty on ("→ QA"), having it sent back ("↩ Engineer") or finishing it
//             ("✓"). One that handed a duty on then walks over to the desk it handed it to and
//             stands there talking for a while — helping — before going on a break;
//   on call   whoever picks up a board's next scheduled duty stays in their seat with a clock and
//             what is coming ("Weekly report · in 3h");
//   idle      in the breakroom — chatting, at the arcade, by the coffee, on the couch — their tray
//             at the desk stacked with whatever waits for them. The groups drift every few minutes. Every duty in it is a link to the duty; the same is said in words for a
// screen reader, and in the strip under the building on hover or focus.
import { computed, nextTick, onUnmounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { plainClick } from "../lib/clicks.js";
import PixelPerson from "./PixelPerson.vue";
import PixelSprite from "./PixelSprite.vue";
import { activityLine } from "../lib/runners.js";
import { until } from "../lib/duties.js";
import { SEATS, TRAY_SHOWN, WANDER_MS, atDesk, buildingFloor, floorMoves, hangoutGroups, levelLabel } from "../lib/team.js";

const props = defineProps({
  // `[{ project_id, name, roster }]`; `roster` is `{ intake, roles }`, or null for a board with no team.
  boards: { type: Array, required: true },
  // The unfinished duties of all of them.
  duties: { type: Array, required: true },
  // What machines say they are doing, by duty.
  activity: { type: Object, default: () => ({}) },
  // Duties finished lately, so one that leaves a desk can be shown as done rather than just gone.
  recent: { type: Array, default: () => [] },
  // Each board's next scheduled duty, `{ project_id → { at, title } }`.
  next: { type: Object, default: () => ({}) },
  // One board's own office: its name is the heading, not a link.
  single: { type: Boolean, default: false },
});
// A "?" in the building is a question waiting on you: selecting it asks the page to open the question
// where it can be answered, rather than leaving the office.
// "+ Duty" on a room's plate asks the page to open a new duty on that board.
// A cubicle's duty opens over the office ("open"), rather than taking you away from it.
const emit = defineEmits(["ask", "add", "open"]);
const router = useRouter();

/** People drawn in the breakroom before the rest are a number. */
const BREAK_SHOWN = 40;
/** How long a role stays at its desk after handing a duty on or finishing it, saying so: a different
 *  while for each, between these, so a team that finishes together does not stand up together. */
const LINGER_MIN_MS = 8_000;
const LINGER_MAX_MS = 40_000;

const floor = computed(() => buildingFloor({ boards: props.boards, duties: props.duties, activity: props.activity, next: props.next }));
/** The cubicle being pointed at or focused, whose details the strip under the building shows. */
const pointed = ref(null);
const pointedRoom = computed(() => pointed.value && floor.value.rooms.find((r) => r.desks.some((d) => d.key === pointed.value)));
const pointedDesk = computed(() => pointedRoom.value && pointedRoom.value.desks.find((d) => d.key === pointed.value));

/** Roles still at their desk a moment after their duty moved on: desk key → { kind, mark, title, duty }. */
const linger = reactive({});
/** Which few-minute stretch it is: who hangs out where in the breakroom is drawn per stretch. */
const stretch = ref(Math.floor(Date.now() / WANDER_MS));
/** The clock the "in 3h" on a desk that is on call reads from, moved on every half minute. */
const now = ref(Date.now());
const inBreak = computed(() => floor.value.breakroom.filter((p) => !linger[p.key] && !visit[p.key]));
/** The breakroom's people in little groups, by what each group is doing. */
const groups = computed(() => {
  const out = { chat: [], game: [], coffee: [], couch: [] };
  for (const g of hangoutGroups(loitering.value, stretch.value)) out[g.activity].push(g);
  return out;
});
const loitering = computed(() => inBreak.value.slice(0, BREAK_SHOWN));
const moreLoitering = computed(() => inBreak.value.length - loitering.value.length);
const deskName = (key) => {
  for (const r of floor.value.rooms) for (const d of r.desks) if (d.key === key) return d.role.name;
  return "";
};

const dutyLink = (d) => ({ name: "duty", params: { projectId: d.project_id, dutyId: d.key } });
/**
 * Where a cubicle takes you: the question waiting on you, else what it is working on, else what it
 * just passed on or finished, else the next thing in its tray, else the board.
 */
/** The address a cubicle's link carries, so it still opens in a new tab when asked to. */
const hrefOf = (to) => router.resolve(to).href;
/** A plain click on a cubicle with a duty opens it over the office; anything else is the browser's. */
function openDesk(event, link) {
  if (link.name !== "duty" || !plainClick(event)) return;
  event.preventDefault();
  emit("open", { projectId: link.params.projectId, dutyId: link.params.dutyId });
}

function deskLink(room, desk) {
  const d = desk.asking[0] || (desk.working[0] && desk.working[0].duty) || desk.tray[0];
  if (d) return dutyLink(d);
  if (linger[desk.key]) return { name: "duty", params: { projectId: room.board.project_id, dutyId: linger[desk.key].duty } };
  return props.single ? null : { name: "office", params: { projectId: room.board.project_id } };
}

/** How a person in the breakroom is named on hover. */
const whoIs = (p, doing) => `${p.role.name}${props.single ? "" : ` · ${p.board.name}`} — ${doing}${p.waiting ? ` (${p.waiting} waiting)` : ""}`;

/** A room's state in a few words, beside its name: how many are working, waiting, blocked. */
function roomSays(room) {
  const working = room.desks.reduce((n, d) => n + d.working.length, 0);
  const queued = room.desks.reduce((n, d) => n + d.tray.length, 0);
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (queued) parts.push(`${queued} queued`);
  if (room.blocked) parts.push(`${room.blocked} blocked`);
  if (!room.teamed) parts.push("no team");
  return parts.join(" · ");
}

/** What the speech bubble over a cubicle says, or null when it says nothing. */
function bubbleOf(desk) {
  // A bubble belongs to the person, not the desk: none while they are walking there, or away from it
  // helping someone else.
  if (arriving[desk.key] || !present(desk)) return null;
  if (desk.asking.length) return { kind: "ask", mark: "?", title: desk.asking[0].title, more: desk.asking.length - 1 };
  if (desk.working.length) return { kind: "work", mark: "", title: desk.working[0].duty.title, more: desk.working.length - 1 };
  const l = linger[desk.key];
  if (l) return { kind: l.kind, mark: l.mark, title: l.title, more: 0 };
  // The time first: on a narrow desk the title is what gets cut, and "in 3h" is the news.
  if (desk.onCall) return { kind: "clock", mark: until(desk.onCall.at, now.value).replace(/^in /, ""), title: desk.onCall.title, more: 0 };
  return null;
}

function deskSays(desk) {
  const parts = [desk.role.name];
  if (desk.asking.length) parts.push(`waiting on you about “${desk.asking[0].title}”`);
  if (desk.working.length) {
    const w = desk.working[0];
    parts.push(`working on “${w.duty.title}”${w.activity ? `, ${activityLine(w.activity)}` : ""}${desk.working.length > 1 ? `, and ${desk.working.length - 1} more` : ""}`);
  }
  if (!desk.asking.length && !desk.working.length) {
    const l = linger[desk.key];
    const helping = visit[desk.key] && placeOf(desk).startsWith("visit:");
    parts.push(l ? `${l.said} “${l.title}”` : helping ? `over at ${deskName(visit[desk.key].to)}'s desk, helping with “${visit[desk.key].title}”` : desk.onCall ? `on call for “${desk.onCall.title}”, ${until(desk.onCall.at, now.value)}` : "on a break");
  }
  for (const v of visitors.value[desk.key] || []) parts.push(`${v.name} is here helping`);
  if (desk.tray.length) parts.push(`${desk.tray.length} waiting in the tray`);
  // "Engineer: working on “Export”, QA is here helping, 2 waiting in the tray".
  return `${parts[0]}: ${parts.slice(1).join(", ")}`;
}

// --- movement ----------------------------------------------------------------------------------

const root = ref(null);
const walkers = ref([]); // [{ id, key, from: {x,y}, to: {x,y} }]
const papers = ref([]); // [{ id, title, from, to }]
const arriving = reactive({}); // person key → true while they walk there
/** At its desk and working — not just given the work while it is still walking over. */
const seated = (desk) => desk.working.length > 0 && !arriving[desk.key];
/** Roles over at another desk after handing it a duty: desk key → { to: desk key, title }. */
const visit = reactive({});
/**
 * Where a role is: "desk" — working, waiting on you, wrapping up, or on call; "visit:<desk>" — over at
 * the desk it just handed a duty to; or "break". Work in hand always wins: it is at its own desk.
 */
function placeOf(desk) {
  if (atDesk(desk) || linger[desk.key]) return "desk";
  // Only while the one being helped is still at their desk: nobody stands at an empty one, and when
  // they get up, so does whoever was helping.
  const target = visit[desk.key] && deskByKey.value.get(visit[desk.key].to);
  if (target && atOwnDesk(target)) return `visit:${target.key}`;
  return desk.onCall ? "desk" : "break";
}
/** At their own desk, not counting a visit of theirs — which is what a visit to them depends on. */
const atOwnDesk = (desk) => atDesk(desk) || !!linger[desk.key] || !!desk.onCall;
const present = (desk) => placeOf(desk) === "desk";
const deskByKey = computed(() => new Map(floor.value.rooms.flatMap((r) => r.desks.map((d) => [d.key, d]))));
/** Who is standing at each desk, visiting: desk key → [{ key, title }]. */
const visitors = computed(() => {
  const out = {};
  for (const d of deskByKey.value.values()) {
    const place = placeOf(d);
    if (place.startsWith("visit:")) (out[place.slice(6)] ||= []).push({ key: d.key, name: d.role.name, title: visit[d.key].title });
  }
  return out;
});
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
/** Where everyone is: desk key → place. Compared before and after anything changes, to walk the difference. */
const placesOf = (f) => new Map(f.rooms.flatMap((r) => r.desks.map((d) => [d.key, placeOf(d)])));
/** A random while, so people who started together do not move together. */
const awhile = () => LINGER_MIN_MS + Math.random() * (LINGER_MAX_MS - LINGER_MIN_MS);

/**
 * Walk everyone whose place changed between `before` and `after`, and fly each handed-on duty from
 * desk to desk. Measures where things are now, synchronously — before the page redraws — then after.
 */
async function travel(before, after, handoffs = []) {
  if (!root.value || (reducedMotion && reducedMotion.matches)) return;
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  if (!changed.length && !handoffs.length) return;
  const starts = new Map(changed.map((k) => [k, personAt(k)]));
  const deskStarts = new Map(handoffs.map((h) => [h.from, deskAt(h.from)]));
  for (const k of changed) if (starts.get(k)) arriving[k] = true;
  await nextTick();
  for (const k of changed) {
    const from = starts.get(k);
    const to = personAt(k);
    if (from && to) walkers.value.push({ id: ++nextId, key: k, from, to });
    else delete arriving[k];
  }
  for (const h of handoffs) {
    const from = deskStarts.get(h.from);
    const to = deskAt(h.to);
    if (from && to) papers.value.push({ id: ++nextId, title: h.title, from, to });
  }
}

const timers = new Map();
function later(key, fn) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => (timers.delete(key), fn()), awhile()));
}
/** Change where people are, and walk them there. */
function move(change) {
  const before = placesOf(floor.value);
  change();
  travel(before, placesOf(floor.value));
}
function stay(key, value) {
  delete visit[key];
  linger[key] = value;
  later(key, () => leave(key));
}
/**
 * The wrap-up is over. One that handed a duty on goes over to the desk it handed it to, to help for a
 * while; anyone else goes on a break — unless there is work at their own desk by now.
 */
function leave(key) {
  const { helps, title } = linger[key] || {};
  move(() => {
    delete linger[key];
    // Only if there is someone there to help: one who has already finished and gone is not visited.
    const target = helps && deskByKey.value.get(helps);
    if (target && atOwnDesk(target)) visit[key] = { to: helps, title };
  });
  if (visit[key]) later(key, () => move(() => delete visit[key]));
}
// The breakroom's groups drift every few minutes, and an "in 3h" stays true.
const wander = setInterval(() => {
  now.value = Date.now();
  stretch.value = Math.floor(now.value / WANDER_MS);
}, 30_000);
onUnmounted(() => {
  timers.forEach(clearTimeout);
  clearInterval(wander);
});

// Runs before the page redraws: what moved since the last reading becomes people staying a moment at
// their desks to say so, people walking, and duties crossing the room.
let lastFloor = null;
watch(
  floor,
  (now) => {
    const before = lastFloor;
    lastFloor = now;
    if (!before) return;
    const was = placesOf(before);
    const { handoffs, left } = floorMoves(before, now);
    for (const h of handoffs) {
      const to = deskName(h.to);
      stay(h.from, h.sent_back
        ? { kind: "back", mark: `↩ ${to}`, said: `sent back to ${to}:`, title: h.title, duty: h.duty, helps: h.to }
        : { kind: "pass", mark: `→ ${to}`, said: `handed to ${to}:`, title: h.title, duty: h.duty, helps: h.to });
    }
    // Work back at their own desk ends a visit at once.
    for (const r of now.rooms) for (const d of r.desks) if (visit[d.key] && atDesk(d)) delete visit[d.key];
    const done = new Set(props.recent.map((d) => d.key));
    for (const l of left) {
      if (done.has(l.duty)) stay(l.desk, { kind: "done", mark: "✓", said: "finished", title: l.title, duty: l.duty });
    }
    travel(was, placesOf(now), handoffs);
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
      <p v-if="!inBreak.length">Nobody is on a break.</p>
      <ul v-else>
        <li v-for="p in inBreak" :key="p.key">{{ p.role.name }}{{ single ? "" : ` of ${p.board.name}` }}, on a break{{ p.waiting ? `, ${p.waiting} waiting` : "" }}</li>
      </ul>
    </div>

    <section class="room room--break" aria-label="Breakroom">
      <header class="plate">
        <span class="plate__name">Breakroom</span>
        <span class="plate__note">{{ inBreak.length ? `${inBreak.length} on a break` : "empty — everyone is at their desk" }}</span>
      </header>
      <div class="break" aria-hidden="true">
        <div class="zone">
          <PixelSprite name="fridge" :scale="4" />
          <div class="break__counter">
            <PixelSprite class="break__coffee" name="coffee" :scale="3" />
            <PixelSprite name="counter" :scale="4" />
          </div>
          <ul v-for="g in groups.coffee" :key="g.key" class="hang" :style="{ marginBottom: `${g.lift}px` }">
            <li v-for="p in g.people" :key="p.key" class="loiter" :class="{ 'is-arriving': arriving[p.key] }" :data-person="p.key" :title="whoIs(p, 'getting a coffee')">
              <PixelPerson pose="stand" :seed="p.key" :size="26" />
              <span class="loiter__tag" :style="{ background: p.color }"></span>
            </li>
          </ul>
        </div>

        <div class="zone">
          <PixelSprite name="arcade" :scale="3" />
          <ul v-for="g in groups.game" :key="g.key" class="hang hang--game" :style="{ marginBottom: `${g.lift}px` }">
            <li v-for="p in g.people" :key="p.key" class="loiter" :class="{ 'is-arriving': arriving[p.key] }" :data-person="p.key" :title="whoIs(p, 'playing a game')">
              <PixelPerson pose="stand" :seed="p.key" :size="26" />
              <span class="loiter__tag" :style="{ background: p.color }"></span>
            </li>
          </ul>
          <PixelSprite name="pingpong" :scale="3" />
        </div>

        <div class="zone zone--open">
          <ul v-for="g in groups.chat" :key="g.key" class="hang hang--chat" :style="{ marginBottom: `${g.lift}px` }">
            <li class="hang__talk"><i></i><i></i><i></i></li>
            <li v-for="p in g.people" :key="p.key" class="loiter" :class="{ 'is-arriving': arriving[p.key] }" :data-person="p.key" :title="whoIs(p, 'chatting')">
              <PixelPerson pose="stand" :seed="p.key" :size="26" />
              <span class="loiter__tag" :style="{ background: p.color }"></span>
            </li>
          </ul>
          <span v-if="moreLoitering" class="loiter--more">+{{ moreLoitering }}</span>
        </div>

        <div class="zone">
          <div class="couch">
            <PixelSprite name="couch" :scale="4" />
            <ul v-for="g in groups.couch" :key="g.key" class="couch__sitters">
              <li v-for="p in g.people" :key="p.key" :class="{ 'is-arriving': arriving[p.key] }" :data-person="p.key" :title="whoIs(p, 'on the couch')">
                <PixelPerson pose="desk" :seed="p.key" :size="24" />
              </li>
            </ul>
          </div>
          <PixelSprite name="beanbag" :scale="3" />
          <PixelSprite name="plant" :scale="3" />
        </div>
      </div>
    </section>

    <div class="rooms">
    <section v-for="room in floor.rooms" :key="room.board.project_id" class="room" :style="{ '--room': room.color }" :aria-label="`${room.board.name}'s office`">
      <header class="plate">
        <span v-if="single" class="plate__name">{{ room.board.name }}</span>
        <router-link v-else class="plate__name" :to="{ name: 'office', params: { projectId: room.board.project_id } }">{{ room.board.name }}</router-link>
        <button
          v-if="room.needsYou.length"
          type="button"
          class="plate__ask"
          :title="room.needsYou.map((d) => d.title).join('\n')"
          @click="emit('ask', room.needsYou[0].key)"
        >
          <span aria-hidden="true">?</span> {{ room.needsYou.length }} {{ room.needsYou.length === 1 ? "needs" : "need" }} you
        </button>
        <span v-if="roomSays(room)" class="plate__note">{{ roomSays(room) }}</span>
        <button type="button" class="plate__add" :aria-label="`Add a duty to ${room.board.name}`" @click="emit('add', room.board.project_id)">+ Duty</button>
      </header>

      <ul class="cubes">
        <li v-for="desk in room.desks" :key="desk.key">
          <component
            :is="desk.asking.length ? 'button' : deskLink(room, desk) ? 'a' : 'div'"
            :href="desk.asking.length || !deskLink(room, desk) ? undefined : hrefOf(deskLink(room, desk))"
            :type="desk.asking.length ? 'button' : undefined"
            @click="desk.asking.length ? emit('ask', desk.asking[0].key) : deskLink(room, desk) && openDesk($event, deskLink(room, desk))"
            class="cube"
            :class="[{ 'cube--working': seated(desk) }, bubbleOf(desk) ? `cube--${bubbleOf(desk).kind}` : '']"
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
              <!-- At the desk without typing: waiting on you, or wrapping up what just moved on. -->
              <span v-if="!desk.working.length && present(desk)" :data-person="desk.key" :class="{ 'is-arriving': arriving[desk.key] }">
                <PixelPerson pose="desk" :seed="desk.key" :working="false" :size="34" />
              </span>
              <span v-if="!present(desk)" class="cube__chair" aria-hidden="true"></span>
              <span v-if="desk.working.length > SEATS" class="cube__more" aria-hidden="true">+{{ desk.working.length - SEATS }}</span>
            </span>
            <!-- Whoever came over after handing this desk a duty, standing beside it talking. -->
            <span v-if="visitors[desk.key]" class="cube__visitors" aria-hidden="true">
              <span
                v-for="v in visitors[desk.key]"
                :key="v.key"
                class="cube__visitor"
                :class="{ 'is-arriving': arriving[v.key] }"
                :data-person="v.key"
                :title="`${v.name} came over to help with “${v.title}”`"
              >
                <span v-if="!arriving[v.key]" class="hang__talk"><i></i><i></i><i></i></span>
                <PixelPerson pose="stand" :seed="v.key" :size="24" />
              </span>
            </span>
            <span class="cube__desk" aria-hidden="true">
              <span class="cube__screen"></span>
              <span v-if="desk.tray.length" class="cube__tray">
                <span v-for="n in Math.min(desk.tray.length, 4)" :key="n" class="cube__paper"></span>
                <span class="cube__count">{{ desk.tray.length }}</span>
              </span>
            </span>
            <span class="cube__label" aria-hidden="true">{{ desk.role.name }}</span>
            <span v-if="bubbleOf(desk)" class="cube__bubble" aria-hidden="true">
              <PixelSprite v-if="bubbleOf(desk).kind === 'clock'" class="cube__clock" name="clock" :scale="1.25" />
              <b v-if="bubbleOf(desk).mark" class="cube__mark">{{ bubbleOf(desk).mark }}</b>
              <span class="cube__title">{{ bubbleOf(desk).title }}</span>
              <span v-if="bubbleOf(desk).more" class="cube__also">+{{ bubbleOf(desk).more }}</span>
            </span>
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
        <span v-if="pointedDesk.asking.length" class="info__line info__line--ask">
          Waiting on you: {{ pointedDesk.asking.map((d) => d.title).join(" · ") }}
        </span>
        <span v-if="pointedDesk.working.length" class="info__line">
          <template v-for="(w, i) in pointedDesk.working" :key="w.duty.key">{{ i ? " · " : "" }}{{ w.duty.title }}<em v-if="w.activity"> — {{ activityLine(w.activity) }}</em></template>
        </span>
        <span v-if="visitors[pointedDesk.key]" class="info__line info__line--dim">
          {{ visitors[pointedDesk.key].map((v) => v.name).join(" and ") }} came over to help
        </span>
        <span v-else-if="!pointedDesk.asking.length" class="info__line">
          {{
            linger[pointedDesk.key]
              ? `Just ${linger[pointedDesk.key].said} ${linger[pointedDesk.key].title}`
              : placeOf(pointedDesk).startsWith("visit:")
                ? `Over at ${deskName(visit[pointedDesk.key].to)}'s desk, helping with ${visit[pointedDesk.key].title}`
                : pointedDesk.onCall
                ? `On call: “${pointedDesk.onCall.title}” is due ${until(pointedDesk.onCall.at, now)}`
                : `On a break${pointedDesk.tray.length ? "" : ", nothing waiting"}`
          }}
        </span>
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
.plate__add {
  margin-left: auto;
  min-height: 0;
  padding: 0 0.45rem;
  font-family: var(--mono);
  font-size: 0.7rem;
  border-radius: 3px;
  border: 2px solid var(--room, var(--office-wall));
  background: var(--surface);
}
.plate__ask {
  min-height: 0;
  cursor: pointer;
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
.break { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 0.6rem 1.4rem; min-height: 74px; }
.zone { display: flex; align-items: flex-end; gap: 6px; flex-wrap: wrap; }
.zone--open { flex: 1 1 8rem; justify-content: space-around; min-width: 0; }
.break__counter { display: flex; flex-direction: column; align-items: flex-start; }
.break__coffee { margin-left: 8px; }

/* A little group, standing close: a person's tag under their feet says which board they are from. */
.hang { position: relative; list-style: none; margin: 0; padding: 0; display: flex; align-items: flex-end; gap: 1px; }
.loiter { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.loiter__tag { width: 10px; height: 3px; border-radius: 1px; }
.loiter--more { font-family: var(--mono); font-size: 0.78rem; color: var(--text-dim); align-self: center; }
.hang__talk {
  position: absolute;
  top: -12px;
  left: 50%;
  margin-left: -11px;
  display: flex;
  gap: 2px;
  padding: 2px 3px;
  background: var(--surface);
  border: 2px solid var(--text-dim);
  border-radius: 3px;
}
.hang__talk i { width: 3px; height: 3px; background: var(--text-dim); }
/* On the couch: sitting in front of the backrest. */
.couch { position: relative; }
.couch__sitters { position: absolute; left: 8px; bottom: 8px; list-style: none; margin: 0; padding: 0; display: flex; gap: 2px; }
@media (prefers-reduced-motion: no-preference) {
  .hang__talk i { animation: typing 1.4s steps(1) infinite; }
  .hang__talk i:nth-child(2) { animation-delay: 0.25s; }
  .hang__talk i:nth-child(3) { animation-delay: 0.5s; }
  .hang--game :deep(.person) { animation: play 0.5s steps(2, jump-none) infinite alternate; }
  .hang:nth-of-type(2n) .loiter:first-of-type :deep(.person) { animation: sip 3.2s steps(1) infinite; }
}
@keyframes typing {
  0%, 60% { opacity: 1; }
  61%, 100% { opacity: 0.2; }
}
@keyframes play {
  from { transform: translateY(0); }
  to { transform: translateY(-1px); }
}
@keyframes sip {
  0%, 85% { transform: translateY(0); }
  86%, 100% { transform: translateY(-1px); }
}

/* --- cubicles --------------------------------------------------------------------------------- */
.cubes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px 6px; }
.cube {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 116px;
  padding-top: 25px;
  border: 3px solid var(--office-partition);
  border-bottom: 0;
  border-radius: 2px 2px 0 0;
  background: color-mix(in srgb, var(--room) 16%, var(--office-floor));
  color: var(--text);
  text-decoration: none;
}
a.cube:focus-visible, button.cube:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
/* A cubicle waiting on you is a button: it opens the question below rather than leaving. */
button.cube { width: 100%; margin: 0; padding: 25px 0 0; font: inherit; cursor: pointer; justify-content: flex-start; }
button.cube:hover:not(:disabled) { background: color-mix(in srgb, var(--room) 16%, var(--office-floor)); }
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
/* What the person at the desk is on, in a speech bubble whose tail points down at them. */
.cube__bubble {
  position: absolute;
  top: 3px;
  left: 4px;
  right: 4px;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 3px;
  padding: 1px 4px;
  font-size: 0.66rem;
  line-height: 1.35;
  background: var(--surface);
  color: var(--text);
  border: 2px solid var(--text-dim);
  border-radius: 3px;
}
.cube__bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -6px;
  margin-left: -4px;
  border: 4px solid transparent;
  border-top-color: var(--text-dim);
  border-bottom: 0;
}
.cube__title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cube__mark { flex: none; font-weight: 700; white-space: nowrap; }
.cube__also { flex: none; color: var(--text-dim); font-family: var(--mono); }
.cube--ask .cube__bubble { background: var(--warn-soft); border-color: var(--warn); }
.cube--ask .cube__bubble::after { border-top-color: var(--warn); }
.cube--ask .cube__mark, .cube--back .cube__mark { color: var(--warn); }
.cube--back .cube__bubble { border-color: var(--warn); }
.cube--back .cube__bubble::after { border-top-color: var(--warn); }
.cube--pass .cube__bubble { border-color: var(--accent); }
.cube--pass .cube__bubble::after { border-top-color: var(--accent); }
.cube--pass .cube__mark { color: var(--accent); }
.cube--done .cube__bubble { background: var(--ok-soft); border-color: var(--ok); }
.cube--done .cube__bubble::after { border-top-color: var(--ok); }
.cube--done .cube__mark { color: var(--ok); }
/* A visitor stands beside the desk, at the side away from the screen. */
/* In front of the desk, so the desk never hides their face; their talk bubble sits clear of their head. */
.cube__visitors { position: absolute; right: 3px; bottom: 16px; z-index: 3; display: flex; gap: 1px; }
.cube__visitor { position: relative; display: block; }
.cube__visitor .hang__talk { top: -13px; left: 50%; margin-left: -10px; padding: 1px 2px; }

/* On call for the board's next scheduled duty. */
.cube--clock .cube__bubble { border-color: var(--accent); border-style: dashed; color: var(--text-dim); }
.cube--clock .cube__bubble::after { border-top-color: var(--accent); }
.cube__clock { align-self: center; }
.cube--clock .cube__mark { color: var(--accent); }
/* Waiting on you is the one thing on the floor that is waiting for whoever is looking. */
.cube--ask { border-color: var(--warn); }
@media (prefers-reduced-motion: no-preference) {
  .cube--ask .cube__bubble { animation: nudge 2.4s ease-in-out infinite; }
}
@keyframes nudge {
  0%, 80%, 100% { transform: translateY(0); }
  88% { transform: translateY(-2px); }
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
.info__line--ask { color: var(--warn); font-weight: 600; }

/* --- movement --------------------------------------------------------------------------------- */
/* Not visibility: the typing animation sets that on the arms, which would show through. */
.is-arriving { opacity: 0; }
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
