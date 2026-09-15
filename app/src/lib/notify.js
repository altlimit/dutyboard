// Browser notifications for "a duty needs you".
//
// Two paths, one permission:
//
//   in a tab   while any console tab is open, it listens on the person's own channel and shows a
//              notification itself. Needs nothing but the permission.
//   push       the service worker (public/sw.js) shows what the function pushes, with no tab open —
//              and on a phone. Turned on per device, here.
//
// A device with push on gets the push; its open tabs then stay quiet, so nothing shows twice.

import { ref } from "vue";
import { api, onSessionChange, isSignedIn, subscribeLive } from "./altengine.js";
import { router } from "../router.js";

export const supported = typeof window !== "undefined" && "Notification" in window;
export const pushSupported = supported && "serviceWorker" in navigator && "PushManager" in window;

/** "default" (not asked), "granted" or "denied". */
export const permission = ref(supported ? Notification.permission : "denied");
/** Whether this device has push on, as far as this browser knows. */
export const pushOn = ref(false);

/** iOS delivers push only to a console added to the Home Screen and opened from there. */
export const needsHomeScreen =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) &&
  !navigator.standalone;

async function registration() {
  // Relative, so the worker's scope is wherever this console is served.
  return navigator.serviceWorker.register("sw.js", { scope: "./" });
}

export async function refreshPushState() {
  permission.value = supported ? Notification.permission : "denied";
  if (!pushSupported) return (pushOn.value = false);
  const reg = await navigator.serviceWorker.getRegistration("./");
  const sub = reg && (await reg.pushManager.getSubscription());
  pushOn.value = !!sub;
  return pushOn.value;
}

export async function askPermission() {
  if (!supported) return "denied";
  permission.value = await Notification.requestPermission();
  return permission.value;
}

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Turn push on for this device. Throws with a message a person can act on. */
export async function enablePush() {
  if (!pushSupported) throw new Error("This browser cannot receive push notifications.");
  if ((await askPermission()) !== "granted") throw new Error("Notifications are blocked for this site — allow them in the browser's site settings.");
  const { public_key } = await api("/push/key");
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(public_key) });
  await api("/push/subscribe", { subscription: sub.toJSON(), label: deviceLabel() });
  pushOn.value = true;
}

export async function disablePush() {
  if (!pushSupported) return;
  const reg = await navigator.serviceWorker.getRegistration("./");
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    await api("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
  pushOn.value = false;
}

export const sendTest = () => api("/push/test");

// --- in a tab ------------------------------------------------------------------------------

let live = null;

function show(data) {
  if (permission.value !== "granted" || pushOn.value) return;
  const n = new Notification(data.title || "DutyBoard", { body: data.body || "", tag: data.duty_id || data.t, icon: "icon.svg" });
  n.onclick = () => {
    window.focus();
    const path = String(data.url || "#/").replace(/^#/, "");
    router.push(path).catch(() => {});
    n.close();
  };
}

function start() {
  if (live || !supported || !isSignedIn()) return;
  live = subscribeLive({ mintWith: () => api("/live/me") }, (frame) => {
    const data = frame && frame.data;
    if (data && (data.t === "needs_you" || data.t === "test")) show(data);
  });
}

function stop() {
  if (live) live.close();
  live = null;
}

/** Called once at startup: listen while signed in, and stop when not. */
export function watchNotifications() {
  if (!supported) return;
  refreshPushState().catch(() => {});
  if (isSignedIn()) start();
  onSessionChange(() => (isSignedIn() ? start() : stop()));
}
