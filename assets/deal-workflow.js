(function(){
'use strict';
const STAGES=['見積','受注','支払・リース','発注・入荷','工事日','施工','検収','機器・保守','サポート'];
const OUTCOMES={open:'商談中',won:'受注',lost:'失注',cancelled_after_order:'受注後キャンセル'};
const REASONS={price:'価格',competitor:'競合他社',budget:'予算見送り',postponed:'導入時期延期',customer:'顧客都合',specification:'仕様不一致',unreachable:'連絡不通',other:'その他'};
let config=null,detailCache=null,selectedId=null;
const e=x=>String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const requireStaff=()=>{if(!['internal_admin','internal_staff'].includes(config?.getRole?.()))throw Error('社内担当者のみ操作する権限があります。');};
const host=()=>{const h=config?.getHost?.();if(!h)throw Error('画面を開けません');return h;};
const rpc=(name,args={},opts={})=>config.rpc(name,args,opts);
const stages=(current)=>'<div class="dealStage">'+STAGES.map((x,i)=>'<span class="dealStageItem'+(x===current?' current':'')+'">'+e(x)+'</span>').join('')+'</div>';
const listHtml=rows=>'<section class="card section"><div class="row between"><div><h2>案件進行管理</h2><p class="sectionDesc">見積から工事・保守までを案件ごとに追跡します。</p></div><div class="row"><button id="dealOpenQuotePicker" class="primary" type="button">顧客情報確認から見積作成</button><button id="dealGoSales" class="ghost" type="button">見積画面へ</button></div></div>'+
'<div class="field"><label>案件検索</label><input type="search" id="dealSearch" placeholder="顧客・本支店・見積番号・案件名"></div>'+
'<div class="field"><label>進捗を絞り込む</label><select id="dealFilter"><option value="all">すべて</option><option value="open">商談中</option><option value="won">受注</option><option value="lost">失注</option><option value="cancelled_after_order">受注後キャンセル</option></select></div>'+
'<div id="dealTable"></div></section>';
async function openList(){
 requireStaff();
 const rows=await rpc('internal_deals_list',{}, {readOnly:true});
 const h=host();h.innerHTML=listHtml(rows||[]);
 const rerender=()=>{
  const q=(document.getElementById('dealSearch')?.value||'').trim().toLowerCase();
  const filter=document.getElementById('dealFilter')?.value||'all';
  const records=(rows||[]).filter(row=>(filter==='all'||row.sales_outcome===filter)&&
  [row.title,row.customer_name,row.parent_customer_name,row.quote_number,row.order_number,row.customer_code]
   .some(v=>String(v||'').toLowerCase().includes(q)));
  const tbody=records.map(row=>'<tr><td>'+e(row.customer_name||'')+(row.parent_customer_name?'<small> / '+e(row.parent_customer_name)+'</small>':'')+'</td><td>'+e(row.title||'')+'</td><td>'+e(row.quote_number||'—')+'</td><td>'+e(row.order_number||'—')+'</td><td>'+e(OUTCOMES[row.sales_outcome]||row.sales_outcome)+'</td><td>'+e(row.current_stage||'見積')+'</td><td>'+e(row.next_action||'商談状況を確認')+'</td><td><button class="linkBtn" data-deal-id="'+e(row.id)+'">案件を開く</button></td></tr>').join('');
  const table=document.getElementById('dealTable');if(table)table.innerHTML=records.length?
   '<div class="tableWrap"><table><thead><tr><th>顧客 / 本支店</th><th>案件名</th><th>見積</th><th>受注</th><th>結果</th><th>工程</th><th>次の操作</th><th></th></tr></thead><tbody>'+tbody+'</tbody></table></div>':
   '<div class="empty">該当する案件はありません。既存の見積から案件を登録できます。</div>';
  table?.querySelectorAll?.('[data-deal-id]').forEach(btn=>btn.onclick=()=>openDetail(btn.dataset.dealId));
 };
 document.getElementById('dealSearch')?.addEventListener('input',rerender);
 document.getElementById('dealFilter')?.addEventListener('change',rerender);
 const picker=document.getElementById('dealOpenQuotePicker');if(picker)picker.onclick=()=>window.QuoteFlowDealCustomerStep?.open();
 const sales=document.getElementById('dealGoSales');if(sales)sales.onclick=()=>config.navigate('sales');
 rerender();
}
function nextActions(d,quotes,orders){
 if(d.sales_outcome==='lost')return '<button data-deal-action="reopen" class="primary">失注案件を再開</button>';
 if(d.sales_outcome==='cancelled_after_order')return '<p>受注後キャンセル。履歴を参照してください。</p>';
 if(orders.length||d.sales_outcome==='won')return '<p>受注済み。支払・リース、仕入・納品、工事・施工へ進めます。</p>';
 const latest=quotes.at(-1);
 if(!latest)return '<p>この案件には見積がありません。見積画面で作成してください。</p><button data-deal-action="sales">見積画面</button>';
 return '<div class="row">'+(latest.status==='draft'?'<button class="primary" data-deal-action="issue" data-quote-id="'+e(latest.id)+'">見積発行</button>':'')+
 ((latest.status==='finalized'||latest.status==='accepted')?'<button class="primary" data-deal-action="order" data-quote-id="'+e(latest.id)+'">受注登録</button>':'')+
 '<button class="ghost" data-deal-action="loss" data-quote-id="'+e(latest.id)+'">失注登録</button>'+
 '<button class="ghost" data-deal-action="sales">見積画面</button></div>';
}
async function openDetail(dealId){
 requireStaff();const data=await rpc('internal_deal_detail',{p_deal_id:dealId},{readOnly:true});
 detailCache=data;selectedId=dealId;
 const d=data.deal||{},c=data.customer||{},quotes=data.quotes||[],orders=data.orders||[];
 const guidance=window.QuoteFlowDealProgress?.derive(data)||{stage:d.current_stage,nextAction:d.next_action};
 let state=guidance.stage;
 const h=host();h.innerHTML='<section class="card section"><div class="row between"><div><h2>'+e(d.title||'案件')+'</h2><p class="sectionDesc">'+e(c.customer_code||'')+' / '+e(c.name||'')+(c.parent_customer_name?' / '+e(c.parent_customer_name):'')+'</p></div><button id="dealBack" class="ghost">案件一覧へ戻る</button></div>'+
 '<div class="dealSummary"><div><small>営業結果</small><strong>'+e(OUTCOMES[d.sales_outcome]||d.sales_outcome)+'</strong></div><div><small>現在の工程</small><strong>'+e(state)+'</strong></div><div><small>次に行うこと</small><strong>'+e(guidance.nextAction||'進行状況を確認')+'</strong></div></div>'+
 stages(state)+'<div class="dealActions">'+nextActions(d,quotes,orders)+'</div></section>'+
 '<section class="card section"><h3>見積・受注</h3>'+
 '<div class="dealRecords">'+quotes.map(q=>'<div class="dealRecord"><strong>'+e(q.quote_number||'下書き')+'</strong><span>'+e(q.project_name||'')+'</span><span>'+e(q.status==='finalized'?'見積発行済み':q.status==='draft'?'下書き':q.status==='accepted'?'既存承諾記録':q.status)+'</span></div>').join('')+'</div>'+
 '<div class="dealRecords">'+orders.map(o=>'<div class="dealRecord">受注番号 '+e(o.order_number||'未採番')+'</div>').join('')+'</div></section>'+
 '<section class="card section"><h3>支払・リース</h3><p>支払方法：'+e(data.financing?.method||'未設定')+' / '+e(data.financing?.payment_state||'未設定')+' / '+e(data.financing?.lease_company||'')+'</p>'+
 (d.sales_outcome==='won'?'<button class="primary" data-deal-action="finance">支払・リースを'+(data.financing?'編集':'登録')+'</button>':'')+'</section>'+
 '<section class="card section"><h3>工事日・施工</h3>'+
 (data.installation_jobs||[]).map(j=>'<div class="dealRecord"><span>'+e(j.site_address||'工事場所未登録')+' / '+e(j.state)+'</span><button class="ghost" data-deal-job="'+e(j.id)+'">工事日程を編集</button></div>').join('')+
 (d.sales_outcome==='won'?'<button class="primary" data-deal-action="install">工事日を登録</button>':'')+'</section>'+
 '<section class="card section"><h3>既存データとの関連付け</h3><p class="muted">受注・発注・納品など、関連元が確認できた記録だけを表示します。</p>'+
 [['発注','purchase_orders','purchase','purchase_order_number'],['納品','deliveries','delivery','delivery_number'],
 ['機器','assets','asset','asset_number'],['保守契約','contracts','contract','contract_number'],['サポート','support_tickets','ticket','ticket_number']].map(([label,key,kind,num])=>
 (data[key]||[]).map(r=>'<div class="dealRecord"><span>'+e(label)+'：'+e(r[num]||r.id)+' / 関連元：'+e(r.link_source||'確認済み')+'</span>'+
 '<button class="ghost" data-deal-record="'+kind+'" data-record-id="'+e(r.id)+'">詳細を開く</button></div>').join('')).join('')+
 '</section>'+
 '<section class="card section"><h3>案件に紐づく情報</h3><div class="dealLinked">'+
 [['仕入・納品','purchase_orders','procurement'],['工事日・施工','deliveries','procurement'],['機器・保守','assets','assets'],['保守契約','contracts','contracts'],['サポート','support_tickets','support']].map(([label,key,page])=>'<button type="button" data-deal-nav="'+page+'" class="ghost">'+e(label)+' ('+e((data[key]||[]).length)+')</button>').join('')+
 '</div><p class="muted">支払・リースと施工工程の登録は後続開発で追加します。</p></section>'+
 '<section class="card section"><h3>案件の履歴</h3>'+[...(data.events||[]),...(data.loss_events||[])].map(x=>'<div class="dealRecord">'+e(x.message||x.event_type)+' '+e(x.created_at||'')+'</div>').join('')+'</section>';
 const back=document.getElementById('dealBack');if(back)back.onclick=()=>openList();
 h.querySelectorAll?.('[data-deal-action]').forEach(btn=>btn.onclick=()=>{
  const action=btn.dataset.dealAction,quoteId=btn.dataset.quoteId;
  if(action==='issue')return openIssueDialog(dealId,quoteId);
  if(action==='order')return openOrderDialog(dealId,quoteId);
  if(action==='loss')return openLossDialog(dealId,quoteId);
  if(action==='reopen')return openReopenDialog(dealId);
  if(action==='sales')return config.navigate('sales');
  if(action==='finance')return openFinancingDialog(dealId);
  if(action==='install')return openInstallationDialog(dealId);
 });
 h.querySelectorAll?.('[data-deal-job]').forEach(btn=>btn.onclick=()=>openInstallationDialog(dealId,btn.dataset.dealJob));
 h.querySelectorAll?.('[data-deal-record]').forEach(btn=>btn.onclick=()=>config.openLinked?.(btn.dataset.dealRecord,btn.dataset.recordId));
 h.querySelectorAll?.('[data-deal-nav]').forEach(btn=>btn.onclick=()=>config.navigate(btn.dataset.dealNav));
}
function openLossDialog(dealId,quoteId){
 requireStaff();
 config.openModal({title:'失注登録',confirmLabel:'失注を確定',
  description:'見積を削除せず、失注理由と再提案予定を保存します。',
  body:'<div class="modalGrid2"><div class="field"><label>失注日</label><input id="dealLostDate" type="date" required value="'+new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})+'"></div>'+
   '<div class="field"><label>失注理由</label><select id="dealLostReason" required><option value="">選択してください</option>'+Object.entries(REASONS).map(([k,v])=>'<option value="'+e(k)+'">'+e(v)+'</option>').join('')+'</select></div>'+
   '<div class="field"><label>具体的な経緯</label><textarea id="dealLostDetail" rows="3"></textarea></div>'+
   '<div class="field"><label>競合先（任意）</label><input id="dealLostCompetitor"></div>'+
   '<div class="field"><label>再提案予定日（任意）</label><input id="dealLostReproposal" type="date"></div></div>',
  onSubmit:async()=>{
   const val=id=>document.getElementById(id)?.value?.trim()||'';
   const date=val('dealLostDate'),reason=val('dealLostReason'),note=val('dealLostDetail');
   if(!date||!REASONS[reason])throw Error('失注日と理由を入力してください。');
   if(reason==='other'&&!note)throw Error('その他の失注理由の詳細を入力してください。');
   await rpc('internal_deal_mark_lost',{p_deal_id:dealId,p_quote_id:quoteId,p_lost_date:date,p_reason_category:reason,p_detail:note||null,p_competitor:val('dealLostCompetitor')||null,p_reproposal_on:val('dealLostReproposal')||null});
   config.closeModal?.();return openDetail(dealId);
  }});
}
function openIssueDialog(dealId,quoteId){
 requireStaff();config.openModal({title:'見積発行',confirmLabel:'見積を発行',body:'<p>社内承認なしで見積を発行します。見積内容をご確認ください。</p>',onSubmit:async()=>{
  await rpc('deal_issue_quote',{p_deal_id:dealId,p_quote_id:quoteId});config.closeModal?.();return openDetail(dealId);
 }});
}
function openOrderDialog(dealId,quoteId){
 requireStaff();config.openModal({title:'受注登録',confirmLabel:'受注を確定',body:'<p>顧客との合意を確認したうえで受注を登録します。管理者承認は不要です。</p>',onSubmit:async()=>{
  await rpc('deal_create_order_from_quote',{p_deal_id:dealId,p_quote_id:quoteId});config.closeModal?.();return openDetail(dealId);
 }});
}
function openReopenDialog(dealId){
 requireStaff();config.openModal({title:'失注案件の再開',confirmLabel:'案件を再開',
 body:'<div class="field"><label>再開理由</label><textarea id="dealReopenReason" required></textarea></div>',
 onSubmit:async()=>{const note=document.getElementById('dealReopenReason')?.value?.trim();if(!note)throw Error('再開理由を入力してください。');
 await rpc('internal_deal_reopen',{p_deal_id:dealId,p_reason:note});config.closeModal?.();return openDetail(dealId);}});
}
async function openQuotePicker(){
 requireStaff();const quotes=await config.listQuotes();
 const options=(quotes||[]).filter(q=>!q.deal_id).map(q=>'<option value="'+e(q.id)+'">'+e(q.quote_number||'下書き')+' / '+e(q.project_name||'案件名なし')+'</option>').join('');
 config.openModal({title:'見積から案件を登録',confirmLabel:'案件を作成',
 body:'<div class="field"><label>既存見積を選択</label><select id="dealQuoteSelect" required><option value="">選択してください</option>'+options+'</select></div>',
 onSubmit:async()=>{const id=document.getElementById('dealQuoteSelect')?.value;
  if(!id)throw Error('見積を選んでください');await openFromQuote(id);
 }});
}
async function openFromQuote(quoteId){
 requireStaff();const created=await rpc('internal_deal_open_from_quote',{p_quote_id:quoteId});
 config.closeModal?.();return openDetail(created.id);
}

function openFinancingDialog(dealId){
 requireStaff();
 const f=detailCache?.financing||{};
 const options=(id,entries,active)=>'<select id="'+id+'">'+entries.map(([v,l])=>'<option value="'+v+'"'+(v===active?' selected':'')+'>'+l+'</option>').join('')+'</select>';
 config.openModal({title:'支払・リースを登録・編集',confirmLabel:'支払条件を保存',
 body:'<div class="modalGrid2"><div class="field"><label>支払方法</label>'+
 options('dealFinanceMethod',[['lease','リース'],['bank_transfer','振込'],['cash','現金'],['installment','分割'],['invoice','後払い'],['other','その他']],f.method||'lease')+
 '</div><div class="field"><label>入金状況</label>'+
 options('dealPaymentState',[['not_started','未請求'],['invoiced','請求済み'],['partially_paid','一部入金'],['paid','入金済み'],['overdue','入金遅延']],f.payment_state||'not_started')+
 '</div><div class="field"><label>リース会社</label><input id="dealLeaseCompany" value="'+e(f.lease_company||'')+'"></div>'+
 '<div class="field"><label>与信結果</label>'+
 options('dealCreditStatus',[['pending','審査中'],['conditional','条件付承認'],['approved','承認'],['denied','否決']],f.credit_status==='not_required'?'pending':f.credit_status||'pending')+
 '</div><div class="field"><label>期間（月）</label><input id="dealLeaseMonths" type="number" min="1" value="'+e(f.lease_months||'')+'"></div>'+
 '<div class="field"><label>月額</label><input id="dealMonthlyAmount" type="number" min="0" value="'+e(f.monthly_amount||'')+'"></div>'+
 '<div class="field"><label>備考</label><textarea id="dealPaymentNote">'+e(f.note||'')+'</textarea></div></div>',
 onSubmit:async()=>{
 const v=id=>document.getElementById(id)?.value?.trim()||'';
 const method=v('dealFinanceMethod');
 const payload={method,payment_state:v('dealPaymentState'),note:v('dealPaymentNote')||null,
   credit_status:method==='lease'?v('dealCreditStatus'):'not_required',
   lease_company:method==='lease'?v('dealLeaseCompany')||null:null,
   lease_months:method==='lease'&&v('dealLeaseMonths')?Number(v('dealLeaseMonths')):null,
   monthly_amount:method==='lease'&&v('dealMonthlyAmount')?Number(v('dealMonthlyAmount')):null};
 await rpc('internal_deal_set_financing',{p_deal_id:dealId,p_payload:payload});
 config.closeModal?.();await openDetail(dealId);
 }});
}
function toTokyoLocal(iso){
 if(!iso)return '';
 const d=new Date(iso);
 if(!Number.isFinite(d.getTime()))return '';
 return new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo',hourCycle:'h23'}).format(d).replace(' ','T');
}
function tokyoUtc(v){
 if(!v)return null;
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v))throw Error('工事日付の形式を確認してください');
 const d=new Date(v+':00+09:00');
 if(!Number.isFinite(d.getTime()))throw Error('工事日付を確認してください');
 return d.toISOString();
}
function openInstallationDialog(dealId,jobId=null){
 requireStaff();
 const job=(detailCache?.installation_jobs||[]).find(x=>x.id===jobId)||{};
 const opts=(id,items,active)=>'<select id="'+id+'">'+items.map(([k,v])=>'<option value="'+k+'"'+(k===active?' selected':'')+'>'+v+'</option>').join('')+'</select>';
 config.openModal({title:jobId?'工事日程を編集':'工事日を登録',confirmLabel:'保存',
 body:'<div class="modalGrid2"><div class="field"><label>工事開始（日本時間）</label><input id="dealInstallStart" type="datetime-local" value="'+e(toTokyoLocal(job.scheduled_start_at))+'"></div>'+
 '<div class="field"><label>工事終了（日本時間）</label><input id="dealInstallEnd" type="datetime-local" value="'+e(toTokyoLocal(job.scheduled_end_at))+'"></div>'+
 '<div class="field"><label>状態</label>'+opts('dealInstallState',[['tentative','仮予約'],['confirmed','確定'],['postponed','延期'],['in_progress','作業中'],['completed','完了'],['revisit_required','再訪問必要'],['cancelled','中止']],job.state||'tentative')+'</div>'+
 '<div class="field"><label>検収</label>'+opts('dealInstallAcceptance',[['pending','未検収'],['accepted','検収済み'],['rejected','不合格'],['not_required','対象外']],job.acceptance_state||'pending')+'</div>'+
 '<div class="field"><label>工事場所</label><input id="dealInstallSite" value="'+e(job.site_address||'')+'"></div>'+
 '<div class="field"><label>納品記録</label><select id="dealInstallDelivery"><option value="">紐付けなし</option>'+
 (detailCache?.deliveries||[]).map(d=>'<option value="'+e(d.id)+'"'+(d.id===job.delivery_id?' selected':'')+'>'+e(d.delivery_number||d.id)+'</option>').join('')+'</select></div>'+
 '<div class="field"><label>担当者ID</label><input id="dealInstallAssignee" value="'+e(job.assigned_user_id||'')+'"></div>'+
 '<div class="field"><label>検収確認者</label><input id="dealInstallAcceptanceBy" value="'+e(job.accepted_by||'')+'"></div>'+
 '<div class="field"><label>作業記録・延期理由</label><textarea id="dealInstallNote">'+e(job.work_note||'')+'</textarea></div></div>',
 onSubmit:async()=>{
 const v=id=>document.getElementById(id)?.value?.trim()||'';
 const start=tokyoUtc(v('dealInstallStart')),end=tokyoUtc(v('dealInstallEnd'));
 if(start&&end&&Date.parse(end)<=Date.parse(start))throw Error('終了時刻は開始時刻より後にしてください');
 const state=v('dealInstallState'),note=v('dealInstallNote'),acceptance=v('dealInstallAcceptance');
 if(state==='postponed'&&!note)throw Error('延期理由を入力してください');
 if(acceptance==='accepted'&&(state!=='completed'||!v('dealInstallAcceptanceBy')))throw Error('完了後に検収担当者を入力してください');
 const payload={id:jobId||null,state,scheduled_start_at:start,scheduled_end_at:end,
   site_address:v('dealInstallSite')||null,work_note:note||null,acceptance_state:acceptance,
   accepted_by:v('dealInstallAcceptanceBy')||null,delivery_id:v('dealInstallDelivery')||null,
   assigned_user_id:v('dealInstallAssignee')||null,
   completed_at:state==='completed'?(job.completed_at||new Date().toISOString()):null};
 await rpc('internal_deal_save_installation',{p_deal_id:dealId,p_job:payload});
 config.closeModal?.();await openDetail(dealId);
 }});
}

function configure(deps){config=deps;}
window.QuoteFlowDeals={configure,openList,openDetail,openLossDialog,openIssueDialog,openOrderDialog,openReopenDialog,openQuotePicker,openFromQuote,openFinancingDialog,openInstallationDialog};
})();
