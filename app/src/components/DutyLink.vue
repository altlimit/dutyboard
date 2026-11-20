<script setup>
// A link to a duty. On a page that reads duties in a panel (see useDutyPanel) a plain click opens it
// there, over the page; a middle click, or one with a key held, opens its own page as any link does.
// Anywhere else it is an ordinary link.
import { useOpenDuty } from "../lib/useDutyPanel.js";

defineProps({
  projectId: { type: String, required: true },
  dutyId: { type: String, required: true },
});
// Classes and the like go on the link itself, not on the router-link around it.
defineOptions({ inheritAttrs: false });
const openDuty = useOpenDuty();
</script>

<template>
  <router-link v-slot="{ href, navigate }" custom :to="{ name: 'duty', params: { projectId, dutyId } }">
    <a :href="href" v-bind="$attrs" @click="openDuty($event, projectId, dutyId, navigate)"><slot /></a>
  </router-link>
</template>
