// ════════════════════════════════════════════════════════════════════════════
//  sw/genesis_sw.js  —  I-AM-IOS · Core Offline Cache & Sync Service Worker
//
//  Responsibilities:
//    1. Cache all core app shells, lib assets, planespace bundles on install
//    2. Stale-while-revalidate for HTML; cache-first for JS/CSS assets
//    3. Offline fallback to /index.html for navigation requests
//    4. Background sync tag: 'sovereign-log-sync' → flushes pending events
//    5. postMessage API: CACHE_URLS | SKIP_WAITING | GET_VERSION
// ════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'i-am-ios-genesis-v5';
const OFFLINE_URL   = '/index.html';

// Core assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/sovereign-log.js',
  '/sovereign-log-inline.js',
  '/sovereign-bus.js',
  '/sovereign-network.js',
  '/sovereign-network-hybrid.js',
  '/sovereign-ledger-bridge.js',
  '/sovereign-compute-bridge.js',
  '/kernel-adapter.js',
  '/network-config.js',
  '/migration-shim.js',
  '/ollama-local-ai.js',
  '/rekernel.html',
  '/rekernel-dashboard.html',
  '/generate-value-fixed.html',
  '/apps/generate-value.html',
  '/apps/app-builder-v2.html',
  '/apps/attack.html',
  '/apps/index1.html',
  '/apps/sovereign-notepad.html',
  '/apps/I-AM-Social/index.html',
  '/apps/I-AM-Social/sovereign-log.js',
  '/apps/I-AM-Social/presence-sw.js',
  '/planespace_2/dist/planespace.min.js',
];

// ── Install: pre-cache core assets ───────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // addAll fails if any URL 404s — use individual puts so one miss
      // doesn't break the whole install.
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(resp => { if (resp.ok) cache.put(url, resp); })
            .catch(() => { /* skip unreachable asset */ })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: purge stale caches ─────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache with network fallback ────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET, cross-origin (let browser handle fonts/CDN), API, WebSocket requests
  if (request.method !== 'GET') return;
  // Allow Google Fonts, cdnjs, and other external CDNs to pass through unintercepted
  const PASSTHROUGH_ORIGINS = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
  ];
  if (url.origin !== self.location.origin) {
    if (PASSTHROUGH_ORIGINS.some(h => url.hostname === h)) return; // let browser fetch normally
    return; // drop all other cross-origin intercepts
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/presence') return;

  // Navigation → stale-while-revalidate with offline fallback
  if (request.mode === 'navigate') {
    e.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        fetch(request)
          .then(resp => { cache.put(request, resp.clone()); return resp; })
          .catch(() => cache.match(request) || cache.match(OFFLINE_URL))
      )
    );
    return;
  }

  // JS/CSS assets → cache-first, update in background
  const ext = url.pathname.split('.').pop();
  if (['js', 'css', 'mjs', 'wasm'].includes(ext)) {
    e.respondWith(
      caches.open(CACHE_VERSION).then(cache =>
        cache.match(request).then(cached => {
          const networkFetch = fetch(request).then(resp => {
            if (resp.ok) cache.put(request, resp.clone());
            return resp;
          });
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Default: network with cache fallback
  e.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ── Background Sync: flush sovereign-log events ──────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sovereign-log-sync') {
    e.waitUntil(syncSovereignLog());
  }
});

async function syncSovereignLog() {
  // Open the IndexedDB sovereign-ledger and flush any pending events
  // to the validator endpoint if configured.
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'SYNC_FLUSH', tag: 'sovereign-log-sync' });
    }
  } catch (_) {}
}

// ── Message API ───────────────────────────────────────────────────────────────
self.addEventListener('message', async e => {
  const { type, urls } = e.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'GET_VERSION') {
    e.source?.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
    return;
  }

  // Dynamically add URLs to the cache (called by apps after lazy-loading)
  if (type === 'CACHE_URLS' && Array.isArray(urls)) {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.allSettled(
      urls.map(url =>
        fetch(url, { cache: 'no-store' })
          .then(resp => { if (resp.ok) cache.put(url, resp); })
          .catch(() => {})
      )
    );
  }
});
