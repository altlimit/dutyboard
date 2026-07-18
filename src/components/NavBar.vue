<script setup>
import { useRouter } from "vue-router";
import { session } from "../lib/session.js";

const router = useRouter();

async function signOut() {
  await session.signOut();
  router.push({ name: "signin" });
}
</script>

<template>
  <header class="nav">
    <nav class="nav__inner" aria-label="Primary">
      <RouterLink class="nav__brand" :to="{ name: 'cities' }">🏙️ DutyBoard</RouterLink>
      <span class="nav__spacer" aria-hidden="true"></span>
      <template v-if="session.isSignedIn.value">
        <span class="nav__user">Signed in as <strong>{{ session.displayName.value }}</strong></span>
        <button type="button" class="btn btn--ghost btn--sm" @click="signOut">Sign out</button>
      </template>
      <RouterLink v-else class="btn btn--ghost btn--sm" :to="{ name: 'signin' }">Sign in</RouterLink>
    </nav>
  </header>
</template>
