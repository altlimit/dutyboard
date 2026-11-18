<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { Events } from "@wailsio/runtime";
import { Machine } from "../bindings/github.com/altlimit/dutyboard/cli/desktop";
import { Snapshot, State } from "../bindings/github.com/altlimit/dutyboard/cli/desktop/host";
import FirstRun from "./FirstRun.vue";
import MachineView from "./MachineView.vue";

// One question decides which half of the app this is: is this machine connected to a DutyBoard?
// Until it is, the window is the first run; from then on it is the machine.
const status = ref<Snapshot | null>(null);

let off: (() => void) | undefined;
onMounted(async () => {
  off = Events.On("machine:status", (e) => (status.value = e.data));
  status.value = await Machine.Status();
});
onUnmounted(() => off?.());
</script>

<template>
  <template v-if="status">
    <FirstRun v-if="status.state === State.Unpaired" :status="status" />
    <MachineView v-else :status="status" />
  </template>
</template>
