(function(){
'use strict';
const bell='<svg viewBox="0 0 24 24" aria-hidden="true" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';
const css='#notificationBtn.qfcBell{display:inline-flex;justify-content:center;align-items:center;background:transparent;border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;width:42px;height:42px}#notificationBtn.qfcBell:hover{background:rgba(255,255,255,.12)}#qfcNotifyPanel{position:fixed;z-index:80;right:16px;top:74px;width:min(400px,calc(100vw - 20px));max-height:78vh;overflow:auto;border:1px solid #dfe6f1;box-shadow:0 20px 65px rgba(15,23,42,.24);border-radius:16px;background:#fff;color:#172033}#qfcNotifyPanel[hidden]{display:none!important}.qfcNotifyHead{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:16px;border-bottom:1px solid #e2e8f0}.qfcNotifyHead strong{font-size:16px}.qfcNotifyHead small{display:block;color:#64748b;font-size:11px;margin-top:4px}.qfcNotifyButtons{display:flex;gap:6px}.qfcNotifyButtons button,.qfcNotifyFoot button{border:1px solid #dbe3f0;border-radius:9px;background:#fff;padding:8px;color:#1d4ed8;font-size:12px;font-weight:700}.qfcNotifyButtons button:disabled{opacity:.5}.qfcNotifyList{padding:10px;max-height:55vh;overflow:auto}.qfcNotifyItem{padding:10px;border-bottom:1px solid #edf2f7}.qfcNotifyItem strong{display:block;font-size:12px}.qfcNotifyItem small{display:block;color:#64748b;margin-top:3px;font-size:11px}.qfcNotifySection{font-size:11px;font-weight:800;color:#475569;margin:12px 0 5px}.qfcNotifyFoot{padding:11px;display:flex;justify-content:space-between;gap:8px;border-top:1px solid #e2e8f0}.qfcNotifyFoot small{font-size:10px;color:#64748b}';
let cfg=null,open=false,fetching=false,initialized=false,seen=null;
const $=(s)=>document.querySelector(s);
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function ensure(){
 const btn=$('#notificationBtn');if(!btn)return;
 if(!$('#qfcNotifyStyle')){const style=node('style');style.id='qfcNotifyStyle';style.textContent=css;document.head.append(style)}
 btn.classList.add('qfcBell');
 const badge=btn.querySelector('#notificationCount');
 btn.replaceChildren();const svg=node('span');svg.innerHTML=bell;btn.append(svg);if(badge)btn.append(badge);
 btn.setAttribute('aria-label','通知センター');btn.setAttribute('aria-expanded',String(open));
 let panel=$('#qfcNotifyPanel');
 if(!panel){
  panel=node('aside');panel.id='qfcNotifyPanel';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','通知センター');panel.hidden=true;
  const head=node('div','qfcNotifyHead'),name=node('div');
  name.append(node('strong','', '通知センター'),node('small','qfcNotifySubtitle','通知を取得しています'));
  const actions=node('div','qfcNotifyButtons'),mark=node('button','','すべて既読'),close=node('button','','×');
  mark.id='qfcNotifyMarkAll';close.id='qfcNotifyClose';mark.type=close.type='button';
  mark.onclick=markAll;close.onclick=()=>toggle(false);
  actions.append(mark,close);head.append(name,actions);
  const list=node('div','qfcNotifyList');list.id='qfcNotifyList';
  const footer=node('div','qfcNotifyFoot'),permit=node('button','','端末通知を許可');
  permit.type='button';permit.onclick=askPermission;
  footer.append(node('small','','要対応アラートは全既読後も残ります'),permit);
  panel.append(head,list,footer);document.body.append(panel);
 }
 btn.onclick=()=>toggle(!open);
 if(!initialized){
  initialized=true;
  document.addEventListener('keydown',e=>{if(e.key==='Escape')toggle(false)});
  document.addEventListener('pointerdown',e=>{if(open&&!e.target.closest('#qfcNotifyPanel')&&!e.target.closest('#notificationBtn'))toggle(false)});
 }
}
function toggle(state){open=!!state;ensure();const p=$('#qfcNotifyPanel');if(p)p.hidden=!open;if(open)refresh();}
async function collect(){
 const role=cfg.role;
 const safe=(name)=>cfg.rpc(name).catch(()=>null);
 const [calls,deadlines,unread,handoffs,queue,unanswered]=await Promise.all([
  safe('callconnect_unread_notifications'),safe('support_deadline_states'),
  role==='support_staff'?safe('support_unread_notifications'):null,
  safe(role==='support_staff'?'support_unread_handoff_updates':'internal_unread_handoff_notifications'),
  role==='support_staff'?safe('support_next_action_states'):null,
  role==='support_staff'?safe('support_unanswered_messages'):null
 ]);
 const items=[],alerts=[];
 const add=(arr,type,title,desc,key)=>{if(arr)arr.push({type,title,desc:String(desc||''),key:String(key||'')})};
 for(const i of calls?.items||[])add(items,'call','CallConnect着信',i.matched_customer_name||i.contact_company||i.contact_number,'call:'+i.id);
 if(role==='support_staff'){
  for(const i of unread?.items||[])add(items,'ticket','新着問い合わせ・返信',i.customer_name||i.subject,'ticket:'+i.id);
  for(const i of handoffs?.items||[])add(items,'handoff','引継ぎの更新',i.subject,'handoff:'+i.handoff_id);
  for(const i of queue||[])if(i.notification_active!==false&&['warning','critical'].includes(i.alert_level))add(alerts,'attention','滞留中の案件',i.subject,'queue:'+i.ticket_id);
  for(const i of unanswered?.items||[])if(['attention','warning','critical'].includes(i.wait_level))add(alerts,'attention','未返信アラート',i.subject,'reply:'+i.ticket_id);
 }else{
  for(const i of handoffs?.items||[])add(items,'handoff','自社への引継ぎ',i.customer_name||i.subject,'handoff:'+i.handoff_id);
  for(const i of handoffs?.ticket_items||[])add(items,'ticket','問い合わせの更新',i.customer_name||i.subject,'ticket:'+i.id);
 }
 for(const i of deadlines||[])if(['overdue','due_today'].includes(i.deadline_state))add(alerts,'attention','対応期限アラート',i.subject,'due:'+i.ticket_id);
 return {items:items.filter((v,i,a)=>a.findIndex(x=>x.key===v.key)===i),alerts:alerts.filter((v,i,a)=>a.findIndex(x=>x.key===v.key)===i)};
}
async function refresh(){
 if(!cfg||fetching)return;fetching=true;
 const list=$('#qfcNotifyList');
 try{
  const {items,alerts}=await collect();
  if(list){
   list.replaceChildren();
   for(const [title,rows] of [['未読通知',items],['要対応アラート（既読とは別）',alerts]]){
    if(!rows.length)continue;
    list.append(node('div','qfcNotifySection',title));
    for(const i of rows.slice(0,40)){const row=node('div','qfcNotifyItem');row.append(node('strong','',i.title),node('small','',i.desc));list.append(row);}
   }
   if(!items.length&&!alerts.length)list.append(node('div','qfcNotifyItem','新しい通知はありません'));
  }
  const sub=$('.qfcNotifySubtitle');if(sub)sub.textContent='未読 '+items.length+'件 / 要対応 '+alerts.length+'件';
  const mark=$('#qfcNotifyMarkAll');if(mark)mark.disabled=items.length===0;
  const current=new Set(items.map(i=>i.key));
  if(seen!==null&&document.visibilityState==='hidden'&&'Notification' in window&&Notification.permission==='granted'){
   const fresh=items.filter(i=>!seen.has(i.key));
   if(fresh.length){try{new Notification('QuoteFlow Cloud',{body:'新しい通知 '+fresh.length+'件',tag:'qfc-new'})}catch(_){}}
  }
  seen=current;
 }catch(error){if(list)list.textContent='通知を読み込めませんでした。';console.error('Notification refresh failed',error)}
 finally{fetching=false;}
}
async function markAll(){
 if(!cfg)return;const btn=$('#qfcNotifyMarkAll');btn.disabled=true;
 try{await cfg.rpc('mark_all_quote_notifications_read',{}, {readOnly:false});seen=null;await cfg.refreshBadges();await refresh();cfg.toast('通知をすべて既読にしました');}
 catch(error){cfg.toast(error.message||'既読にできませんでした')}
 finally{btn.disabled=false}
}
async function askPermission(){
 if(!('Notification' in window)||!window.isSecureContext)return cfg.toast('このブラウザでは通知を利用できません');
 if(/iPhone|iPad|iPod/i.test(navigator.userAgent)&&!matchMedia('(display-mode: standalone)').matches)return cfg.toast('iPhoneではホーム画面に追加したアプリから通知を許可してください');
 const status=await Notification.requestPermission();
 cfg.toast(status==='granted'?'通知を許可しました。アプリ起動中の通知に対応します。':'通知を許可できませんでした');
}
window.QuoteFlowNotificationCenter={mount(options){cfg=options;ensure();refresh()},refresh,close(){toggle(false)}};
})();
