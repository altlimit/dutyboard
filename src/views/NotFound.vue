<template>
  <div class="wrap wrap--narrow stack">
    <h1>Not found</h1>
    <p class="muted">That page does not exist.</p>
    <p><router-link :to="{ name: 'boards' }">Go to your boards</router-link></p>
  </div>
</template>
