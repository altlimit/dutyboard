// Light, dark, or whatever the device says.
//
// Three states rather than two, because "dark" is not the opposite of "light" here —
// following the system is a real preference, and a two-way toggle silently opts everyone
// out of it the first time they touch the control.
//
// The chosen value is written to `data-theme` on <html>, which the stylesheet reads. The
// FIRST application happens in index.html, in a tiny inline script before any stylesheet
// loads: doing it here, after the bundle has parsed, means a light flash on every load for
// anyone who chose dark. This module owns the value afterwards.

import { ref, watch } from "vue";

const KEY = "dutyboard.theme";
export const THEMES = [
  { key: "auto", label: "System", glyph: "◐" },
  { key: "light", label: "Light", glyph: "☀" },
  { key: "dark", label: "Dark", glyph: "☾" },
];

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.key === v) ? v : "auto";
  } catch {
    // Private mode, or storage the browser refuses. A preference that cannot be saved is
    // not an error worth showing anyone — the page still works, it just forgets.
    return "auto";
  }
}

export const theme = ref(stored());

/** The colour the browser paints its own chrome with on mobile — the address bar and the
 *  gap under a bounced scroll. Left unset, a dark board sits under a white bar. */
function paintChrome(resolved) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0f1216" : "#f6f7f9");
}

function apply(value) {
  const root = document.documentElement;
  if (value === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", value);
  const resolved =
    value === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
  paintChrome(resolved);
}

watch(theme, (value) => {
  apply(value);
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* see stored() */
  }
});

// On "auto", the system can change under us — at sunset, or when someone flips the OS
// switch with this tab open.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme.value === "auto") apply("auto");
});

apply(theme.value);

export function cycleTheme() {
  const i = THEMES.findIndex((t) => t.key === theme.value);
  theme.value = THEMES[(i + 1) % THEMES.length].key;
}

export const currentTheme = () => THEMES.find((t) => t.key === theme.value) || THEMES[0];
