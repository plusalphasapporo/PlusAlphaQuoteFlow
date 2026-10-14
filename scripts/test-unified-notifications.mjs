/**
 * Unified notification-center regression tests.
 * Uses the actual notification UI function with a jsdom document and
 * synthetic role-scoped RPC responses. No live customer information.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source=fs.readFileSync('index.html','utf8');
const start=source.indexOf('  async function openUnifiedNotificationCenter(){');
const end=source.indexOf('  async function setupGlobalHeader(){',start);
assert.ok(start>=0&&end>start,'Notification center source must be present');
const body=source.slice(start,end);
assert.match(source, /\$\('#notificationBtn'\)\.onclick=async\(\)=>\{\s*if\(\['support_staff','internal_admin','internal_staff'\]\.includes\(role\)\)\{\s*return openUnifiedNotificationCenter\(\)/);
assert.match(source, /The internal team does not receive CallConnect-originated alerts\./);
assert.match(source, /if\(role!=='support_staff'\) return;\s*const checkUnread=async/);
const migration=fs.readFileSync('supabase/migrations/20261014070500_internal_non_callconnect_ticket_notifications.sql','utf8');
assert.match(migration, /'ticket_count'/);
assert.match(migration, /'ticket_items'/);
assert.match(migration, /t\.description,''\) ilike '【受付経路】CallConnect%'/);
assert.match(migration, /from public\.callconnect_calls cc/);
assert.match(migration, /r\.user_id=v_user/);
assert.match(migration, /app_private\.is_internal\(\)/);

const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const id1='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
const id3='33333333-3333-4333-8333-333333333333';

function build(role, responses={}){
  const dom=new JSDOM('<!doctype html><html><body><button id="notificationBtn">通知</button><div id="home"></div></body></html>',{
    url:'https://quote-flow-preview.example/',runScripts:'outside-only'
  });
  const doc=dom.window.document;
  const rpcCalls=[], navigation=[], alerts=[];
  const data={
    bootData:{context:{role}},
    document:doc,
    $:selector=>doc.querySelector(selector),
    esc,dateTimeText:v=>String(v||''),
    mountAppModal:(html)=>{
      doc.querySelector('#appModalLayer')?.remove();
      doc.body.insertAdjacentHTML('beforeend','<div id="appModalLayer">'+html+'</div>');
    },
    closeAppModal:()=>doc.querySelector('#appModalLayer')?.remove(),
    toast:message=>alerts.push(message),
    go:async page=>navigation.push({page}),
    openTicketWorkspace:async ticketId=>navigation.push({ticketId}),
    refreshSupportUnreadBadge:async()=>({count:0}),
    refreshInternalUnreadHandoffBadge:async()=>({count:0}),
    rpc:async(name,args={})=>{
      rpcCalls.push({name,args});
      if(name in responses)return responses[name];
      if(name.startsWith('mark_'))return {};
      throw new Error('Unexpected RPC '+name);
    },
    rpcOptional:async(name,args,fallback)=>{
      rpcCalls.push({name,args});
      return name in responses?responses[name]:fallback;
    }
  };
  vm.createContext(data);
  vm.runInContext(body+'\n globalThis.openCenter=openUnifiedNotificationCenter;',data);
  const labels=()=>[...doc.querySelectorAll('.unifiedNotificationOpen')].map(n=>n.textContent);
  const click=async substring=>{
    const btn=[...doc.querySelectorAll('.unifiedNotificationOpen')]
      .find(n=>n.textContent.includes(substring));
    assert.ok(btn,'Expected notification for '+substring);
    btn.click();
    await tick();
  };
  return {dom,doc,rpcCalls,navigation,alerts,ctx:data,labels,click};
}

{
  const h=build('internal_admin',{
    internal_unread_handoff_notifications:{
      count:1,
      ticket_count:1,
      ticket_items:[{ticket_id:id1,ticket_number:'TKT-101',subject:'設定依頼 <script>alert(1)</script>',customer_name:'テスト顧客',source_label:'顧客',priority:'high',created_at:'2026-10-14T03:00:00Z'}],
      items:[{handoff_id:'h1',ticket_id:id2,ticket_number:'TKT-102',subject:'サポート引き継ぎ',customer_name:'デモ顧客',reason:'追加調査',priority:'urgent',created_at:'2026-10-14T04:00:00Z'}]
    },
    support_deadline_states:[{ticket_id:id3,deadline_state:'overdue',subject:'期限切れテスト'}]
  });
  await h.ctx.openCenter();
  assert.equal(h.labels().length,3,'Internal center shows tickets, handoffs and deadlines');
  assert.ok(h.labels().some(x=>x.includes('設定依頼')));
  assert.equal(h.doc.querySelector('#unifiedNotificationBody script'),null,'Notification text must be escaped');
  assert.ok(!h.rpcCalls.some(x=>x.name==='callconnect_unread_notifications'),'Internal never queries CallConnect alerts');
  assert.ok(!h.labels().some(x=>x.includes('CallConnect')),'Internal center has no CallConnect category');
  await h.click('サポート引き継ぎ');
  assert.deepEqual(h.navigation.at(-1),{ticketId:id2});
  assert.ok(h.rpcCalls.some(x=>x.name==='mark_internal_handoff_read'&&x.args.p_handoff_id==='h1'));
  assert.equal(h.doc.querySelector('#appModalLayer'),null);
  h.dom.window.close();
}
{
  const h=build('internal_staff',{
    internal_unread_handoff_notifications:{count:0,ticket_count:0,items:[],ticket_items:[]}
  });
  await h.ctx.openCenter();
  assert.match(h.doc.querySelector('#unifiedNotificationBody').textContent,/新しい通知はありません/);
  assert.ok(h.rpcCalls.every(x=>x.name!=='callconnect_unread_notifications'));
  h.dom.window.close();
}
{
  const h=build('support_staff',{
    support_unread_notifications:{count:1,items:[
      {id:id1,customer_name:'顧客A',ticket_number:'TKT-201',subject:'新規機器障害',priority:'urgent',created_at:'2026-10-14T08:10:00Z'}
    ]},
    support_unread_handoff_updates:{count:1,items:[
      {handoff_id:'handoff-1',ticket_id:id2,subject:'引き継ぎ回答',handoff_state:'completed',customer_name:'顧客B',priority:'normal',updated_at:'2026-10-14T08:12:00Z'}
    ]},
    callconnect_unread_notifications:{count:1,items:[
      {id:'call-1',support_ticket_id:null,contact_name:'顧客C',contact_number:'000-0000-0000',created_at:'2026-10-14T08:14:00Z'}
    ]},
    support_deadline_states:[{ticket_id:id3,deadline_state:'overdue',subject:'期限超過'}],
    support_next_action_states:[],
    support_unanswered_messages:{items:[],count:0}
  });
  await h.ctx.openCenter();
  assert.equal(h.labels().length,4,'Support center combines all entry types');
  assert.ok(h.labels().some(x=>x.includes('CallConnect')),'Support receives CallConnect alerts');
  assert.ok(h.labels().some(x=>x.includes('顧客A')));
  assert.ok(h.labels().some(x=>x.includes('顧客B')));
  assert.ok(h.labels().some(x=>x.includes('顧客C')));
  await h.click('CallConnect');
  assert.deepEqual(h.navigation.at(-1),{page:'support_callconnect'});
  assert.ok(h.rpcCalls.some(x=>x.name==='mark_callconnect_notification_read'&&x.args.p_notification_id==='call-1'));
  h.dom.window.close();
}
{
  const h=build('support_staff',{
    support_unread_notifications:{count:1,items:[
      {id:id1,subject:'CallConnect受付案件',priority:'high',created_at:'2026-10-14T08:00:00Z'}
    ]},
    support_unread_handoff_updates:{items:[],count:0},
    callconnect_unread_notifications:{count:1,items:[
      {id:'call-duplicate',support_ticket_id:id1,contact_name:'同一通話',created_at:'2026-10-14T08:01:00Z'}
    ]}
  });
  await h.ctx.openCenter();
  assert.equal(h.labels().length,1,'The same CallConnect ticket must not appear twice');
  await h.click('CallConnect受付案件');
  assert.deepEqual(h.navigation.at(-1),{ticketId:id1});
  h.dom.window.close();
}
{
  const h=build('customer_user');
  await h.ctx.openCenter();
  assert.deepEqual(h.navigation,[{page:'customer_status'}],'Customer users are not shown internal notifications');
  h.dom.window.close();
}
console.log('Unified notification center regression tests passed: role isolation, CallConnect suppression for internal, all-customer support, links, read receipts, HTML escape, deduplication.');
