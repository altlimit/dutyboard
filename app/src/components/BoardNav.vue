<script setup>
defineProps({
  projectId: { type: String, required: true },
  name: { type: String, default: "" },
  active: { type: String, required: true },
});
const tabs = [{ route: "board", label: "Duties" }, { route: "notes", label: "Notes" }, { route: "settings", label: "Settings" }];
</script>

<template>
  <nav class="board-nav" aria-label="Board navigation">
    <div class="board-nav__context">
      <router-link :to="{ name: 'boards' }">All boards</router-link>
      <span class="muted" aria-hidden="true">/</span>
      <router-link class="board-nav__name" :to="{ name: 'board', params: { projectId } }">{{ name || projectId }}</router-link>
    </div>
    <div class="board-nav__tabs">
      <router-link v-for="tab in tabs" :key="tab.route" class="board-nav__tab" :class="{ 'board-nav__tab--active': active === tab.route }" :aria-current="active === tab.route ? 'location' : undefined" :to="{ name: tab.route, params: { projectId } }">{{ tab.label }}</router-link>
    </div>
  </nav>
</template>

<style scoped>
.board-nav { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .75rem 1.5rem; padding-bottom: .75rem; border-bottom: 1px solid var(--border); }
.board-nav__context { display: flex; align-items: baseline; gap: .65rem; min-width: 0; font-size: .9rem; }
.board-nav__context > a:first-child { flex-shrink: 0; color: var(--text-dim); }
.board-nav__name { color: var(--text); font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.board-nav__context a { text-decoration: none; }
.board-nav__context a:hover { text-decoration: underline; }
.board-nav__tabs { display: flex; gap: .25rem; }
.board-nav__tab { padding: .5rem .8rem; border-radius: 6px; text-decoration: none; color: var(--text-dim); }
.board-nav__tab:hover { color: var(--text); background: var(--surface-2); }
.board-nav__tab--active { color: var(--accent); background: var(--surface-2); box-shadow: inset 0 -2px var(--accent); }
@media (max-width: 700px) {
  .board-nav { gap: .5rem; }
  .board-nav__context, .board-nav__tabs { width: 100%; }
  .board-nav__tab { flex: 1; text-align: center; padding: .65rem .5rem; }
}
</style>
