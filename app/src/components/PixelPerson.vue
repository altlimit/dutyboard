<script setup>
// One member of a board's team, as a small pixel character: sitting at a desk typing, or standing
// in the breakroom with a mug. Drawn from grids in lib/pixels.js, coloured by the role it stands for,
// so the same role looks the same at its desk and on its break.
import { computed } from "vue";
import { PERSON, pixelRects } from "../lib/pixels.js";
import { characterLook } from "../lib/team.js";

const props = defineProps({
  seed: { type: String, default: "" }, // the role's key: the same role always looks the same
  pose: { type: String, default: "desk" }, // "desk" or "stand"
  working: { type: Boolean, default: false },
  size: { type: Number, default: 48 }, // the drawing's width; its height follows the pose
});

const shape = computed(() => PERSON[props.pose] || PERSON.desk);
const palette = computed(() => {
  const look = characterLook(props.seed);
  return { H: look.hair, S: look.skin, T: look.shirt, E: "#1b1e24", M: "#9c5a4a", P: "#3b4252", K: "#1f2329", C: "#f2efe8" };
});
const body = computed(() => pixelRects(shape.value.body, palette.value));
const frames = computed(() => shape.value.frames.map((rows) => pixelRects(rows, palette.value, shape.value.body.length)));
const height = computed(() => Math.round((props.size * shape.value.height) / shape.value.width));
</script>

<template>
  <svg
    class="person"
    :class="{ 'person--working': working }"
    :width="size"
    :height="height"
    :viewBox="`0 0 ${shape.width} ${shape.height}`"
    shape-rendering="crispEdges"
    aria-hidden="true"
  >
    <rect v-for="(r, i) in body" :key="`b${i}`" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
    <g v-for="(frame, f) in frames" :key="`f${f}`" class="person__frame" :class="`person__frame--${f}`">
      <rect v-for="(r, i) in frame" :key="i" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
    </g>
  </svg>
</template>

<style scoped>
.person { display: block; image-rendering: pixelated; }
.person__frame--1 { visibility: hidden; }
@media (prefers-reduced-motion: no-preference) {
  .person--working { animation: person-bob 0.9s steps(2, jump-none) infinite; }
  .person--working .person__frame--0 { animation: person-frame 0.36s steps(1) infinite; }
  .person--working .person__frame--1 { animation: person-frame 0.36s steps(1) infinite reverse; }
}
@keyframes person-bob {
  from { transform: translateY(0); }
  to { transform: translateY(1px); }
}
@keyframes person-frame {
  0%, 49% { visibility: visible; }
  50%, 100% { visibility: hidden; }
}
</style>
