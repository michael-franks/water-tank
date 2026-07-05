/* Water Tank Monitor service worker: offline app-shell + last-known API data + web push.
   Bump CACHE / API_CACHE when the shell asset list changes to force a refresh.
   Mirrors the Crumb PWA's service worker, plus API response caching so an
   offline open still shows the last-known tank state. */
const CACHE = 'watertank-shell-v1';
const API_CACHE = 'watertank-api-v1';
const SHELL = [
  '/',
  '/static/style.css',
  '/static/app.js',
  '/manifest.webmanifest',
  '/static/vendor/chart.umd.min.js',
  '/static/vendor/chartjs-adapter-date-fns.bundle.min.js',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  // Precache tolerantly: one missing asset must not brick the whole install.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((path) => c.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Cache-write guard: !redirected keeps Cloudflare Access login redirects from
// poisoning the cache with HTML where JSON / an asset should be.
function cacheable(res) {
  return res && res.ok && res.type === 'basic' && !res.redirected;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never intercept writes (settings/push POSTs)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin through untouched

  // Live data: network-first, fall back to the last cached JSON so an offline
  // (or between-readings) open still shows the last-known tank state.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then((res) => {
        const ct = res.headers.get('content-type') || '';
        if (cacheable(res) && ct.includes('application/json')) {
          const copy = res.clone();
          caches.open(API_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell: serve from cache instantly, refresh the cached copy in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

/* ── Web push ── */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Bach Tank';
  const opts = {
    body: data.body || '',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    tag: data.tag || 'watertank',
    data: { url: data.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          return c.focus().then((win) => (win && 'navigate' in win) ? win.navigate(target) : win);
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
