const C="jenn-v1";
self.addEventListener("install",e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(["/manifest.json","/icon-192.png"])));self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(clients.claim());});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET"||e.request.url.includes("/api/"))return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request)));
});