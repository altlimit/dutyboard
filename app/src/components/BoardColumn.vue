<script setup>
// One column of the board — the same component whether it is one of six side by side on a
// desktop or the only one on a phone. Two layouts rendering the same list from two copies
// of the markup is how they drift.
import { computed } from "vue";
import DutyCard from "./DutyCard.vue";

const props = defineProps({
  col: { type: Object, required: true },
  state: { type: Object, required: true }, // { rows, cursor, loading }
  shown: { type: Number, required: true },
  projectId: { type: String, required: true },
  // Standalone: the phone layout, where the chips are the heading and the hint is worth
  // showing rather than hiding from everyone but a screen reader.
  standalone: { type: Boolean, default: false },
});

defineEmits(["more"]);

const visible = computed(() => props.state.rows.slice(0, props.shown));
/** More to show: either already loaded and clipped, or one page further back. */
const more = computed(() => props.state.rows.length > props.shown || !!props.state.cursor);
const hidden = computed(() => Math.max(0, props.state.rows.length - props.shown));
</script>

<template>
  <section class="column" :aria-labelledby="`col-${col.key}`">
    <div v-if="!standalone" class="column__head">
      <h2 :id="`col-${col.key}`" class="column__title">{{ col.label }}</h2>
      <span class="column__count">{{ state.rows.length }}{{ state.cursor ? "+" : "" }}</span>
    </div>
    <h2 v-else :id="`col-${col.key}`" class="sr-only">{{ col.label }}</h2>

    <p :class="standalone ? 'muted small column__note' : 'sr-only'">{{ col.hint }}</p>

    <ul class="column__list">
      <li v-for="duty in visible" :key="duty.key">
        <DutyCard :duty="duty" :project-id="projectId" />
      </li>
    </ul>

    <p v-if="state.loading && !state.rows.length" class="muted small column__note" role="status">Loading…</p>
    <p v-else-if="!state.rows.length" class="muted small column__note">Nothing here.</p>

    <button v-if="more" type="button" class="column__more" @click="$emit('more', col.key)">
      Show more<span v-if="hidden"> ({{ hidden }}{{ state.cursor ? "+" : "" }})</span>
    </button>
  </section>
</template>
