/*
  PukaGolf service worker.

  What it deliberately does NOT do: cache pages or scores. Every number on this
  site is live — a leaderboard served from cache is worse than no leaderboard,
  because it looks current. Navigations go to the network and fall back to a
  static "you're offline" page only when the network fails outright.

  Supabase responses are never touched: they are cross-origin, they carry the
  signed-in player's data, and a cache in the browser is the wrong place for
  either.
*/

const VERSION = "v1";
const SHELL = `pukagolf-shell-${VERSION}`;
const ASSETS = `pukagolf-assets-${VERSION}`;

const OFFLINE_URL = "/offline";

/** Content-hashed by the build, so these can be kept forever. */
const IMMUTABLE = /^\/_next\/static\//;

/** Small, stable, and needed before the network is known to work. */
const PRECACHE = [
  OFFLINE_URL,
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Individually, so one 404 does not fail the whole install.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A deploy leaves the previous build's chunks behind; drop every cache
      // that is not this version's.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== SHELL && name !== ASSETS)
          .map((name) => caches.delete(name)),
      );

      // Refresh the offline page so it does not go on referencing chunks that
      // this deploy has already deleted.
      const cache = await caches.open(SHELL);
      await cache
        .add(new Request(OFFLINE_URL, { cache: "reload" }))
        .catch(() => {});

      await self.clients.claim();
    })(),
  );
});

/** The page asks for this after a deploy so the new worker takes over at once. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Anything off this origin — Supabase, the weather API, Google's fonts — is
  // left entirely alone.
  if (url.origin !== self.location.origin) return;

  // Our own API routes proxy live data. Same reasoning as the pages.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkThenOfflinePage(request));
    return;
  }

  if (IMMUTABLE.test(url.pathname) || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Live pages, with a plain offline page when the request cannot be made at all.
 */
async function networkThenOfflinePage(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL);

    return (
      cached ??
      new Response("Offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

/** Build output and icons: the URL changes when the content does. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);

  if (response.ok) {
    const cache = await caches.open(
      IMMUTABLE.test(new URL(request.url).pathname) ? ASSETS : SHELL,
    );
    await cache.put(request, response.clone());
  }

  return response;
}
