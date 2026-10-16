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
const listHtml=rows=>'<section class="card section"><div class="row between"><div><h2>案件進行管理</h2><p class="sectionDesc">見積から工事・保守までを案件ごとに追跡します。</p></div><div class="row"><button id="dealOpenQuotePicker" class="primary" type="button">見積から案件を作成</button><button id="dealGoSales" class="ghost" type="button">見積画面へ</button></div></div>'+
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
 const picker=document.getElementById('dealOpenQuotePicker');if(picker)picker.onclick=()=>openQuotePicker();
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
 let state=d.sales_outcome==='lost'?'失注':d.current_stage==='quote'?'見積':d.current_stage==='order'?'受注':d.current_stage;
 const h=host();h.innerHTML='<section class="card section"><div class="row between"><div><h2>'+e(d.title||'案件')+'</h2><p class="sectionDesc">'+e(c.customer_code||'')+' / '+e(c.name||'')+(c.parent_customer_name?' / '+e(c.parent_customer_name):'')+'</p></div><button id="dealBack" class="ghost">案件一覧へ戻る</button></div>'+
 '<div class="dealSummary"><div><small>営業結果</small><strong>'+e(OUTCOMES[d.sales_outcome]||d.sales_outcome)+'</strong></div><div><small>現在の工程</small><strong>'+e(state)+'</strong></div><div><small>次に行うこと</small><strong>'+e(d.next_action||'進行状況を確認')+'</strong></div></div>'+
 stages(state)+'<div class="dealActions">'+nextActions(d,quotes,orders)+'</div></section>'+
 '<section class="card section"><h3>見積・受注</h3>'+
 '<div class="dealRecords">'+quotes.map(q=>'<div class="dealRecord"><strong>'+e(q.quote_number||'下書き')+'</strong><span>'+e(q.project_name||'')+'</span><span>'+e(q.status==='finalized'?'見積発行済み':q.status==='draft'?'下書き':q.status==='accepted'?'既存承諾記録':q.status)+'</span></div>').join('')+'</div>'+
 '<div class="dealRecords">'+orders.map(o=>'<div class="dealRecord">受注番号 '+e(o.order_number||'未採番')+'</div>').join('')+'</div></section>'+
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
 });
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
function configure(deps){config=deps;}
window.QuoteFlowDeals={configure,openList,openDetail,openLossDialog,openIssueDialog,openOrderDialog,openReopenDialog,openQuotePicker,openFromQuote};
})();
