import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('index.html','utf8');
const helperPath='assets/workspace-fixes.js';

function fixture(){
  assert.ok(existsSync(helperPath),'missing shared modal and quote-revision behavior');
  const source=readFileSync(helperPath,'utf8');
  let htmlRendered='', removed=0, submitted=0, bodyOpened=false, valid=true;
  const mk=()=>({onclick:null,disabled:false,isConnected:true,focus(){this.focused=true;},classList:{add(){},remove(){}},textContent:''});
  const nodes=new Map();
  const layer=mk();
  layer.remove=()=>{removed++;nodes.delete('appModalLayer');bodyOpened=false;};
  nodes.set('appModalLayer',null);
  const document={
    body:{
      insertAdjacentHTML(_where,html){
        htmlRendered=html;
        for(const name of ['appModalLayer','standardModalForm','standardModalClose','standardModalCancel','standardModalSubmit','standardModalError']) nodes.set(name,mk());
        nodes.get('appModalLayer').remove=layer.remove;
        nodes.get('standardModalForm').reportValidity=()=>valid;
        nodes.get('standardModalForm').querySelector=()=>mk();
        nodes.get('appModalLayer').addEventListener=()=>{};
        bodyOpened=true;
      },
      classList:{add(){bodyOpened=true;},remove(){bodyOpened=false;}}
    },
    getElementById(id){return nodes.get(id)||null;},
    addEventListener(){},
    removeEventListener(){}
  };
  const window={};
  runInNewContext(source,{window,document,console});
  return {
    window,document,
    get html(){return htmlRendered;},
    get removed(){return removed;},
    get bodyOpened(){return bodyOpened;},
    get submitted(){return submitted;},
    set valid(x){valid=x;},
    node(id){return nodes.get(id);},
    async submit(){
      const event={preventDefault(){submitted++;}};
      await nodes.get('standardModalForm').onsubmit(event);
    }
  };
}

test('three creation buttons and product editor share a modal that can open and close',()=>{
  assert.match(html,/<script src="\.\/assets\/workspace-fixes\.js"><\/script>/);
  for (const id of ['assetLedgerCreateBtn','contractWorkspaceCreate','knowledgeAdminNew']){
    assert.match(html,new RegExp('\\$\\(\\\'#'+id+'\\\'\\)\\.onclick'));
  }
  const f=fixture();
  assert.equal(typeof f.window.openModal,'function');
  assert.equal(typeof f.window.closeModal,'function');
  f.window.openModal({title:'機器を登録',body:'<input required>',confirmLabel:'登録',onSubmit:async()=>{}});
  assert.match(f.html,/機器を登録/);
  assert.match(f.html,/required/);
  assert.ok(f.bodyOpened);
  f.node('standardModalCancel').onclick();
  assert.equal(f.removed,1);
  assert.equal(f.bodyOpened,false);
});

test('shared modal submits once and holds submit button until async operation finishes',async()=>{
  const f=fixture();
  let resolve;
  const pending=new Promise(r=>resolve=r);
  let calls=0;
  f.window.openModal({title:'契約登録',body:'<input required>',onSubmit:async()=>{calls++; await pending;}});
  const submit=f.node('standardModalSubmit');
  const promise=f.submit();
  assert.equal(calls,1);
  assert.equal(submit.disabled,true);
  const second=f.submit();
  resolve();
  await Promise.all([promise,second]);
  assert.equal(calls,1);
  assert.equal(submit.disabled,false);
});

test('shared modal blocks invalid form and exposes a failed save without closing',async()=>{
  const f=fixture();
  let called=0;
  f.window.openModal({title:'ナレッジ登録',body:'<input required>',onSubmit:async()=>{called++;throw new Error('登録できません');}});
  f.valid=false;
  await f.submit();
  assert.equal(called,0);
  f.valid=true;
  await f.submit();
  assert.equal(called,1);
  assert.equal(f.bodyOpened,true);
  assert.match(f.node('standardModalError').textContent,/登録できません/);
  assert.equal(f.node('standardModalSubmit').disabled,false);
});

test('accepted and finalized quotes offer an immutable-original revision route',()=>{
  assert.match(html,/quoteDuplicateDraftBtn/);
  assert.match(html,/QuoteFlowQuoteRevision\.buildPayload/);
  assert.match(html,/rpc\('create_quote_full',revisionPayload\)/);
  assert.match(html,/const editable=q\.status==='draft'/);
});

test('revision copies items and residuals into a new draft and retains provenance',()=>{
  const f=fixture();
  const build=f.window.QuoteFlowQuoteRevision?.buildPayload;
  assert.equal(typeof build,'function');
  const quote={
    id:'original-id',customer_id:'customer-id',quote_number:'Q-0001',status:'accepted',
    quote_date:'2026-10-01',valid_until:'2026-10-13',
    project_name:'更新案件',honorific:'御中',contact_name:'担当者',
    lease_months:60,tax_rate:10,internal_note:'既存メモ'
  };
  const items=[{id:'item-id',quote_id:'original-id',product_id:'product-id',description:'複合機',
    unit:'台',quantity:2,unit_price:20000,cost_price:10000,
    manufacturer:'メーカー',supplier_name:'仕入先',procurement_target:true,expected_delivery_date:null}];
  const residuals=[{id:'residual-id',quote_id:'original-id',old_property_name:'旧機器',
    lessor_name:'リース',contract_number:'L-1',remaining_count:2,monthly_amount_tax_included:1000,
    residual_amount_tax_included:2000,settlement_amount_tax_included:300,reflection_amount:2300,
    payment_count:2,first_payment_amount:100,recurring_payment_amount:100,note:'旧'}];
  const payload=build(quote,items,residuals,'2026-10-16');
  assert.equal(payload.p_customer_id,'customer-id');
  assert.equal(payload.p_quote_date,'2026-10-16');
  assert.equal(payload.p_valid_until,null);
  assert.equal(payload.p_items.length,1);
  assert.equal(payload.p_items[0].description,'複合機');
  assert.equal(payload.p_items[0].quantity,2);
  assert.equal(payload.p_items[0].cost_price,10000);
  assert.equal(payload.p_residual_items[0].old_property_name,'旧機器');
  assert.match(payload.p_internal_note,/元見積: Q-0001/);
  assert.ok(!('p_quote_id' in payload));
  assert.ok(!('p_quote_number' in payload));
  assert.equal(quote.status,'accepted');
});

test('revision rejects empty quote items before an RPC could create bad data',()=>{
  const f=fixture();
  const build=f.window.QuoteFlowQuoteRevision?.buildPayload;
  assert.equal(typeof build,'function');
  assert.throws(()=>build({status:'accepted',customer_id:'customer-id'},[],[],'2026-10-16'),/明細/);
});
