<script setup>
import DutyLink from "./DutyLink.vue";
// Filing a duty from the office, with everything the Duties page's form has — models, priority,
// files and all — in a panel that slides in over the office, and a choice of board when the office
// shows several. "+ Duty" on a room opens it on that room's board. The duty lands in that board's
// tray like any other, in view behind the panel as it closes.
import { nextTick, ref } from "vue";
import DutyForm from "./DutyForm.vue";
import SidePanel from "./SidePanel.vue";

const props = defineProps({
  // `[{ project_id, name }]`: the boards it can be filed on. One means no choice is offered.
  boards: { type: Array, required: true },
});
const emit = defineEmits(["added"]);

const isOpen = ref(false);
const chosen = ref("");
const notice = ref("");
const failed = ref(null); // { dutyId, projectId, title, lines }
const form = ref(null);

/** Open the panel, on a board if one is named, ready to type the title. */
async function open(projectId) {
  chosen.value = projectId || chosen.value || (props.boards[0] && props.boards[0].project_id) || "";
  notice.value = "";
  isOpen.value = true;
  await nextTick();
  form.value?.focus(chosen.value);
}
defineExpose({ open });

function added(e) {
  notice.value = `Added “${e.title}”${props.boards.length > 1 && e.board ? ` to ${e.board}` : ""}.`;
  failed.value = e.failed.length ? { dutyId: e.duty_id, projectId: e.project_id, title: e.title, lines: e.failed } : null;
  isOpen.value = false;
  emit("added", e);
}
</script>

<template>
  <span class="quick">
    <button class="primary" type="button" :disabled="!boards.length" @click="open()">Add a duty</button>
    <span v-if="notice" class="small muted" role="status">{{ notice }}</span>
  </span>
  <div v-if="failed" class="notice notice--error" role="alert">
    <strong>“{{ failed.title }}” was added, but not every file made it.</strong>
    <ul style="margin: 0.3rem 0">
      <li v-for="line in failed.lines" :key="line">{{ line }}</li>
    </ul>
    Add them from
    <DutyLink :project-id="failed.projectId" :duty-id="failed.dutyId">the duty's page</DutyLink>.
  </div>
  <SidePanel v-if="isOpen" label="New duty" @close="isOpen = false">
    <DutyForm
      ref="form"
      :project-id="chosen"
      :boards="boards.length > 1 ? boards : []"
      id-prefix="office-duty"
      heading="Add a duty"
      @added="added"
      @cancel="isOpen = false"
    />
  </SidePanel>
</template>

<style scoped>
.quick { display: inline-flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
</style>
