const SHELL_CACHE = "orbitdeck-lite-shell-v22";
const API_CACHE = "orbitdeck-lite-api-v3";

const SHELL_ASSETS = [
  "/lite",
  "/lite/settings",
  "/static/common/styles.css?v=20260311c",
  "/static/common/app.js?v=20261020-location",
  "/static/lite/lite.js?v=20261020-location",
  "/static/lite/settings.js?v=20261020-location",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function isApiGet(request) {
  const url = new URL(request.url);
  return request.method === "GET" && url.pathname.startsWith("/api/v1/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Location availability and ownership must always come from the live runtime.
  const requestUrl = new URL(request.url);
  if (/\/api\/v1\/location(?:\/|$)/.test(requestUrl.pathname)) {
    event.respondWith(fetch(request));
    return;
  }
  if (isApiGet(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(API_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        });
      })
    );
  }
});
