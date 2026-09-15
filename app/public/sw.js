// The console's service worker, for one thing only: showing a push notification when no console tab
// is open, and opening the duty it is about when it is clicked. It caches nothing — the console is
// always the one its site serves.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "DutyBoard", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "DutyBoard", {
      body: data.body || "",
      // One notification per duty: a newer push about the same duty replaces the older one.
      tag: data.duty_id || data.t || "dutyboard",
      renotify: true,
      icon: "icon.svg",
      data: { url: data.url || "#/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "#/", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const tab of tabs) {
        if (tab.url.startsWith(self.registration.scope)) {
          await tab.focus();
          return tab.navigate ? tab.navigate(target) : undefined;
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
