<script setup>
// A duty read in full without leaving the office: its whole page — brief, thread, files, answering,
// sending back, editing — in a panel that slides in over the office.
import { ref, watch } from "vue";
import SidePanel from "./SidePanel.vue";
import Duty from "../views/Duty.vue";

const props = defineProps({
  projectId: { type: String, required: true },
  dutyId: { type: String, required: true },
});
const emit = defineEmits(["close"]);
const panel = ref(null);
watch(() => props.dutyId, () => panel.value && panel.value.toTop());
</script>

<template>
  <SidePanel ref="panel" label="Duty" @close="emit('close')">
    <template #bar>
      <router-link :to="{ name: 'duty', params: { projectId, dutyId } }">Open as its own page</router-link>
    </template>
    <Duty :project-id="projectId" :duty-id="dutyId" embedded @close="panel && panel.close()" />
  </SidePanel>
</template>
