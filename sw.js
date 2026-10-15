/* QuoteFlow Cloud notification service worker.
   No authentication tokens or customer records are cached.
   Background notifications become active only after server-side Web Push
   subscription registration and delivery are configured. */
const appUrl=new URL('./',self.location.href);
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?.json()||{}}catch(_){}
  const safeTitle=String(payload.title||'QuoteFlow Cloud').slice(0,100);
  const options={
    body:String(payload.body||'新しい通知があります。アプリで確認してください。').slice(0,140),
    icon:new URL('assets/quoteflow-mark.png',appUrl).href,
    badge:new URL('assets/quoteflow-mark.png',appUrl).href,
    tag:String(payload.tag||'quoteflow-events').slice(0,80),
    data:{url:appUrl.href}
  };
  // External URLs are deliberately ignored to avoid open redirects.
  event.waitUntil(self.registration.showNotification(safeTitle,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      const clientUrl=new URL(client.url);
      if(clientUrl.origin===appUrl.origin && clientUrl.pathname.startsWith(appUrl.pathname)){
        await client.focus();return;
      }
    }
    await self.clients.openWindow(appUrl.href);
  })());
});
