const CACHE_NAME = 'opengate-v5';

// Cache ONLY icons and manifest — NOT index.html!
// index.html must always be fetched fresh from the network so users
// always get the latest version after Vercel deployments.
const ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Never cache these domains
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
  'unpkg.com',
  'walletconnect.org',
  'walletconnect.com',
  'reown.net'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip external APIs — always fresh
  if (BYPASS_HOSTS.some(h => url.host.includes(h))) return;
  if (!url.protocol.startsWith('http')) return;

  // index.html and / — Network First (always fresh from Vercel)
  // Falls back to cache only if offline
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Update cache with fresh version
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request)) // offline fallback
    );
    return;
  }

  // Icons and manifest — Cache First (rarely change)
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.status === 200) cache.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || network;
      })
    )
  );
});

// Push notifications support (for future use with Firebase/Supabase)
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || 'OpenGate', {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: data
      })
    );
  } catch(err) {
    console.log('[SW] Push error:', err);
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(e.notification.data?.url || '/')
  );
});
