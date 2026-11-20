<script setup>
// A panel that slides in from the right over the page — the office stays in view behind it. Used to
// read a duty and to file one without leaving.
//
// A native modal dialog: focus stays inside while it is open, Escape or a click outside closes it,
// and whatever opened it gets focus back.
import { onMounted, ref } from "vue";

const props = defineProps({
  label: { type: String, required: true },
});
const emit = defineEmits(["close"]);

const dialog = ref(null);
const opener = typeof document !== "undefined" ? document.activeElement : null;

onMounted(() => dialog.value.showModal());

function close() {
  emit("close");
  if (opener && typeof opener.focus === "function") opener.focus({ preventScroll: true });
}
function backdrop(event) {
  if (event.target === dialog.value) close();
}
/** Back to the top, for a panel whose content changed under it. */
const toTop = () => dialog.value && (dialog.value.scrollTop = 0);
defineExpose({ close, toTop });
</script>

<template>
  <dialog ref="dialog" class="side" :aria-label="label" @cancel.prevent="close" @click="backdrop">
    <div class="side__bar">
      <strong class="side__label">{{ label }}</strong>
      <span class="side__actions"><slot name="bar" /></span>
      <button type="button" class="side__close" aria-label="Close" @click="close">✕</button>
    </div>
    <div class="side__body"><slot /></div>
  </dialog>
</template>

<style scoped>
.side {
  margin: 0 0 0 auto;
  width: min(46rem, 100vw);
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text);
  box-shadow: var(--shadow);
  overflow-y: auto;
}
.side::backdrop { background: rgba(10, 14, 20, 0.28); }
@media (prefers-reduced-motion: no-preference) {
  .side[open] { animation: slide-in 0.18s ease-out; }
}
@keyframes slide-in {
  from { transform: translateX(2.5rem); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.side__bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.6rem var(--gutter);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.side__label { font-size: 0.9rem; }
.side__actions { margin-left: auto; font-size: 0.85rem; }
.side__close { padding: 0.3rem 0.6rem; line-height: 1; }
/* An icon in the bar's actions — "open as its own page" — sized and spaced like the close button. */
.side__actions :slotted(.side__icon) {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.35rem; border-radius: 6px; color: var(--text-dim);
}
.side__actions :slotted(.side__icon:hover), .side__actions :slotted(.side__icon:focus-visible) { color: var(--text); background: var(--surface-2); }
.side__body { padding: 1rem var(--gutter) 2rem; }
</style>
