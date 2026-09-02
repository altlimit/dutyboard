import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The console — a plain static SPA, no server and no secrets, everything ships to the
// browser.
//
// It builds INTO the marketing site's output, under /app. `sitegen` writes public/ and
// this writes public/app, which is why `npm run build` runs them in that order: the site
// build cleans public/ first, so doing it the other way round deletes the app.
export default defineConfig({
  root: "app",
  // Assets are requested from /app/..., not /. Without this the built page asks the
  // marketing site's root for its JavaScript and gets HTML back.
  base: "/app/",
  plugins: [vue()],
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
