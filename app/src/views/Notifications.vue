<script setup>
// Being told when a duty needs you. See lib/notify.js for the two ways it arrives.
import { onMounted, ref } from "vue";
import {
  disablePush,
  enablePush,
  askPermission,
  needsHomeScreen,
  permission,
  pushOn,
  pushSupported,
  refreshPushState,
  sendTest,
  supported,
} from "../lib/notify.js";

const busy = ref(false);
const error = ref("");
const notice = ref("");

async function run(fn, done) {
  busy.value = true;
  error.value = notice.value = "";
  try {
    const res = await fn();
    notice.value = typeof done === "function" ? done(res) : done;
  } catch (err) {
    error.value = err.message || String(err);
  } finally {
    busy.value = false;
    refreshPushState().catch(() => {});
  }
}

const allowTabs = () => run(askPermission, (p) => (p === "granted" ? "Open console tabs will notify you." : "Notifications stay off: the browser was not allowed to show them."));
const turnOn = () => run(enablePush, "Push is on for this device. You will be notified even with no console open.");
const turnOff = () => run(disablePush, "Push is off for this device.");
const test = () =>
  run(sendTest, (r) =>
    r.devices ? `Sent to ${r.delivered} of ${r.devices} device${r.devices === 1 ? "" : "s"}, and any console tab you have open.` : "Sent to any console tab you have open. No device has push on yet.",
  );

onMounted(() => refreshPushState().catch(() => {}));
</script>

<template>
  <div class="container stack">
    <div>
      <h1>Notifications</h1>
      <p class="muted" style="margin: 0">
        When an agent parks a duty on a question — it lands in <strong>Needs you</strong> — everyone on that board is
        told. Nobody is told about a question they parked themselves.
      </p>
    </div>

    <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <p v-if="!supported" class="notice notice--warn">This browser cannot show notifications.</p>

    <template v-else>
      <section class="panel stack" aria-labelledby="tabs-h">
        <h2 id="tabs-h" style="margin: 0">While a console tab is open</h2>
        <p style="margin: 0">
          Any open tab — in the background, on any page — shows a notification. This needs only the browser's permission.
        </p>
        <p v-if="permission === 'granted'" class="small" style="margin: 0">✓ Allowed in this browser.</p>
        <p v-else-if="permission === 'denied'" class="notice notice--warn small" style="margin: 0">
          Blocked. Allow notifications for this site in the browser's site settings, then reload.
        </p>
        <div v-else><button type="button" class="primary" :disabled="busy" @click="allowTabs">Allow notifications</button></div>
      </section>

      <section class="panel stack" aria-labelledby="push-h">
        <h2 id="push-h" style="margin: 0">On this device, with no tab open</h2>
        <p style="margin: 0">
          Push notifications arrive with the browser closed, and on a phone. Turn them on on each device you want them on.
        </p>
        <p v-if="!pushSupported" class="notice notice--warn small" style="margin: 0">This browser does not support push notifications.</p>
        <p v-else-if="needsHomeScreen" class="notice small" style="margin: 0">
          On an iPhone or iPad, push works only from the Home Screen: tap <strong>Share → Add to Home Screen</strong>, open
          DutyBoard from there, and turn it on on this page.
        </p>
        <div v-if="pushSupported" class="row">
          <button v-if="!pushOn" type="button" class="primary" :disabled="busy" @click="turnOn">Turn on for this device</button>
          <button v-else type="button" :disabled="busy" @click="turnOff">Turn off for this device</button>
          <span v-if="pushOn" class="small">✓ On for this device.</span>
        </div>
      </section>

      <div class="row">
        <button type="button" :disabled="busy" @click="test">Send a test notification</button>
      </div>
    </template>
  </div>
</template>
