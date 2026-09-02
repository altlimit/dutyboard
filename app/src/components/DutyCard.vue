<script setup>
import { computed } from "vue";
import { ago, priorityLabel } from "../lib/duties.js";

const props = defineProps({ duty: { type: Object, required: true }, projectId: { type: String, required: true } });

const d = computed(() => props.duty);
// A blocker is the only priority worth calling out on a card; the other two are the
// normal case and would be noise on every card on the board.
const showPriority = computed(() => d.value.priority === "immediate_blocker");
</script>

<template>
  <router-link class="duty" :to="{ name: 'duty', params: { projectId, dutyId: d.key } }">
    <span class="duty__title">{{ d.title }}</span>

    <span class="duty__meta">
      <span v-if="showPriority" class="badge badge--immediate_blocker">{{ priorityLabel(d.priority) }}</span>
      <span class="badge">{{ d.origin === "agent" ? "from an agent" : "from you" }}</span>
      <span v-if="d.assigned_agent_id" class="nowrap">
        <span class="sr-only">{{ d.status === "active" ? "held by " : "last worked by " }}</span>{{ d.assigned_agent_id }}
      </span>
      <span v-if="d.attachment_count" class="nowrap" :title="`${d.attachment_count} file${d.attachment_count === 1 ? '' : 's'}`">
        <span aria-hidden="true">📎</span>
        <span class="sr-only">{{ d.attachment_count }} file{{ d.attachment_count === 1 ? "" : "s" }}</span>
        {{ d.attachment_count }}
      </span>
      <span class="nowrap">{{ ago(d.updated_at) }}</span>
    </span>

    <span v-if="d.status === 'needs_decision' && d.last_question" class="duty__ask">{{ d.last_question }}</span>
    <span v-else-if="d.status === 'done' && d.outcome_summary" class="duty__ask" style="border-left-color: var(--ok)">
      {{ d.outcome_summary }}
    </span>
  </router-link>
</template>
