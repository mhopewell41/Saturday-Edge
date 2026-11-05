const CACHE = 'saturday-edge-shell-v094a';
const SHARE_CACHE = 'saturday-edge-share-v1';
const SHARED_BET_SLIP_KEY = './shared-bet-slip';
const SHARED_HISTORY_TEXT_KEY = './shared-history-text';
const SHELL = ['./', './index.html', './styles.css?v=94a', './app.js?v=94a', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== SHARE_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if(event.request.method === 'POST' && url.pathname.endsWith('/share-target')){
    event.respondWith((async()=>{
      try{
        const formData = await event.request.formData();
        const file = formData.get('betSlipImage');
        const sharedText = [formData.get('sharedTitle'),formData.get('sharedText')].filter(Boolean).join('\n').trim();
        const cache = await caches.open(SHARE_CACHE);
        if(file && typeof file.arrayBuffer === 'function' && file.size){
          await cache.put(
            SHARED_BET_SLIP_KEY,
            new Response(file, {headers:{'Content-Type':file.type || 'image/png'}})
          );
          return Response.redirect(new URL('./?importBetSlip=1', event.request.url).toString(), 303);
        }
        if(sharedText){
          await cache.put(
            SHARED_HISTORY_TEXT_KEY,
            new Response(sharedText, {headers:{'Content-Type':'text/plain; charset=utf-8'}})
          );
          return Response.redirect(new URL('./?importHistory=1', event.request.url).toString(), 303);
        }
        return Response.redirect(new URL('./', event.request.url).toString(), 303);
      }catch(error){
        return Response.redirect(new URL('./?importBetSlipError=1', event.request.url).toString(), 303);
      }
    })());
    return;
  }

  if(event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(()=>{});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
