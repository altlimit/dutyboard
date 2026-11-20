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
      <router-link
        class="side__icon"
        :to="{ name: 'duty', params: { projectId, dutyId } }"
        title="Open as its own page"
        aria-label="Open as its own page"
      >
        <!-- An arrow out of a box: open this somewhere bigger. -->
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 2.5h4.5V7" />
          <path d="M13.5 2.5 7.5 8.5" />
          <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
        </svg>
      </router-link>
    </template>
    <Duty :project-id="projectId" :duty-id="dutyId" embedded @close="panel && panel.close()" />
  </SidePanel>
</template>
