const CACHE_NAME = "crm1-shell-v2";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/static/css/app.css",
  "/static/js/app.js",
  "/static/icons/icon.svg",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("/", clone));
          return response;
        })
        .catch(async () => (await caches.match("/")) || Response.error())
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }))
    );
  }
});

// Background Sync (progressive enhancement): when the browser regains
// connectivity it wakes the service worker even if no tab is open. We
// can't reach IndexedDB-backed app state from here without duplicating
// the sync engine, so we ask any open tab to flush its queue; if the
// app isn't open the browser will simply retry this event later, and
// the queue flushes for real the next time the app is opened anyway.
self.addEventListener("sync", event => {
  if (event.tag === "crm-sync-queue") {
    event.waitUntil(
      self.clients.matchAll({ type: "window" }).then(clients => {
        clients.forEach(client => client.postMessage({ type: "crm-run-sync" }));
      })
    );
  }
});