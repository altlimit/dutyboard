<script setup>
// One member of the board's team, drawn as a small pixel character sitting at a desk.
//
// The drawing is a grid of letters, one per pixel, turned into SVG rects — so it scales cleanly to any
// size and takes its colours from the role it stands for. Two frames differ only in where the hands
// are; switching between them is the typing.
import { computed } from "vue";
import { characterLook } from "../lib/team.js";

const props = defineProps({
  seed: { type: String, default: "" }, // the role's id: the same role always looks the same
  working: { type: Boolean, default: false },
  size: { type: Number, default: 56 },
});

// H hair · S skin · E eye · M mouth · T shirt · . nothing
const BODY = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHSSSSHH..",
  "..HSESSESH..",
  "...SSSSSS...",
  "...SSMMSS...",
  "....SSSS....",
  "..TTTTTTTT..",
  ".TTTTTTTTTT.",
  ".TTTTTTTTTT.",
];
const HANDS = [".SSTTTTTTSS.", "..SSTTTTSS.."];

const look = computed(() => characterLook(props.seed));
const fill = (ch) => ({ H: look.value.hair, S: look.value.skin, T: look.value.shirt, E: "#1b1e24", M: "#9c5a4a" })[ch];

/** Runs of the same colour in a row become one rect: a third as many elements as one per pixel. */
function rects(rows, top = 0) {
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== ".") out.push({ x, y: y + top, w: end - x, fill: fill(ch) });
      x = end;
    }
  });
  return out;
}

const body = computed(() => rects(BODY));
const hands = computed(() => HANDS.map((row) => rects([row], BODY.length)));
</script>

<template>
  <svg class="person" :class="{ 'person--working': working }" :width="size" :height="size" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">
    <rect v-for="(r, i) in body" :key="`b${i}`" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
    <g class="person__hands person__hands--a">
      <rect v-for="(r, i) in hands[0]" :key="`a${i}`" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
    </g>
    <g class="person__hands person__hands--b">
      <rect v-for="(r, i) in hands[1]" :key="`c${i}`" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
    </g>
  </svg>
</template>

<style scoped>
.person { display: block; image-rendering: pixelated; opacity: 0.6; transition: opacity 0.3s; }
.person--working { opacity: 1; }
.person__hands--b { visibility: hidden; }
@media (prefers-reduced-motion: no-preference) {
  .person--working { animation: person-bob 0.9s steps(2, jump-none) infinite; }
  .person--working .person__hands--a { animation: person-hands 0.36s steps(1) infinite; }
  .person--working .person__hands--b { animation: person-hands 0.36s steps(1) infinite reverse; }
}
@keyframes person-bob {
  from { transform: translateY(0); }
  to { transform: translateY(1.5px); }
}
@keyframes person-hands {
  0%, 49% { visibility: visible; }
  50%, 100% { visibility: hidden; }
}
</style>
