const CACHE_NAME = 'opengate-v4';

// Cache only local static files — served instantly from cache
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Domains to NEVER cache — always fetch fresh from network
const BYPASS_HOSTS = [
  'supabase.co',
  'pinata.cloud',
  'ipfs.io',
  'cloudflare-ipfs.com',
  'dweb.link',
  'cloudinary.com',
  'liteforge.rpc.caldera.xyz',
  'bsc-dataseed.binance.org',
  'bscscan.com',
  'googleapis.com',
  'cdnjs.cloudflare.com',
  'jsdelivr.net'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip external API/RPC/blockchain — always fresh data
  const shouldBypass = BYPASS_HOSTS.some(host => url.host.includes(host));
  if (shouldBypass) return;

  if (!url.protocol.startsWith('http')) return;

  // Stale-While-Revalidate for local files
  e.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(e.request).then(cachedResponse => {
        const networkFetch = fetch(e.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(e.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => null);

        return cachedResponse || networkFetch;
      });
    })
  );
});
