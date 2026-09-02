<script setup>
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import NavBar from "./components/NavBar.vue";

const route = useRoute();
const main = ref(null);

// Move focus to the new view on every navigation. Without this a screen-reader user
// stays where the old page's focus was and never hears that anything changed.
watch(
  () => route.fullPath,
  () => main.value && main.value.focus(),
);
</script>

<template>
  <a class="skip" href="#main">Skip to content</a>
  <NavBar />
  <main id="main" ref="main" tabindex="-1">
    <router-view />
  </main>
</template>
