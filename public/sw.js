// Service worker: keeps the app, map tiles (incl. GovMap layers) and viewed photos available without network.
const VERSION = 'v6';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v2'; // v2: drop CARTO tiles cached with the "API key required" image
const PHOTOS = 'photos-v1';
const MAX_TILES = 4000;

const SHELL_FILES = [
  '/', '/index.html', '/css/app.css?v=6', '/js/app.js?v=5', '/js/layers.js', '/js/sync.js', '/js/db.js', '/js/osm.js', '/js/citymap.js',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/geoman/leaflet-geoman.min.js', '/vendor/geoman/leaflet-geoman.css',
  '/vendor/leaflet/images/marker-icon.png', '/vendor/leaflet/images/marker-icon-2x.png', '/vendor/leaflet/images/marker-shadow.png',
  '/img/icon-64.png', '/img/icon-192.png', '/img/icon-512.png', '/manifest.webmanifest',
];
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org', 'open.govmap.gov.il'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, TILES, PHOTOS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache first (Sderot does not move), refresh in the background.
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Photos never change once uploaded: cache first.
  if (url.pathname === '/api/photo') {
    e.respondWith((async () => {
      const cache = await caches.open(PHOTOS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Other API calls: network only (the app keeps its own offline copy in IndexedDB).
  if (url.pathname.startsWith('/api/')) return;

  // App shell: network first so updates arrive, cache when offline.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req)) || (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
    }
  })());
});
