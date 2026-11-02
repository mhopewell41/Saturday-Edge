const CACHE = 'saturday-edge-shell-v092';
const SHARE_CACHE = 'saturday-edge-share-v1';
const SHARED_BET_SLIP_KEY = './shared-bet-slip';
const SHELL = ['./', './index.html', './styles.css?v=92', './app.js?v=92', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

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
        if(file && typeof file.arrayBuffer === 'function'){
          const cache = await caches.open(SHARE_CACHE);
          await cache.put(
            SHARED_BET_SLIP_KEY,
            new Response(file, {headers:{'Content-Type':file.type || 'image/png'}})
          );
          return Response.redirect(new URL('./?importBetSlip=1', event.request.url).toString(), 303);
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
