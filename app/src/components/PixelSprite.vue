<script setup>
// A piece of office furniture from lib/pixels.js, drawn at `scale` screen pixels per art pixel.
import { computed } from "vue";
import { SPRITES, pixelRects } from "../lib/pixels.js";

const props = defineProps({
  name: { type: String, required: true },
  scale: { type: Number, default: 3 },
});
const sprite = computed(() => SPRITES[props.name]);
const width = computed(() => sprite.value.rows[0].length);
const height = computed(() => sprite.value.rows.length);
const rects = computed(() => pixelRects(sprite.value.rows, sprite.value.palette));
</script>

<template>
  <svg
    class="sprite"
    :width="width * scale"
    :height="height * scale"
    :viewBox="`0 0 ${width} ${height}`"
    shape-rendering="crispEdges"
    aria-hidden="true"
  >
    <rect v-for="(r, i) in rects" :key="i" :x="r.x" :y="r.y" :width="r.w" height="1" :fill="r.fill" />
  </svg>
</template>

<style scoped>
.sprite { display: block; image-rendering: pixelated; flex: none; }
</style>
