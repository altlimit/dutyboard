<script setup>
import { computed, ref } from "vue";
import { api } from "../lib/altengine.js";
import { user } from "../lib/session.js";
const props = defineProps({ activity: Object, projectId: String, ownerUid: String });
const busy = ref(false);
const message = ref("");
const error = ref("");
const allowed = computed(() => props.activity?.state === "limited" && props.activity.machineId && user.value &&
  (user.value.uid === props.ownerUid || user.value.uid === props.activity.machineOwnerUid));
async function retry() {
  busy.value = true;
  error.value = message.value = "";
  try {
    const res = await api("/machines/retry", { machine_id: props.activity.machineId, project_id: props.projectId, reset_limits: true });
    message.value = res.online === false ? "Retry saved — it will run when the machine reconnects." : "Retry requested. The machine will recheck its agents and try again.";
  } catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <div v-if="allowed" class="small" style="margin-top: 0.5rem">
    <button type="button" class="link small" :disabled="busy" title="After fixing sign-in or usage on the server, clear this board's model cooldowns and retry its held work." @click="retry">
      {{ busy ? "Requesting retry…" : "Retry now" }}
    </button>
    <p v-if="message" role="status" class="hint" style="margin: 0.35rem 0 0">{{ message }}</p>
    <p v-if="error" role="alert" class="notice notice--warn" style="margin: 0.35rem 0 0">{{ error }}</p>
  </div>
</template>
