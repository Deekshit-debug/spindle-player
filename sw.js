/*
 * Spindle service worker.
 *
 * Strategy: Cache-First for everything. On install, we try to precache the
 * app shell (the HTML page, manifest, and icons). Anything else \u2014 including
 * the Google Fonts / jsmediatags / JSZip CDN requests \u2014 gets cached the
 * first time it's successfully fetched, then served from cache on every
 * later request, network permitting or not.
 *
 * NOTE: this file only has any effect once Spindle is served over http(s)
 * (e.g. GitHub Pages, Netlify, or any real web server). Browsers refuse to
 * register a service worker for a page opened directly from disk
 * (file:// / content://), so while you're testing locally this file is
 * simply inert \u2014 it changes nothing and breaks nothing.
 */

const CACHE_NAME = 'spindle-cache-v4';

// Bump this whenever CORE_ASSETS changes, so old caches get cleaned up on the next visit.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './fonts/ClashDisplay-Variable.woff2',
  './fonts/Satoshi-Regular.woff2',
  './fonts/Satoshi-Bold.woff2',
  './fonts/Manrope-Bold.woff2',
  './media/bg-nature.mp4',
  './media/bg-edit.mp4',
  './media/bg-yotei.mp4',
  './media/bg-loop-a.mp4',
  './media/bg-loop-b.mp4',
  './media/bg-art.jpg',
  './media/thumb-nature.jpg',
  './media/thumb-edit.jpg',
  './media/thumb-yotei.jpg',
  './media/thumb-loop-a.jpg',
  './media/thumb-loop-b.jpg',
  './media/thumb-art.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache each asset independently so one missing/renamed file (e.g. if
      // you haven't added the icons yet) doesn't stop the rest from precaching.
      return Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('Spindle SW: could not precache', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return; // never intercept uploads/writes, only cache reads
  if(new URL(req.url).hostname === 'lrclib.net') return; // lyrics lookups always go straight to the network, never cached

  // Video playback asks for byte ranges (needed for looping/seeking). A cached full
  // response has to be sliced into a proper 206 reply or the video can fail to loop.
  if(req.headers.has('range')){
    event.respondWith(
      caches.match(req.url).then((cached) => cached || fetch(req.url)).then(async (res) => {
        if(!res || !res.ok) return res;
        const buf = await res.clone().arrayBuffer();
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range')) || [];
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
        return new Response(buf.slice(start, end + 1), {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.byteLength,
            'Content-Length': String(end - start + 1),
          },
        });
      }).catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if(cached) return cached;

      return fetch(req).then((networkResponse) => {
        // Opportunistically cache successful same-origin and CDN GET responses
        // (fonts, jsmediatags, JSZip) so they're available offline next time.
        if(networkResponse && networkResponse.ok){
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return networkResponse;
      }).catch(() => {
        // Both cache and network failed. For a page navigation, fall back to
        // the app shell itself so the UI still loads; local playback doesn't
        // depend on the network at all once the shell is up.
        if(req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
