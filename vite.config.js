import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// A plain static SPA — no server, no secrets. Everything ships to the browser.
export default defineConfig({
  plugins: [vue()],
  build: { outDir: "dist" },
});
