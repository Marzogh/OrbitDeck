const SHELL_CACHE = "orbitdeck-lite-shell-v6";
const API_CACHE = "orbitdeck-lite-api-v1";

const SHELL_ASSETS = [
  "/lite",
  "/static/common/styles.css?v=20260309k",
  "/static/common/app.js?v=20260308n",
  "/static/lite/lite.js?v=20260309k",
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

  if (isApiGet(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(request, copy));
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
