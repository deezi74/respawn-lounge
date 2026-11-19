const CACHE = 'respawn-public-shell-v2';
const PUBLIC_ASSETS = ['/offline.html', '/brand/logo.svg', '/brand/icon-192.png', '/brand/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('respawn-public-shell-') && key !== CACHE)
      .map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/') ||
      url.pathname === '/manus-storage' || url.pathname.startsWith('/manus-storage/')) return;

  // Only this explicit public allowlist is cached. Never store pages, API data, or media.
  if (PUBLIC_ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(CACHE).then(cache =>
      cache.match(event.request).then(cached => cached || fetch(event.request))
    ));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() =>
      caches.open(CACHE).then(cache => cache.match('/offline.html'))
    ));
  }
});
