import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
let sql='';
try{sql=readFileSync('sql/deal_financing.sql','utf8')}catch{}
const js=readFileSync('assets/deal-workflow.js','utf8');
const functionBody=(name)=>sql.match(new RegExp('create or replace function app_private\\.'+name+'\\([\\s\\S]*?\\$fn\\$;','i'))?.[0]||'';
function fixture(method='lease'){
  const fields=new Map(),calls=[];
  let modal=null;
  const quote={id:'quote-1',quote_number:'Q001',status:'finalized'};
  const detail={deal:{id:'deal-1',sales_outcome:'won',current_stage:'order'},customer:{name:'さくら商事'},
    quotes:[quote],orders:[{id:'order-1',order_number:'O100'}],purchase_orders:[],deliveries:[],assets:[],contracts:[],support_tickets:[],loss_events:[],events:[],
    financing:method==='lease'?{method:'lease',lease_company:'ABCリース',credit_status:'pending',lease_months:60,monthly_amount:14500,payment_state:'not_started'}:null,installation_jobs:[]};
  const host={innerHTML:'',querySelectorAll(){return []}};
  const doc={getElementById(id){return fields.get(id)||null}};
  const win={};runInNewContext(js,{window:win,document:doc,console,Date,Intl});
  const api=win.QuoteFlowDeals;
  api.configure({rpc:async(name,args)=>{calls.push({name,args});if(name==='internal_deal_detail')return detail;if(name==='internal_deal_set_financing')return {saved:true};},
    getRole:()=> 'internal_staff',getHost:()=>host,openModal:o=>{modal=o},closeModal:()=>{},navigate:async()=>{}});
  return {api,fields,calls,detail,host,get modal(){return modal}};
}
test('finance table is one record per deal, RLS protected and read by detail',()=>{
 assert.match(sql,/create table if not exists public\.deal_financing/i);
 assert.match(sql,/deal_id uuid primary key references public\.deals\(id\)/i);
 assert.match(sql,/alter table public\.deal_financing enable row level security/i);
 assert.match(sql,/grant select on public\.deal_financing to authenticated/i);
 assert.match(sql,/auth\.jwt\(\)->>'aal'/i);
 assert.match(sql,/app_private\.is_internal\(\)/i);
 assert.doesNotMatch(sql,/\b(?:drop table|truncate table|delete from public)\b/i);
});
test('finance save locks deal and refuses un-ordered, lost or customer-held records',()=>{
 const s=functionBody('internal_deal_set_financing_impl');
 assert.match(s,/from public\.deals d where d\.id=p_deal_id for update/i);
 assert.match(s,/v_deal\.sales_outcome\s*<>\s*'won'/i);
 assert.match(s,/from public\.orders/i);
 assert.match(s,/app_private\.customer_allows_new_transaction/i);
 assert.match(s,/app_private\.is_internal\(\)/i);
 assert.match(s,/auth\.jwt\(\)->>'aal'/i);
});
test('nonlease normalizes lease fields and credit, valid finance states only',()=>{
 const s=functionBody('internal_deal_set_financing_impl');
 for(const term of ["lease","bank_transfer","cash","installment","invoice","other","approved","denied","partially_paid","overdue"])assert.ok(sql.includes("'"+term+"'"),term);
 assert.match(s,/v_method\s*<>\s*'lease'/i);
 assert.match(s,/v_credit_status\s*:=\s*'not_required'/i);
 assert.match(sql,/check\s*\(\s*method in/i);
 assert.match(sql,/check\s*\(\s*payment_state in/i);
});
test('finance save is idempotent and audited without mutating order or existing lease history',()=>{
 const s=functionBody('internal_deal_set_financing_impl');
 assert.match(s,/on conflict\s*\(deal_id\)/i);
 assert.match(s,/is distinct from/i);
 assert.match(s,/insert into public\.deal_events/i);
 assert.match(s,/insert into public\.audit_logs/i);
 assert.doesNotMatch(sql,/update public\.orders|update public\.order_operations|update public\.contracts/i);
});
test('API exposed to authenticated only and detail JSON includes financing',()=>{
 assert.match(sql,/create or replace function public\.internal_deal_set_financing\(/i);
 assert.match(sql,/grant execute on function public\.internal_deal_set_financing\(uuid,jsonb\) to authenticated/i);
 const details=readFileSync('sql/deal_workflow_queries.sql','utf8');
 assert.match(details,/'financing'\s*,\s*\(select/i);
});
test('won deal shows finance save action and opens lease-prefilled editor',async()=>{
 const f=fixture();await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/支払・リースを登録|支払・リースを編集/);
 assert.match(f.host.innerHTML,/ABCリース/);
 assert.equal(typeof f.api.openFinancingDialog,'function');
 f.api.openFinancingDialog('deal-1');
 assert.match(f.modal.body,/id="dealFinanceMethod"/);
 assert.match(f.modal.body,/value="lease" selected/);
 assert.match(f.modal.body,/id="dealLeaseCompany"/);
 assert.match(f.modal.body,/id="dealCreditStatus"/);
 assert.match(f.modal.body,/id="dealPaymentState"/);
});
test('finance action saves lease terms, and nonlease sets not-required credit',async()=>{
 const f=fixture();await f.api.openDetail('deal-1');f.api.openFinancingDialog('deal-1');
 const values={dealFinanceMethod:'bank_transfer',dealLeaseCompany:'should be ignored',dealLeaseMonths:'60',
   dealMonthlyAmount:'14500',dealCreditStatus:'approved',dealPaymentState:'invoiced',dealPaymentNote:'請求書を送付'};
 for(const [k,v] of Object.entries(values))f.fields.set(k,{value:v});
 await f.modal.onSubmit();
 const z=f.calls.find(x=>x.name==='internal_deal_set_financing');
 assert.equal(z.args.p_deal_id,'deal-1');
 assert.equal(z.args.p_payload.method,'bank_transfer');
 assert.equal(z.args.p_payload.credit_status,'not_required');
 assert.equal(z.args.p_payload.lease_company,null);
 assert.equal(z.args.p_payload.payment_state,'invoiced');
 assert.equal(z.args.p_payload.note,'請求書を送付');
});
