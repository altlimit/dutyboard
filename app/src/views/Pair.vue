<script setup>
// The page `dutyboard` opens with the code it printed: #/pair?code=…. On the Machines page the same
// steps open in a panel instead.
import { useRoute } from "vue-router";
import PairMachine from "../components/PairMachine.vue";

const route = useRoute();
const code = String(route.query.code || "");
</script>

<template>
  <div class="wrap stack">
    <div>
      <h1>Pair a machine</h1>
      <p class="muted" style="margin: 0">
        Running <code class="mono">dutyboard</code> on a computer prints a code. Approve it here to let that
        computer work on your boards.
      </p>
    </div>
    <div class="panel pair-page">
      <PairMachine :code="code" />
    </div>
  </div>
</template>

<style scoped>
.pair-page { max-width: 46rem; }
</style>
