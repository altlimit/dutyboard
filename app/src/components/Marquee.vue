<script setup>
// One line of text in a narrow space. When it fits, it just sits there; when it does not, it scrolls
// slowly to its end and back, pausing at each, so the whole of it can be read without pointing at it.
// With `still`, or for anyone who asks for reduced motion, it does not move and is cut with an ellipsis.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  text: { type: String, default: "" },
  // Cut with an ellipsis rather than scrolled: for text that is not worth watching move.
  still: { type: Boolean, default: false },
});

const box = ref(null);
/** How far the line overflows its box, in pixels; 0 when it fits. */
const overflow = ref(0);
let resize = null;

function measure() {
  if (!box.value) return;
  // The box clips the line, so its scroll width is the line's whole width (an inline line has none of
  // its own to read).
  const over = box.value.scrollWidth - box.value.clientWidth;
  overflow.value = over > 2 ? over : 0;
}
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined") {
    resize = new ResizeObserver(measure);
    resize.observe(box.value);
  }
});
onBeforeUnmount(() => resize && resize.disconnect());
watch(() => props.text, () => nextTick(measure));
</script>

<template>
  <span
    ref="box"
    class="marquee"
    :class="{ 'marquee--long': overflow && !still }"
    :style="overflow && !still ? { '--marquee-shift': `-${overflow}px`, '--marquee-time': `${Math.max(3, overflow / 45 + 2.5).toFixed(1)}s` } : null"
  >
    <span class="marquee__line">{{ text }}</span>
  </span>
</template>

<style scoped>
.marquee { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.marquee__line { white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  .marquee--long { text-overflow: clip; }
  .marquee--long .marquee__line {
    display: inline-block;
    animation: marquee var(--marquee-time) ease-in-out infinite alternate;
  }
}
/* A pause at the start and at the end, so each is readable before it moves on. */
@keyframes marquee {
  0%, 18% { transform: none; }
  82%, 100% { transform: translateX(var(--marquee-shift)); }
}
</style>
