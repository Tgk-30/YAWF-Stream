// DebridStreamer service worker - app-shell offline support.
//
// Strategy:
//  - Hashed, immutable build assets (/assets/*): cache-first (instant,
//    offline-safe; the hash in the filename guarantees freshness).
//  - Stable resources such as icons: network-first so a release can replace
//    bytes without changing a public URL.
//  - Navigations: network-first, falling back to the cached shell when offline.
//  - Everything else same-origin: network-first with runtime caching.
//  - NEVER touch the API or the stream proxy, or the server-mode shim.
const CACHE_NAME = "debridstreamer-shell-v3";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-128.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

function cachePut(request, response) {
  if (!response || response.status !== 200 || response.type !== "basic") return;
  const clone = response.clone();
  caches.open(CACHE_NAME).then((cache) => {
    cache.put(request, clone).catch(() => undefined);
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/stream/")) return;
  if (url.pathname === "/server-mode.js") return;

  // Hashed immutable assets are safe to retain cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            cachePut(request, response);
            return response;
          }),
      ),
    );
    return;
  }

  // Navigations → network-first, fall back to the cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((response) => {
          cachePut(request, response);
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/"))),
    );
    return;
  }

  // Everything else same-origin → network-first with runtime caching.
  event.respondWith(
    fetch(request, { cache: "no-cache" })
      .then((response) => {
        cachePut(request, response);
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match("/"))),
  );
});
