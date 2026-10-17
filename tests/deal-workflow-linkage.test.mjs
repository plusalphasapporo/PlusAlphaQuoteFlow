import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function read(path){try{return readFileSync(path,'utf8')}catch{return ''}}
const sql=read('sql/deal_workflow_linked_records.sql');
const progressSource=read('assets/deal-progress.js');
const workflowSource=read('assets/deal-workflow.js');
const index=read('index.html');
function policy(){
 const window={};
 if(progressSource)runInNewContext(progressSource,{window});
 return window.QuoteFlowDealProgress;
}
function deal(data={}){
 return {deal:{id:'deal-1',customer_id:'cust-1',sales_outcome:'won',current_stage:'order'},
   quotes:[{id:'quote-1',status:'finalized'}],
   orders:[{id:'order-1',quote_id:'quote-1',order_number:'O100'}],
   financing:{method:'bank_transfer',payment_state:'invoiced'},
   purchase_orders:[],receiving_items:[],deliveries:[],installation_jobs:[],assets:[],contracts:[],support_tickets:[],...data};
}
test('linked records come from only explicit deal FK or a customer-matching chain of existing FKs',()=>{
 assert.match(sql,/create or replace function app_private\.internal_deal_detail_impl/i);
 for(const scope of ['scope_quotes','scope_orders','scope_pos','scope_deliveries','scope_receiving','scope_assets','scope_contracts','scope_tickets'])
   assert.match(sql,new RegExp(scope+'\\s+AS\\s*\\(','i'));
 for(const f of ['o.quote_id','po.order_id','dv.order_id','i.purchase_order_id','a.source_delivery_id',
   'a.source_purchase_serial_id','a.contract_id','t.asset_id','t.contract_id']){
   assert.ok(sql.includes(f),f);
 }
 for(const table of ['orders','purchase_orders','deliveries','assets','contracts','support_tickets'])
   assert.match(sql,new RegExp('from public\\.'+table+'\\s+\\w+','i'));
 assert.match(sql,/customer_id\s*=\s*d\.customer_id/i);
 assert.match(sql,/deal_id is null/i);
 assert.match(sql,/app_private\.is_internal/i);
 assert.match(sql,/auth\.jwt\(\)->>'aal'/i);
 assert.doesNotMatch(sql,/\b(?:update|delete from|truncate|drop table)\s+public\.(?:assets|contracts|orders|quotes|purchase_orders|support_tickets)/i);
});
test('detail response contains procurement/receipts/delivery/asset/contract/ticket records and relationship evidence',()=>{
 for(const name of ['purchase_orders','receiving_items','deliveries','assets','contracts','support_tickets'])
   assert.match(sql,new RegExp("'"+name+"'\\s*,","i"));
 assert.match(sql,/link_source/i);
 assert.match(sql,/confirmed_fk/i);
 assert.match(sql,/scope_deal/i);
});
test('progress logic distinguishes old approval from actual order and preserves quote-loss',()=>{
 const p=policy();assert.equal(typeof p?.derive,'function');
 const notOrdered=deal({deal:{sales_outcome:'open',current_stage:'quote'},orders:[],quotes:[{status:'accepted',id:'old1'}],financing:null});
 assert.equal(p.derive(notOrdered).stage,'見積');
 assert.match(p.derive(notOrdered).nextAction,/受注|失注/);
 const lost=deal({deal:{sales_outcome:'lost',current_stage:'lost'},orders:[],financing:null});
 assert.equal(p.derive(lost).stage,'失注');
 assert.match(p.derive(lost).nextAction,/再開/);
 assert.doesNotMatch(p.derive(lost).nextAction,/受注登録/);
 const wrong=deal({deal:{sales_outcome:'won',current_stage:'order'},orders:[],financing:null});
 assert.match(p.derive(wrong).nextAction,/受注.*確認|データ.*確認/);
});
test('progress starts with payment method, pauses when lease credit denied, and does not require it for bank transfer',()=>{
 const p=policy();
 assert.match(p.derive(deal({financing:null})).nextAction,/支払.*登録/);
 const lease=deal({financing:{method:'lease',credit_status:'denied',payment_state:'not_started'}});
 assert.match(p.derive(lease).nextAction,/否決|再検討/);
 assert.notEqual(p.derive(lease).stage,'施工');
 const bank=deal({financing:{method:'bank_transfer',credit_status:'not_required',payment_state:'invoiced'}});
 assert.match(p.derive(bank).nextAction,/仕入|発注|工事/);
});
test('progress checks receiving quantities rather than treating purchase order presence as arrival',()=>{
 const p=policy();
 const d=deal({purchase_orders:[{id:'po-1',purchase_order_number:'PO77',status:'ordered'}],
  receiving_items:[{purchase_order_id:'po-1',quantity:3,received_quantity:1}]});
 assert.match(p.derive(d).nextAction,/入荷|未入荷/);
 const arrived=deal({purchase_orders:[{id:'po-1'}],receiving_items:[{purchase_order_id:'po-1',quantity:3,received_quantity:3}]});
 assert.match(p.derive(arrived).nextAction,/納品|工事/);
});
test('progress handles postponed work and acceptance separate from delivery completion',()=>{
 const p=policy();
 let d=deal({deliveries:[{id:'del-1',status:'delivered'}],
  installation_jobs:[{id:'job-1',state:'postponed',acceptance_state:'pending'}]});
 assert.match(p.derive(d).nextAction,/再調整|延期/);
 d=deal({deliveries:[{id:'del-1',status:'delivered',completion_confirmed:true}],
  installation_jobs:[{id:'job-1',state:'completed',acceptance_state:'pending'}]});
 assert.equal(p.derive(d).stage,'検収');
 assert.match(p.derive(d).nextAction,/検収/);
 assert.doesNotMatch(p.derive(d).nextAction,/完了済み/);
});
test('progress does not require support ticket existence to close project',()=>{
 const p=policy(),d=deal({deliveries:[{id:'del-1',status:'delivered'}],
 installation_jobs:[{id:'job-1',state:'completed',acceptance_state:'accepted'}],
 assets:[{id:'asset-1',asset_number:'A001'}],
 contracts:[{id:'contract-1',contract_number:'C001',status:'active'}]});
 assert.equal(p.derive(d).stage,'機器・保守');
 assert.match(p.derive(d).nextAction,/サポート|運用|引継ぎ/);
 assert.ok(p.derive(d).steps.length>=8);
});
test('deal UI routes linked records by exact ID and shows derived links, never just customer matches',async()=>{
 const win={};const host={innerHTML:'',querySelectorAll(sel){if(sel==='[data-deal-record]')return [link];return []}};
 const calls=[];
 const link={dataset:{dealRecord:'purchase',recordId:'po-1'},onclick:null};
 runInNewContext(workflowSource,{window:win,document:{getElementById(){return null}},console});
 const api=win.QuoteFlowDeals;
 const payload=deal({
  purchase_orders:[{id:'po-1',purchase_order_number:'PO-001',link_source:'confirmed_fk'}],
  deliveries:[{id:'dv-1',delivery_number:'D-001',status:'planned',link_source:'confirmed_fk'}],
  assets:[{id:'a-1',asset_number:'A-001',link_source:'confirmed_fk'}],
  contracts:[{id:'ct-1',contract_number:'CT-001',link_source:'confirmed_fk'}],
  support_tickets:[{id:'ticket-1',ticket_number:'T-001',subject:'交換依頼',link_source:'confirmed_fk'}],
  receiving_items:[{id:'i-1',purchase_order_id:'po-1',quantity:2,received_quantity:1}]
 });
 api.configure({rpc:async()=>payload,getHost:()=>host,getRole:()=> 'internal_staff',
   openLinked:async(kind,id)=>calls.push([kind,id]),navigate:()=>{},
   openModal(){},closeModal(){}});
 await api.openDetail('deal-1');
 for(const id of ['PO-001','D-001','A-001','CT-001','T-001'])assert.ok(host.innerHTML.includes(id),id);
 assert.match(host.innerHTML,/関連元|関連付け|既存データ/);
 assert.match(host.innerHTML,/data-deal-record="purchase"/);
 assert.match(host.innerHTML,/data-record-id="po-1"/);
 assert.equal(typeof link.onclick,'function');
 await link.onclick();
 assert.deepEqual(calls,[['purchase','po-1']]);
});
test('actual production navigation adapter opens corresponding record detail after category view',()=>{
 for(const fn of ['renderOrderDetail','renderPurchaseOrderDetail','renderDeliveryDetail',
   'renderAssetDetail','renderContractDetail','renderTicketDetail']){
  assert.ok(index.includes('await '+fn+'(id)'),fn);
 }
 assert.match(index,/openLinked:\s*async\s*\(/);
 assert.match(index,/\.\/assets\/deal-progress\.js/);
});

test('missing purchase order line items prevent false installation progress',()=>{
 const p=policy();
 const base=deal({
  purchase_orders:[{id:'po-1',purchase_order_number:'PO-1'},{id:'po-2',purchase_order_number:'PO-2'}],
  receiving_items:[{id:'line-1',purchase_order_id:'po-1',quantity:2,received_quantity:2}],
  deliveries:[{id:'dv-1',status:'delivered'}]
 });
 const gap=p.derive(base);
 assert.equal(gap.stage,'発注・入荷');
 assert.equal(gap.target,'procurement');
 assert.match(gap.nextAction,/発注.*明細/);
 const done=p.derive({...base,receiving_items:[
  ...base.receiving_items,
  {id:'line-2',purchase_order_id:'po-2',quantity:1,received_quantity:1}
 ]});
 assert.equal(done.stage,'工事日','all orders fully received and delivery completed should reach installation scheduling');
 assert.equal(done.target,'installation');
 const empty=p.derive({...base,receiving_items:[]});
 assert.equal(empty.stage,'発注・入荷');
 assert.equal(empty.target,'procurement');
});
