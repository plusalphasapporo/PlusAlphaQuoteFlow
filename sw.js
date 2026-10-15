/* QuoteFlow Cloud notification service worker.
   No authentication tokens or customer records are cached.
   Background notifications become active only after server-side Web Push
   subscription registration and delivery are configured. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?.json()||{}}catch(_){}
  const safeTitle=String(payload.title||'QuoteFlow Cloud').slice(0,100);
  const options={
    body:String(payload.body||'新しい通知があります。アプリで確認してください。').slice(0,140),
    icon:'/assets/quoteflow-mark.png',
    badge:'/assets/quoteflow-mark.png',
    tag:String(payload.tag||'quoteflow-events').slice(0,80),
    data:{url:'/'}
  };
  // External URLs are deliberately ignored to avoid open redirects.
  event.waitUntil(self.registration.showNotification(safeTitle,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      if(new URL(client.url).origin===self.location.origin){
        await client.focus();return;
      }
    }
    await self.clients.openWindow('/');
  })());
});
