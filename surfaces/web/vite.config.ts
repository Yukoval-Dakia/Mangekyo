import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';

// Only shipped application assets go into the offline shell. API responses have their own access rules.
export default defineConfig({
  plugins: [{
    name: 'offline-shell',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(path => path === 'index.html' || /\.(?:js|css)$/.test(path)).map(path => '/'+path);
      const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0,16);
      this.emitFile({type:'asset',fileName:'offline-shell.js',source:`
const name = 'mangekyo-shell-${version}';
const assets = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(name).then(cache => cache.addAll(assets))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('mangekyo-shell-') && key !== name).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(name)).match('/index.html')));
  } else if (assets.includes(url.pathname)) {
    event.respondWith(caches.open(name).then(async cache => (await cache.match(url.pathname)) || fetch(event.request)));
  }
});
`});
    },
  }],
});
