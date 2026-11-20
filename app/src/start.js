// The app itself. Loaded by main.js only once runtime.js has said where this console points, because
// src/config.js reads that when it is first imported, and almost everything imports it.
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.js";
import "./styles.css";

import { watchNotifications } from "./lib/notify.js";

createApp(App).use(router).mount("#app");
watchNotifications();
