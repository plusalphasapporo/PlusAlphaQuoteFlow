import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync('index.html','utf8');
let source='';
try {source=readFileSync('assets/deal-workflow.js','utf8');} catch { /* test-first: no implementation */ }
let css='';
try {css=readFileSync('assets/deal-workflow.css','utf8');} catch { /* test-first */ }

function fixture(overrides={}){
  let options=null;
  const fields=new Map();
  const host={innerHTML:'',onclick:null,contains(){return true;},querySelector(){return null;}};
  const table={innerHTML:'',querySelectorAll(){return [];}};
  const calls=[];
  const quote={id:'quote-1',deal_id:'deal-1',customer_id:'customer-1',status:'finalized',
    quote_number:'Q-1001',project_name:'複合機入替',total_amount:250000,valid_until:'2026-12-30'};
  const detail={deal:{id:'deal-1',title:'複合機入替',sales_outcome:'open',current_stage:'quote',next_action:'商談結果を登録'},
    customer:{name:'営業先株式会社',customer_code:'C-1',branch_type:'branch',parent_customer_name:'本店'},
    quotes:[quote],orders:[],purchase_orders:[],deliveries:[],assets:[],contracts:[],support_tickets:[],loss_events:[],events:[]};
  const rows=[{id:'deal-1',title:'複合機入替',customer_name:'営業先株式会社',
    parent_customer_name:'本店',sales_outcome:'open',current_stage:'quote',quote_status:'finalized',
    quote_number:'Q-1001',order_id:null,updated_at:'2026-10-16'}];
  const handlers={
    internal_deals_list:async()=>rows,
    internal_deal_detail:async()=>detail,
    internal_deal_open_from_quote:async()=>({id:'deal-1'}),
    deal_issue_quote:async()=>({id:'quote-1',status:'finalized'}),
    deal_create_order_from_quote:async()=>({id:'order-1',order_number:'O-900'}),
    internal_deal_mark_lost:async()=>({id:'deal-1',sales_outcome:'lost'}),
    internal_deal_reopen:async()=>({id:'deal-1',sales_outcome:'open'}),
    ...(overrides.handlers||{})
  };
  const nav=[];
  const win={};
  const document={getElementById(id){return id==='dealTable'?table:fields.get(id)||null;}};
  if(source)runInNewContext(source,{window:win,document,console});
  const api=win.QuoteFlowDeals||{};
  if(typeof api.configure==='function')api.configure({
    rpc:async(name,args,opts)=>{calls.push({name,args,opts});return handlers[name]?.(args,opts);},
    getHost:()=>host,getRole:()=>overrides.role||'internal_staff',
    openModal:o=>{options=o;return {};},closeModal:()=>{},toast:()=>{},
    navigate:async page=>nav.push(page),editQuote:async()=>{},
    listQuotes:async()=>overrides.listQuotes||[]
  });
  return {api,host,table,calls,fields,nav,quote,detail,rows,get modal(){return options;}};
}

test('routes include separate internal-only deal management and relative assets',()=>{
  assert.match(html,/\['deals','案件進行管理'\]/);
  assert.match(html,/if\(page==='deals'\)/);
  assert.match(html,/<script src="\.\/assets\/deal-workflow\.js"><\/script>/);
  assert.match(html,/href="\.\/assets\/deal-workflow\.css"/);
  assert.match(css,/\.dealStage/);
});
test('openList loads deal records and shows customer branch, current stage, and next step',async()=>{
  const f=fixture();assert.equal(typeof f.api.openList,'function');
  await f.api.openList();
  assert.ok(f.calls.some(x=>x.name==='internal_deals_list'&&x.opts?.readOnly===true));
  assert.match(f.host.innerHTML,/案件進行管理/);
  assert.match(f.table.innerHTML,/営業先株式会社/);
  assert.match(f.table.innerHTML,/本店/);
  assert.match(f.table.innerHTML,/商談/);
  assert.match(f.host.innerHTML,/顧客情報確認から見積作成/);
  assert.match(f.host.innerHTML,/既存見積から案件を作成/);
  assert.match(source,/picker\.onclick=\(\)=>openQuotePicker\(\)/);
  assert.doesNotMatch(f.host.innerHTML,/社内承認待ち|管理者承認申請/);
});
test('support company cannot use internal sales deal workflow',async()=>{
  const f=fixture({role:'support_staff'});
  await assert.rejects(()=>f.api.openList(),/権限|社内/);
  assert.equal(f.calls.length,0);
});
test('openDetail displays end-to-end stages and quote operations without approval button',async()=>{
  const f=fixture();
  await f.api.openDetail('deal-1');
  assert.deepEqual(f.calls.map(x=>x.name),['internal_deal_detail']);
  for(const phase of ['見積','受注','支払・リース','発注・入荷','工事日','施工','機器・保守','サポート'])
    assert.ok(f.host.innerHTML.includes(phase),phase);
  assert.match(f.host.innerHTML,/見積発行済み/);
  assert.match(f.host.innerHTML,/受注登録/);
  assert.match(f.host.innerHTML,/失注登録/);
  assert.match(f.host.innerHTML,/見積を編集・確認/);
  assert.doesNotMatch(f.host.innerHTML,/管理者承認|承認待ち/);
});
test('loss dialog requires date, reason and conditional details, then calls only loss RPC',async()=>{
  const f=fixture();await f.api.openDetail('deal-1');
  f.api.openLossDialog('deal-1','quote-1');
  assert.match(f.modal.body,/id="dealLostDate"[^>]*required/);
  assert.match(f.modal.body,/id="dealLostReason"[^>]*required/);
  assert.match(f.modal.body,/id="dealLostDetail"/);
  assert.match(f.modal.body,/id="dealLostReproposal"/);
  for(const [key,value] of Object.entries({
    dealLostDate:'2026-10-16',dealLostReason:'other',dealLostDetail:'',dealLostCompetitor:'競合A',dealLostReproposal:'2027-01-10'})){
    f.fields.set(key,{value});
  }
  await assert.rejects(f.modal.onSubmit(),/詳細|理由/);
  f.fields.get('dealLostDetail').value='顧客都合で保留';
  await f.modal.onSubmit();
  const loss=f.calls.find(x=>x.name==='internal_deal_mark_lost');
  assert.equal(loss.args.p_deal_id,'deal-1');
  assert.equal(loss.args.p_quote_id,'quote-1');
  assert.equal(loss.args.p_reason_category,'other');
  assert.equal(loss.args.p_lost_date,'2026-10-16');
  assert.equal(loss.args.p_reproposal_on,'2027-01-10');
  assert.ok(!f.calls.some(x=>x.name==='approve_quote'));
});
test('issue and order actions call dedicated approval-free RPCs',async()=>{
  const f=fixture();await f.api.openDetail('deal-1');
  f.api.openIssueDialog('deal-1','quote-1');
  assert.match(f.modal.title,/見積発行/);
  await f.modal.onSubmit();
  f.api.openOrderDialog('deal-1','quote-1');
  assert.match(f.modal.title,/受注登録/);
  await f.modal.onSubmit();
  assert.ok(f.calls.some(x=>x.name==='deal_issue_quote'&&x.args.p_quote_id==='quote-1'));
  assert.ok(f.calls.some(x=>x.name==='deal_create_order_from_quote'&&x.args.p_deal_id==='deal-1'));
  assert.ok(!f.calls.some(x=>x.name==='approve_quote'));
});
test('existing quotes can open a deal without retyping customer, excludes linked quote',async()=>{
  const f=fixture({listQuotes:[
    {id:'unlinked',quote_number:'Q-2002',project_name:'新規提案',deal_id:null,status:'draft'},
    {id:'linked',quote_number:'Q-2003',deal_id:'deal-2',status:'finalized'}
  ]});
  assert.equal(typeof f.api.openQuotePicker,'function');
  await f.api.openQuotePicker();
  assert.match(f.modal.body,/Q-2002/);
  assert.doesNotMatch(f.modal.body,/Q-2003/);
  assert.equal(typeof f.api.openFromQuote,'function');
  await f.api.openFromQuote('unlinked');
  assert.ok(f.calls.some(x=>x.name==='internal_deal_open_from_quote'&&x.args.p_quote_id==='unlinked'));
});
test('lost case shows reopening, never presents an order action',async()=>{
  const f=fixture({handlers:{internal_deal_detail:async()=>({
    deal:{id:'deal-1',title:'終了案件',sales_outcome:'lost',current_stage:'lost'},customer:{name:'テスト商事'},
    quotes:[{id:'quote-1',status:'accepted',quote_number:'Q1'}],orders:[],events:[],loss_events:[]
  })}});
  await f.api.openDetail('deal-1');
  assert.match(f.host.innerHTML,/失注/);
  assert.match(f.host.innerHTML,/再開/);
  assert.doesNotMatch(f.host.innerHTML,/data-deal-action="order"/);
});

test('quote-to-deal linking accepts returned deal ID and protects against missing IDs',async()=>{
 const f=fixture();
 f.api.configure({
  rpc:async(name,args)=>{f.calls.push({name,args});return name==='internal_deal_open_from_quote'?{id:'deal-1',already_exists:true}:null;},
  getRole:()=> 'internal_staff',getHost:()=>f.host,navigate:()=>{},editQuote:()=>{}
 });
 const linked=await f.api.linkQuote('quote-1');
 assert.equal(linked.id,'deal-1');
 assert.equal(linked.already_exists,true);
 assert.equal(f.calls.at(-1).args.p_quote_id,'quote-1');
 await assert.rejects(()=>f.api.linkQuote(''),/見積/);
});
test('sales UI retains an explicit route from existing quotes into the deal flow',()=>{
 assert.match(html,/createdQuote=await rpc\('create_quote_full'/);
 assert.match(html,/QuoteFlowDeals\.linkQuote\(createdQuote\.id\)/);
 assert.match(html,/QuoteFlowDeals\.linkQuote\(q\.id\)/);
 assert.match(html,/id="quoteFlowLinkNotice"/);
 assert.match(html,/見積は保存済みですが、案件への紐づけを確認できません/);
 assert.match(source,/data-deal-quote/);
 assert.match(source,/config\.editQuote\(btn\.dataset\.dealQuote\)/);
});

test('quote editor uses direct issuance and preserves legacy approval history as read-only',()=>{
 const html=readFileSync('index.html','utf8');
 const editor=html.slice(html.indexOf('async function renderQuoteEditor('),html.indexOf('async function renderQuotes('));
 assert.match(editor,/最新内容を保存して見積発行/);
 assert.match(editor,/rpc\('deal_issue_quote',\{p_deal_id:linked.id,p_quote_id:q.id\}\)/);
 assert.match(editor,/QuoteFlowDeals\.linkQuote\(q.id\)/);
 assert.doesNotMatch(editor,/rpc\('finalize_quote'/);
 assert.doesNotMatch(editor,/rpc\('approve_quote'/);
 assert.doesNotMatch(editor,/rpc\('return_quote_for_revision'/);
 assert.doesNotMatch(editor,/管理者承認待ち|見積を承認|承認申請/);
 assert.match(editor,/過去の承諾記録/);
 assert.match(editor,/quoteDealOpenBtn/);
 assert.match(html,/editQuote:async id=>\{if\(!await goForDeal\('sales'\)\)return;const cmap=await customerMap\(\);await renderQuoteEditor\(id,cmap\);\}/);
});

test('order success refreshes actual deal and launches finance setup only for won records without terms',async()=>{
 const f=fixture({handlers:{
  internal_deal_detail:async()=>f.detail,
  deal_create_order_from_quote:async()=>{f.detail.deal.sales_outcome='won';f.detail.orders=[{id:'order-1',quote_id:'quote-1',order_number:'O-900'}];return {id:'order-1',order_number:'O-900'};}
 }});
 await f.api.openDetail('deal-1');
 f.api.openOrderDialog('deal-1','quote-1');
 assert.match(f.modal.body,/Q-1001/);
 await f.modal.onSubmit();
 assert.equal(f.modal.title,'支払・リースを登録・編集');
 assert.match(f.modal.body,/dealFinanceMethod/);
});
test('financing method labels and loss reasons remain readable in deal detail',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',sales_outcome:'won',title:'設備更新'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1'}],financing:{method:'bank_transfer',payment_state:'invoiced',credit_status:'not_required'},
  events:[],loss_events:[{event_type:'lost',reason_category:'price',detail:'価格見直し後に受注'}],
  purchase_orders:[],deliveries:[],assets:[],contracts:[],support_tickets:[]
 })}});
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/銀行振込/);
 assert.match(f.host.innerHTML,/請求済み/);
 assert.match(f.host.innerHTML,/失注理由：価格/);
 assert.doesNotMatch(f.host.innerHTML,/与信：/);
});

test('won case shows actionable purchasing route and independent installation scheduling',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',sales_outcome:'won'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1',order_number:'O-1'}],financing:{method:'bank_transfer',payment_state:'not_started'},
  purchase_orders:[],deliveries:[],assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]
 })}});
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/受注から発注を作成/);
 assert.match(f.host.innerHTML,/工事日を調整（発注と並行可）/);
 assert.doesNotMatch(f.host.innerHTML,/data-deal-action="receiving"/);
});
test('existing purchase orders offer receiving without creating duplicate orders',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',sales_outcome:'won'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1',order_number:'O-1'}],financing:{method:'bank_transfer'},
  purchase_orders:[{id:'po-1',purchase_order_number:'PO-1'}],deliveries:[],assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]
 })}});
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/入荷・シリアルを確認/);
 let got=null;
 f.api.configure({getRole:()=> 'internal_staff',getHost:()=>f.host,
  openReceivingForDeal:async x=>{got=x;}});
 await f.api.openReceivingForDeal('deal-1');
 assert.equal(got.purchaseOrders[0].id,'po-1');
});

test('receiving uses exact PO ID scoping and never guesses by customer name',()=>{
 const js=readFileSync('assets/deal-progress.js','utf8');
 const w={};runInNewContext(js,{window:w,console});
 const rows=[{item_id:'a',purchase_order_id:'po-1',customer_name:'同一顧客'},{item_id:'b',purchase_order_id:'po-2',customer_name:'同一顧客'}];
 const scoped=w.QuoteFlowDealProgress.scopeReceiving(rows,['po-1']);
 assert.deepEqual(scoped.map(x=>x.item_id),['a']);
 assert.throws(()=>w.QuoteFlowDealProgress.scopeReceiving(rows,[]),/対象発注/);
 assert.match(html,/renderProcurementWorkspace\('receiving',receivingScope\)/);
 assert.match(html,/purchaseOrderIds:purchaseOrders\.map\(po=>po\.id\)/);
});
test('deal detail displays purchasing and delivery completion links',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',title:'設置工事',sales_outcome:'won'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1'}],financing:{method:'bank_transfer'},
  purchase_orders:[{id:'po-1',purchase_order_number:'PO-1',supplier_name:'仕入先A'}],
  receiving_items:[{quantity:2,received_quantity:1}],deliveries:[{id:'dv-1',delivery_number:'D-1',status:'planned'}],
  installation_jobs:[],assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]
 })}});
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/PO-1/);
 assert.match(f.host.innerHTML,/未入荷 1件/);
 assert.match(f.host.innerHTML,/D-1/);
 assert.match(f.host.innerHTML,/納品詳細・完了確認/);
});

test('completed and accepted installation reveals linked equipment maintenance and support actions',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',sales_outcome:'won'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1'}],financing:{method:'bank_transfer'},
  purchase_orders:[],receiving_items:[],deliveries:[],
  installation_jobs:[{id:'job-1',state:'completed',acceptance_state:'accepted',site_address:'本店'}],
  assets:[{id:'asset-1',asset_number:'A-1',model_name:'複合機'}],
  contracts:[{id:'contract-1',contract_number:'C-1',status:'active'}],
  support_tickets:[{id:'ticket-1',ticket_number:'S-1'}],events:[],loss_events:[]
 })}});
 await f.api.openDetail('deal-1');
 for(const text of ['施工完了','検収済み','A-1','C-1','S-1','機器台帳を確認','契約・保守を確認','サポートへ進む'])
  assert.match(f.host.innerHTML,new RegExp(text));
 assert.match(f.host.innerHTML,/data-deal-record="asset" data-record-id="asset-1"/);
 assert.match(f.host.innerHTML,/data-deal-record="contract" data-record-id="contract-1"/);
 assert.match(f.host.innerHTML,/data-deal-record="ticket" data-record-id="ticket-1"/);
});
test('incomplete installation must not offer automatic aftercare handoff',async()=>{
 const f=fixture({handlers:{internal_deal_detail:async()=>({
  deal:{id:'deal-1',sales_outcome:'won'},customer:{name:'営業先株式会社'},
  quotes:[],orders:[{id:'order-1'}],financing:{method:'bank_transfer'},
  purchase_orders:[],deliveries:[],installation_jobs:[{id:'job-1',state:'completed',acceptance_state:'rejected'}],
  assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]
 })}});
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/検収不合格/);
 assert.doesNotMatch(f.host.innerHTML,/data-deal-action="support"/);
 assert.doesNotMatch(f.host.innerHTML,/data-deal-action="contracts"/);
});

test('linked order, purchase order and delivery navigation mounts the matching detail host',()=>{
 const html=readFileSync('index.html','utf8');
 assert.match(html,/openOrderProcurement:async\(\{orderId\}\)=>\{[\s\S]*?if\(!await goForDeal\('sales'\)\)return;[\s\S]*?await renderOrders\(\);[\s\S]*?await renderOrderDetail\(orderId\)/);
 assert.match(html,/if\(kind==='order'\)\{if\(!await goForDeal\('sales'\)\)return;await renderOrders\(\);await renderOrderDetail\(id\)/);
 assert.match(html,/if\(kind==='purchase'\)\{if\(!await goForDeal\('procurement'\)\)return;await renderPurchaseOrders\(\);await renderPurchaseOrderDetail\(id\)/);
 assert.match(html,/if\(kind==='delivery'\)\{if\(!await goForDeal\('procurement'\)\)return;await renderDeliveries\(\);await renderDeliveryDetail\(id\)/);
 assert.match(html,/async function renderOrders\(\)[\s\S]*?id="orderDetailHost"/);
 assert.match(html,/async function renderPurchaseOrders\(\)[\s\S]*?id="purchaseOrderDetailHost"/);
 assert.match(html,/async function renderDeliveries\(\)[\s\S]*?id="deliveryDetailHost"/);
});
test('receiving navigation preserves selected deal ID rather than a placeholder',()=>{
 const html=readFileSync('index.html','utf8');
 assert.match(html,/openReceivingForDeal:async\(\{dealId,purchaseOrders\}\)=>/);
 assert.match(html,/renderProcurementWorkspace\('receiving',\{dealId,purchaseOrderIds:purchaseOrders\.map\(po=>po\.id\)\}\)/);
 assert.doesNotMatch(html,/purchaseOrders\[0\]\.deal_id\|\|'選択案件'/);
});

test('linked aftercare records open a detail page with a mounted host',()=>{
 const html=readFileSync('index.html','utf8');
 const linked=html.slice(html.indexOf('openLinked:async(kind,id)=>'),html.indexOf('listQuotes:async()=>',html.indexOf('openLinked:async(kind,id)=>')));
 for(const [kind,page,detail] of [
  ['asset','assets','renderAssetDetail'],['contract','contracts','renderContractDetail'],['ticket','support','renderTicketDetail']
 ]){
  assert.ok(linked.includes("if(kind==='"+kind+"'){if(!await goForDeal('"+page+"'))return;await "+detail+"(id)"),kind);
 }
 for(const [page,host] of [
  ['renderAssets','assetDetailHost'],['renderContractsWorkspace','contractDetailHost'],['renderSupport','ticketDetailHost']
 ]){
  const start=html.indexOf('async function '+page+'(');
  const end=html.indexOf('\n  async function ',start+10);
  const block=html.slice(start,end<0?undefined:end);
  assert.ok(block.includes('id="'+host+'"'),page+' missing host '+host);
 }
});

test('aftercare handoff is blocked when any installation is unaccepted',async()=>{
 const detail={deal:{id:'deal-1',sales_outcome:'won'},customer:{name:'顧客'},
 quotes:[],orders:[{id:'order-1'}],financing:{method:'bank_transfer'},
 purchase_orders:[],receiving_items:[],deliveries:[],
 installation_jobs:[{id:'job-1',state:'completed',acceptance_state:'accepted'},
 {id:'job-2',state:'completed',acceptance_state:'rejected'}],
 assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]};
 const f=fixture({handlers:{internal_deal_detail:async()=>detail}});
 await f.api.openDetail('deal-1');
 assert.doesNotMatch(f.host.innerHTML,/data-deal-action="support"/);
 assert.doesNotMatch(f.host.innerHTML,/data-deal-action="contracts"/);
 detail.installation_jobs[1].acceptance_state='accepted';
 await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/data-deal-action="support"/);
});
test('aftercare handoff rejects a cancelled or lost deal even if one job is accepted',async()=>{
 for(const outcome of ['lost','cancelled_after_order']){
  const f=fixture({handlers:{internal_deal_detail:async()=>({
   deal:{id:'deal-1',sales_outcome:outcome},customer:{name:'顧客'},
   quotes:[],orders:[{id:'o-1'}],financing:{method:'bank_transfer'},
   purchase_orders:[],deliveries:[],installation_jobs:[{id:'j-1',state:'completed',acceptance_state:'accepted'}],
   assets:[],contracts:[],support_tickets:[],events:[],loss_events:[]
  })}});
  await f.api.openDetail('deal-1');
  assert.doesNotMatch(f.host.innerHTML,/data-deal-action="support"/);
 }
});

test('progress stage never skips cancelled or unverified installations',()=>{
 const win={};
 runInNewContext(readFileSync('assets/deal-progress.js','utf8'),{window:win,console});
 const derive=win.QuoteFlowDealProgress.derive;
 const base={deal:{sales_outcome:'won'},quotes:[],orders:[{id:'o'}],
  financing:{method:'bank_transfer'},purchase_orders:[],receiving_items:[],
  deliveries:[],assets:[{id:'a'}],contracts:[{id:'c'}]};
 const evaluate=jobs=>derive({...base,installation_jobs:jobs});
 assert.equal(evaluate([{state:'completed',acceptance_state:'accepted'},{state:'cancelled',acceptance_state:'pending'}]).target,'installation');
 assert.equal(evaluate([{state:'completed',acceptance_state:'accepted'},{state:'completed',acceptance_state:null}]).stage,'検収');
 assert.equal(evaluate([{state:'completed',acceptance_state:'accepted'},{state:'completed',acceptance_state:'rejected'}]).stage,'検収');
 assert.equal(evaluate([{state:'completed',acceptance_state:'accepted'}]).target,'support');
});

test('navigation guard protects unsent edits before any deal-linked detail replaces the screen',()=>{
 const html=readFileSync('index.html','utf8');
 assert.match(html,/const goForDeal=async page=>\{[\s\S]*?result!==false&&currentPage===page/);
 assert.match(html,/if\(activeTicketId && window\.QuoteFlowTicketTabs\?\.confirmLeave\(activeTicketId\)===false\) return false/);
 for(const kind of ['purchase','delivery','asset','contract','ticket','order'])
  assert.ok(html.includes("if(kind==='"+kind+"'){if(!await goForDeal("),kind);
 assert.match(html,/openReceivingForDeal:async\(\{dealId,purchaseOrders\}\)=>\{[\s\S]*?if\(!await goForDeal\('procurement'\)\)return/);
});
