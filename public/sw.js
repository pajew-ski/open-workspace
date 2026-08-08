/*
 * Open Workspace — Service Worker (Vanilla JS, kein Build-Step).
 *
 * Strategien:
 *  - Nur GET-Requests derselben Origin werden behandelt.
 *  - /api/chat* wird NIE abgefangen (Streaming-Antworten).
 *  - Navigationen:      network-first mit 4s-Timeout -> Cache -> /offline.html
 *  - GET /api/*:        network-first, Erfolge in Runtime-Cache "api", offline aus Cache
 *  - Statische Assets:  cache-first mit Hintergrund-Aktualisierung
 *  - Antworten mit Status != 200 oder Typ "opaque" werden nie gecacht.
 *
 * Versionierung: VERSION hochzählen -> alte "ow-*"-Caches werden bei
 * activate entfernt. {type: "SKIP_WAITING"} aktiviert eine wartende Version.
 */

const VERSION = "v1";
const PREFIX = "ow";
const SHELL_CACHE = `${PREFIX}-${VERSION}-shell`;
const API_CACHE = `${PREFIX}-${VERSION}-api`;
const STATIC_CACHE = `${PREFIX}-${VERSION}-static`;
const OFFLINE_URL = "/offline.html";
const NAVIGATION_TIMEOUT_MS = 4000;

const PRECACHE_URLS = [
  "/",
  OFFLINE_URL,
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(`${PREFIX}-`) &&
                !key.startsWith(`${PREFIX}-${VERSION}-`)
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/** Nur vollständige, nicht-opake 200er-Antworten sind cachebar. */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type !== "opaque";
}

/** fetch mit hartem Timeout (AbortController). */
function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/** Navigationen: network-first (4s), dann Cache, dann Offline-Seite. */
async function handleNavigation(request) {
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
    if (isCacheable(response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/** GET /api/*: network-first, Erfolge in den Runtime-Cache, offline aus Cache. */
async function handleApi(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

/** Statische Assets: cache-first, Aktualisierung läuft im Hintergrund. */
async function handleStatic(event, request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        return cache.put(request, response.clone()).then(() => response);
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  return new Response("Offline", { status: 503 });
}

/** Erkennung statischer Assets (Next-Build-Output, Icons, Fonts, Manifest). */
function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.json" ||
    pathname === "/favicon.ico" ||
    /\.(?:woff2?|ttf|otf|eot)$/.test(pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // (a) Nur GET; alles andere unangetastet durchlassen.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Fremde Origins nicht anfassen (vermeidet opake Antworten im Cache).
  if (url.origin !== self.location.origin) return;

  // (a) Chat-Streaming niemals abfangen.
  if (url.pathname.startsWith("/api/chat")) return;

  // (b) Navigationen.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // (c) API-GETs.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(handleApi(request));
    return;
  }

  // (d) Statische Assets.
  if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStatic(event, request));
  }
});
