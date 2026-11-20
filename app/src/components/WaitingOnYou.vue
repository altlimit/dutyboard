<script setup>
// Everything an agent is waiting on you for, answerable without leaving the office. Selecting a "?"
// in the building brings that question here, ready to answer.
import { computed, nextTick, ref } from "vue";
import AnswerCard from "./AnswerCard.vue";
import { dutyRoleId, roleNameFromId } from "../lib/team.js";

const props = defineProps({
  // Duties in needs_decision, longest waiting first.
  duties: { type: Array, required: true },
  // `{ project_id → { name, roster } }`, for naming the board and the role on each card.
  boards: { type: Object, default: () => ({}) },
  // One board's own office: no board name on each card.
  single: { type: Boolean, default: false },
});

// After an answer is sent, so the page can read the floor again without waiting for the live event.
const emit = defineEmits(["answered"]);

const SHOWN = 8;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? props.duties : props.duties.slice(0, SHOWN)));
const notice = ref("");
const cards = ref({});

function roleOf(duty) {
  const b = props.boards[duty.project_id];
  const id = dutyRoleId(duty, b && b.roster);
  if (!id) return "";
  const role = b.roster.roles && b.roster.roles.find((r) => r.id === id);
  return role ? role.name : roleNameFromId(id);
}

function answered({ duty, rejected }) {
  notice.value = rejected ? `Rejected “${duty.title}”. It will not be worked.` : `Answered “${duty.title}” — it goes back to work now.`;
  emit("answered", duty);
}

/** Bring one question to the front and into view, from the building. */
async function open(dutyKey) {
  if (!props.duties.slice(0, SHOWN).some((d) => d.key === dutyKey)) showAll.value = true;
  await nextTick();
  cards.value[dutyKey]?.focus();
}
defineExpose({ open });
</script>

<template>
  <section class="waiting stack" aria-labelledby="waiting-h">
    <div class="row row--between">
      <h2 id="waiting-h" class="waiting__h">
        Waiting on you <span v-if="duties.length" class="badge badge--needs_decision">{{ duties.length }}</span>
      </h2>
      <p v-if="notice" class="small muted" role="status" style="margin: 0">{{ notice }}</p>
    </div>
    <p v-if="!duties.length" class="muted small" style="margin: 0">Nobody is waiting on you. A question an agent asks shows up here, to answer without leaving the office.</p>
    <div v-else class="waiting__grid" :class="{ 'waiting__grid--single': single }">
      <AnswerCard
        v-for="d in shown"
        :key="d.key"
        :ref="(c) => (c ? (cards[d.key] = c) : delete cards[d.key])"
        :duty="d"
        :board="single ? '' : (boards[d.project_id] && boards[d.project_id].name) || d.project_id"
        :role="roleOf(d)"
        @answered="answered"
      />
    </div>
    <button v-if="duties.length > SHOWN && !showAll" type="button" class="link small" @click="showAll = true">Show all {{ duties.length }}</button>
  </section>
</template>

<style scoped>
.waiting__h { margin: 0; font-size: 1.05rem; }
.waiting__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); gap: 0.7rem; }
.waiting__grid--single { grid-template-columns: minmax(0, 1fr); }
</style>
