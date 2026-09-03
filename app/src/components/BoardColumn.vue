<script setup>
// One column of the board — the same component whether it is one of six side by side on a
// desktop or the only one on a phone. Two layouts rendering the same list from two copies
// of the markup is how they drift.
import { computed } from "vue";
import DutyCard from "./DutyCard.vue";

const props = defineProps({
  col: { type: Object, required: true },
  state: { type: Object, required: true }, // { rows, cursor, loading, total }
  projectId: { type: String, required: true },
  // Standalone: the phone layout, where the chips are the heading and the hint is worth
  // showing rather than hiding from everyone but a screen reader.
  standalone: { type: Boolean, default: false },
});

defineEmits(["more"]);

/** A cursor is the only thing that means "there is more". Every row fetched is on screen,
 *  so this button always costs a request and always brings something back. */
const more = computed(() => !!props.state.cursor);
</script>

<template>
  <section class="column" :aria-labelledby="`col-${col.key}`">
    <div v-if="!standalone" class="column__head">
      <h2 :id="`col-${col.key}`" class="column__title">{{ col.label }}</h2>
      <span class="column__count">{{ state.total ?? state.rows.length }}{{ state.total == null && state.cursor ? "+" : "" }}</span>
    </div>
    <h2 v-else :id="`col-${col.key}`" class="sr-only">{{ col.label }}</h2>

    <p :class="standalone ? 'muted small column__note' : 'sr-only'">{{ col.hint }}</p>

    <ul class="column__list">
      <li v-for="duty in state.rows" :key="duty.key">
        <DutyCard :duty="duty" :project-id="projectId" />
      </li>
    </ul>

    <p v-if="state.loading && !state.rows.length" class="muted small column__note" role="status">Loading…</p>
    <p v-else-if="!state.rows.length" class="muted small column__note">Nothing here.</p>

    <button v-if="more" type="button" class="column__more" :disabled="state.loading" @click="$emit('more', col.key)">
      {{ state.loading ? "Loading…" : "Show more" }}
    </button>
  </section>
</template>
