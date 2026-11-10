const SHELL = [
  '/overseer/',
  '/overseer/offline.html',
  '/overseer/overseer.js',
  '/visual.css',
  '/supabase.js',
  '/site-config.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open('overseer-shell').then(function (cache) {
    return cache.addAll(SHELL);
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/overseer/') !== 0 && url.pathname !== '/visual.css' && url.pathname !== '/supabase.js' && url.pathname !== '/site-config.js') return;
  event.respondWith(fetch(event.request).then(function (response) {
    const copy = response.clone();
    caches.open('overseer-shell').then(function (cache) { cache.put(event.request, copy); });
    return response;
  }).catch(function () {
    return caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('/overseer/offline.html');
      return new Response('Offline', { status: 503 });
    });
  }));
});

self.addEventListener('push', function (event) {
  let payload = { title: 'Overseer', body: 'Cached status changed.' };
  try { payload = event.data ? event.data.json() : payload; }
  catch (error) { payload = { title: 'Overseer', body: event.data ? event.data.text() : payload.body }; }
  event.waitUntil(self.registration.showNotification(payload.title || 'Overseer', {
    body: payload.body || '',
    icon: '/overseer/icon-192.png'
  }));
});
