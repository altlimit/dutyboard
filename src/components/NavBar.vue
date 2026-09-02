<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { signOut } from "../lib/altengine.js";
import { signedIn, user } from "../lib/session.js";

const route = useRoute();
const router = useRouter();

const who = computed(() => {
  const u = user.value;
  return (u && (u.profile?.name || u.name || u.identifier)) || "";
});
const projectId = computed(() => route.params.projectId || "");

async function leave() {
  await signOut();
  router.push({ name: "signin" });
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__inner">
      <router-link class="brand" :to="{ name: 'boards' }">
        <span class="brand__mark" aria-hidden="true">D</span>
        DutyBoard
      </router-link>

      <nav v-if="signedIn" aria-label="Main">
        <router-link class="navlink" :to="{ name: 'boards' }">Boards</router-link>
        <router-link v-if="projectId" class="navlink" :to="{ name: 'board', params: { projectId } }">Board</router-link>
        <router-link v-if="projectId" class="navlink" :to="{ name: 'settings', params: { projectId } }">
          Agents &amp; tokens
        </router-link>
      </nav>

      <span class="spacer"></span>

      <template v-if="signedIn">
        <span class="muted small">{{ who }}</span>
        <button type="button" @click="leave">Sign out</button>
      </template>
    </div>
  </header>
</template>
