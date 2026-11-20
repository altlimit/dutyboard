<script setup>
import { computed, inject } from "vue";
import QuotaRetry from "./QuotaRetry.vue";
import { dutyRoleId, roleNameFromId } from "../lib/team.js";
import { ago, originLabel, priorityLabel } from "../lib/duties.js";
import { activityLine } from "../lib/runners.js";
import { plain } from "../lib/markdown.js";
import { user } from "../lib/session.js";
import { useOpenDuty } from "../lib/useDutyPanel.js";

defineEmits(["changed"]);
const props = defineProps({
  duty: { type: Object, required: true },
  projectId: { type: String, required: true },
  activity: { type: Object, default: null }, // { machine, state, detail } while a machine works it
});
const now = computed(() => (props.duty.status === "active" && props.activity ? activityLine(props.activity) : ""));

const d = computed(() => props.duty);
// A blocker is the only priority worth calling out on a card; the other two are the
// normal case and would be noise on every card on the board.
const showPriority = computed(() => d.value.priority === "immediate_blocker");

// On a board with a team: which role has this duty. The board page provides the team; a card shown
// anywhere else simply has no role to name.
const team = inject("team", null);
// On a page that reads duties in a panel, a plain click opens it there.
const openDuty = useOpenDuty();
const role = computed(() => {
  if (!team || d.value.status === "done" || d.value.status === "failed") return "";
  const id = dutyRoleId(d.value, team.pointer.value);
  return id ? team.names.value[id] || roleNameFromId(id) : "";
});
</script>

<template>
  <article class="duty">
    <router-link v-slot="{ href, navigate }" custom :to="{ name: 'duty', params: { projectId, dutyId: d.key } }">
    <a :href="href" style="display: block; color: inherit; text-decoration: none" @click="openDuty($event, projectId, d.key, navigate)">
      <span class="duty__title">{{ d.title }}</span>

      <span class="duty__meta">
        <span v-if="showPriority" class="badge badge--immediate_blocker">{{ priorityLabel(d.priority) }}</span>
        <span v-if="d.kind === 'setup' || d.kind === 'rules'" class="badge badge--active">{{ d.kind }}</span>
        <span v-if="d.kind === 'roster'" class="badge badge--active" title="Drafts the board's team for its owner to accept">team</span>
        <span v-if="role" class="badge badge--role" :title="d.status === 'active' ? `${role} is working it` : `With ${role}`">{{ role }}</span>
        <span v-if="d.bounces && d.status !== 'done'" class="badge" :title="`A reviewer has sent this back ${d.bounces} time${d.bounces === 1 ? '' : 's'}`">sent back ×{{ d.bounces }}</span>
        <span class="badge">{{ originLabel(d, user) }}</span>
        <span v-if="d.source_note_ids?.length || d.source_note_id" class="badge">Created from {{ d.source_note_ids?.length || 1 }} {{ (d.source_note_ids?.length || 1) === 1 ? 'note' : 'notes' }}</span>
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

      <span v-if="now" class="duty__now" :title="`On ${activity.machine}`">{{ now }}</span>

      <span v-if="d.status === 'needs_decision' && d.last_question" class="duty__ask">{{ plain(d.last_question) }}</span>
      <!-- Work that was delivered and came back. Worth seeing from the board: a queued card
           that looks new is a different thing from one somebody has already had to reject. -->
      <span v-else-if="d.reopen_note && d.status === 'queued'" class="duty__ask" style="border-left-color: var(--danger)">
        {{ plain(d.reopen_note) }}
      </span>
      <span v-else-if="d.status === 'done' && d.outcome_summary" class="duty__ask" style="border-left-color: var(--ok)">
        {{ plain(d.outcome_summary) }}
      </span>
    </a>
    </router-link>
    <QuotaRetry v-if="d.status === 'active'" :activity="activity" :project-id="projectId" :owner-uid="d.owner_uid" />
  </article>
</template>
