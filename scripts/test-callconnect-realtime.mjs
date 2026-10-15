/**
 * CallConnect real-time alert regression tests.
 * Evaluates the exact production startCallConnectNotificationRealtime function
 * using synthetic authorization RPC results and controlled intervals/events.
 *
 * No external accounts, customer information or live network calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const a=html.indexOf('  async function startCallConnectNotificationRealtime(){');
const b=html.indexOf('  async function startSupportRealtime(){',a);
assert.ok(a>=0&&b>a,'Production CallConnect function exists');
const source=html.slice(a,b);
const cleanupSource=html.slice(html.indexOf("if(event==='SIGNED_OUT')"),html.indexOf("if(event==='TOKEN_REFRESHED')"));
assert.match(source,/if\(role!=='support_staff'\) return;/);
assert.match(source,/CALLCONNECT_NOTIFICATION_FALLBACK_MS/);
assert.match(source,/if\(checking\) return;/);
assert.match(source,/if\(bootData\?\.context\?\.role!=='support_staff'\) return;/);
assert.match(source,/\.subscribe\(status=>/);
assert.match(source,/checkUnread\(notificationId\)/);
assert.doesNotMatch(source,/setInterval\(checkUnread,1000\)/);
assert.doesNotMatch(source,/showCallConnectIncomingPopup\(fastItem\)/);
assert.match(cleanupSource,/document\.removeEventListener\('visibilitychange',callconnectNotificationResumeHandler\)/);
assert.match(cleanupSource,/window\.removeEventListener\('online',callconnectNotificationResumeHandler\)/);

const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(role='support_staff',firstItems=[]){
  const documentListeners=new Map(),windowListeners=new Map();
  const intervals=new Map(),channels=[],popups=[],toasts=[],errors=[],unreadCalls=[];
  let nextInterval=1;
  let unreadItems=firstItems;
  let resolveUnread=null;
  const document={
    hidden:false,
    addEventListener:(name,fn)=>documentListeners.set(name,fn),
    removeEventListener:(name,fn)=>{
      if(documentListeners.get(name)===fn)documentListeners.delete(name);
    }
  };
  const window={
    addEventListener:(name,fn)=>windowListeners.set(name,fn),
    removeEventListener:(name,fn)=>{
      if(windowListeners.get(name)===fn)windowListeners.delete(name);
    }
  };
  const supabase={
    removed:[],
    async removeChannel(channel){this.removed.push(channel);},
    channel(name){
      const channel={
        name,handler:null,status:null,
        on(event,filter,handler){
          assert.equal(event,'postgres_changes');
          assert.equal(filter.table,'callconnect_notifications');
          assert.equal(filter.event,'INSERT');
          this.handler=handler;
          return this;
        },
        subscribe(callback){this.status=callback;return this;}
      };
      channels.push(channel);
      return channel;
    }
  };
  const state={
    document,window,supabase,
    bootData:{context:{role}},
    callconnectNotificationChannel:null,
    callconnectNotificationPollTimer:null,
    callconnectNotificationResumeHandler:null,
    CALLCONNECT_NOTIFICATION_FALLBACK_MS:60000,
    lastCallConnectPopupId:'',
    currentPage:'home',
    setInterval:(fn,ms)=>{
      const id=nextInterval++;
      intervals.set(id,{fn,ms});
      return id;
    },
    clearInterval:id=>intervals.delete(id),
    async refreshCallConnectUnread(){
      unreadCalls.push(Date.now());
      if(resolveUnread){
        const resolver=resolveUnread;
        resolveUnread=null;
        return resolver;
      }
      return {count:unreadItems.length,items:unreadItems};
    },
    async showCallConnectIncomingPopup(item){popups.push({...item});},
    async setupGlobalHeader(){},
    async renderSupportCallConnect(){},
    mountAppModal(){throw new Error('Unexpected fallback popup in this test');},
    $:()=>({onclick:null}),
    esc:input=>String(input),
    toast:message=>toasts.push(message),
    go:async()=>{},
    console:{error:(...a)=>errors.push(a.join(' ')),warn:(...a)=>errors.push(a.join(' '))}
  };
  vm.createContext(state);
  vm.runInContext(source+'\n globalThis.startCallConnect=startCallConnectNotificationRealtime;',state);
  return {
    state,document,window,channels,supabase,intervals,documentListeners,
    windowListeners,popups,toasts,unreadCalls,errors,
    setItems(items){unreadItems=items;},
    deferNext(){
      let release;
      const pending=new Promise(resolve=>{release=resolve;});
      resolveUnread=pending;
      return items=>release({count:items.length,items});
    },
    async receive(item){
      const channel=channels.at(-1);
      assert.ok(channel?.handler,'Realtime channel is active');
      await channel.handler({new:item});
    }
  };
}

{
  const h=fixture('internal_staff');
  await h.state.startCallConnect();
  assert.equal(h.unreadCalls.length,0);
  assert.equal(h.channels.length,0);
  assert.equal(h.intervals.size,0);
  assert.equal(h.documentListeners.size,0);
}

{
  const h=fixture('support_staff',[]);
  await h.state.startCallConnect();
  assert.equal(h.unreadCalls.length,1,'Initial unread check is performed');
  assert.equal(h.channels.length,1,'WebSocket channel exists');
  assert.equal(h.intervals.size,1,'Exactly one fallback interval exists');
  assert.equal([...h.intervals.values()][0].ms,60000,'Fallback is once per minute');
  assert.ok(h.documentListeners.has('visibilitychange'));
  assert.ok(h.windowListeners.has('online'));

  await h.receive({
    id:'call-1',
    contact_name:'UNVERIFIED_PRIVATE_DATA_MUST_NOT_BE_SHOWN',
    contact_number:'999-UNTRUSTED',
    record_status:201
  });
  assert.equal(h.unreadCalls.length,2,'Realtime event triggers authorized refresh');
  assert.equal(h.popups.length,0,'A row missing from authorized RPC is not displayed');

  h.setItems([{id:'call-1',contact_name:'Verified caller',contact_number:'000-0000',
    record_status:201}]);
  await h.receive({id:'call-1',contact_name:'Spoofed contact',record_status:201});
  assert.equal(h.popups.length,1);
  assert.equal(h.popups[0].contact_name,'Verified caller');
  assert.ok(!JSON.stringify(h.popups).includes('Spoofed'));
  assert.equal(h.state.lastCallConnectPopupId,'call-1');

  await h.receive({id:'call-1',contact_name:'Spoofed again'});
  assert.equal(h.popups.length,1,'Same event must not reopen popup');

  const interval=[...h.intervals.values()][0].fn;
  h.document.hidden=true;
  const before=h.unreadCalls.length;
  interval();
  await flush();
  assert.equal(h.unreadCalls.length,before,'Background tab does not poll');

  h.document.hidden=false;
  h.documentListeners.get('visibilitychange')();
  await flush();
  assert.equal(h.unreadCalls.length,before+1,'Foreground resume catches missed events');

  h.windowListeners.get('online')();
  await flush();
  assert.equal(h.unreadCalls.length,before+2,'Network resume catches missed events');

  h.channels.at(-1).status('SUBSCRIBED');
  await flush();
  assert.equal(h.unreadCalls.length,before+3,'Realtime reconnect catches missed events');

  interval();
  await flush();
  assert.equal(h.unreadCalls.length,before+4,'Slow fallback remains operational');

  const oldChannel=h.channels.at(-1);
  await h.state.startCallConnect();
  assert.equal(h.intervals.size,1,'Restart must not accumulate intervals');
  assert.equal(h.documentListeners.size,1,'Restart must not accumulate visibility handlers');
  assert.equal(h.windowListeners.size,1,'Restart must not accumulate online handlers');
  assert.ok(h.supabase.removed.includes(oldChannel),'Previous channel is removed');

  h.state.bootData.context.role='internal_admin';
  await h.state.startCallConnect();
  assert.equal(h.intervals.size,0,'Internal role never polls CallConnect');
  assert.equal(h.documentListeners.size,0,'Internal role clears old handlers');
  assert.equal(h.windowListeners.size,0,'Internal role clears old handlers');
  assert.equal(h.state.callconnectNotificationChannel,null);
}
{
  const h=fixture('support_staff');
  const release=h.deferNext();
  const starting=h.state.startCallConnect();
  await flush();
  h.state.bootData=null;
  release([{id:'call-during-signout',contact_name:'Should stay hidden'}]);
  await starting;
  assert.equal(h.popups.length,0);
  assert.equal(h.intervals.size,0,'Signout while fetching must not re-arm timer');
  assert.equal(h.channels.length,0,'Signout while fetching must not re-subscribe');
  assert.equal(h.documentListeners.size,0);
}
{
  const h=fixture('support_staff',[]);
  await h.state.startCallConnect();
  const release=h.deferNext();
  const first=h.receive({id:'call-a'});
  await flush();
  h.setItems([{id:'call-b',contact_name:'Authorized second'}]);
  const second=h.receive({id:'call-b'});
  release([{id:'call-a',contact_name:'Authorized first'}]);
  await Promise.all([first,second]);
  assert.deepEqual(h.popups.map(x=>x.id),['call-a','call-b'],
    'Burst events during an in-flight RPC should be processed without overlap');
}

console.log('CallConnect realtime checks passed: no internal alerts, one-minute fallback, authorized payloads, realtime/foreground/network recovery, deduplication, teardown, logout race and burst coalescing.');
