<script setup>
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { signOut } from "../lib/altengine.js";
import { signedIn, user } from "../lib/session.js";
import { THEMES, currentTheme, cycleTheme } from "../lib/theme.js";
import { config, isRetargeted } from "../config.js";

const route = useRoute();
const router = useRouter();

const who = computed(() => {
  const u = user.value;
  return (u && (u.profile?.name || u.name || u.identifier)) || "";
});
const projectId = computed(() => route.params.projectId || "");

// One button rather than three, because this is a rarely-used control that should cost
// nothing on a phone's top bar. The label names the state it is IN and the one it moves
// to, so it is usable without seeing the glyph.
const themeNow = computed(() => currentTheme());
const themeNext = computed(() => THEMES[(THEMES.findIndex((t) => t.key === themeNow.value.key) + 1) % THEMES.length]);

// Which backend this console is pointed at, shown only when it is not the built-in one.
// "Where is this data coming from" is invisible otherwise, and it is the first question
// worth asking when a board looks wrong.
const retargeted = isRetargeted();
const backend = computed(() => config.baseUrl.replace(/^https?:\/\//, ""));

async function leave() {
  await signOut();
  router.push({ name: "signin" });
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__inner">
      <router-link class="brand" :to="{ name: 'boards' }">
        <svg class="brand__mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <rect width="64" height="64" rx="14" fill="var(--accent)"/>
          <g fill="var(--accent-text)">
            <circle cx="32" cy="9" r="4"/>
            <rect x="30.5" y="11" width="3" height="8" rx="1.5"/>
            <rect x="11" y="18" width="42" height="32" rx="8"/>
          </g>
          <g fill="var(--accent)">
            <rect x="16" y="24" width="8" height="10" rx="3"/>
            <rect x="40" y="24" width="8" height="10" rx="3"/>
            <rect x="16" y="38" width="8" height="6" rx="2"/>
            <rect x="28" y="38" width="8" height="6" rx="2"/>
            <rect x="40" y="38" width="8" height="6" rx="2"/>
          </g>
        </svg>
        DutyBoard
      </router-link>

      <nav v-if="signedIn" class="topbar__nav" aria-label="Main">
        <router-link class="navlink" :to="{ name: 'boards' }">Boards</router-link>
        <router-link v-if="projectId" class="navlink" :to="{ name: 'board', params: { projectId } }">Board</router-link>
        <router-link v-if="projectId" class="navlink" :to="{ name: 'settings', params: { projectId } }">
          Agents &amp; tokens
        </router-link>
      </nav>

      <span class="spacer"></span>

      <router-link v-if="retargeted" class="navlink nowrap" :to="{ name: 'connect' }" :title="`Connected to ${backend}`">
        <span aria-hidden="true">⇄</span> {{ backend }}
      </router-link>

      <button
        type="button"
        class="iconbtn"
        :aria-label="`Theme: ${themeNow.label}. Switch to ${themeNext.label}.`"
        :title="`Theme: ${themeNow.label} — switch to ${themeNext.label}`"
        @click="cycleTheme"
      >
        <span aria-hidden="true">{{ themeNow.glyph }}</span>
      </button>

      <template v-if="signedIn">
        <span class="muted small nowrap topbar__who">{{ who }}</span>
        <button type="button" @click="leave">Sign out</button>
      </template>
    </div>
  </header>
</template>
