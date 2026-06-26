const CACHE_NAME = 'opengate-v3';

// Cache only local static files
const ASSETS = [
  '/',
  '/index.html'
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
  'jsdelivr.net',
  'ethers.io'
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
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip cross-origin API/RPC/blockchain/CDN requests — always get fresh data
  const shouldBypass = BYPASS_HOSTS.some(host => url.host.includes(host));
  if (shouldBypass) return;

  // Skip non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // For local files: Stale-While-Revalidate strategy
  // — serve from cache instantly, update cache in background
  e.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(e.request).then(cachedResponse => {
        // Fetch from network and update cache in background
        const networkFetch = fetch(e.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            // Use e.waitUntil equivalent: write to cache properly
            cache.put(e.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => null);

        // Return cached version immediately if available, else wait for network
        return cachedResponse || networkFetch;
      });
    })
  );
});
