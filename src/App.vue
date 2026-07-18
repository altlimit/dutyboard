<script setup>
import NavBar from "./components/NavBar.vue";
</script>

<template>
  <a class="skip-link" href="#main">Skip to main content</a>
  <NavBar />
  <main id="main" class="container">
    <RouterView />
  </main>
</template>
