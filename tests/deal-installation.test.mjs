import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
let sql='';
try{sql=readFileSync('sql/deal_installation.sql','utf8')}catch{}
const js=readFileSync('assets/deal-workflow.js','utf8');
const getImpl=()=>sql.match(/create or replace function app_private\.internal_deal_save_installation_impl\([\s\S]*?\$fn\$;/i)?.[0]||'';
function fixture(){
 const fields=new Map(),calls=[];let modal=null;
 const item={id:'job-1',deal_id:'deal-1',state:'tentative',scheduled_start_at:'2026-10-22T01:00:00Z',scheduled_end_at:'2026-10-22T03:00:00Z',site_address:'本店3F',work_note:'初回',acceptance_state:'pending',delivery_id:null};
 const detail={deal:{id:'deal-1',sales_outcome:'won',current_stage:'order'},customer:{name:'さくら商事'},
   quotes:[],orders:[{id:'order-1'}],purchase_orders:[{id:'po-1',purchase_order_number:'P100'}],deliveries:[],assets:[],contracts:[],support_tickets:[],events:[],loss_events:[],
   financing:{method:'bank_transfer',payment_state:'invoiced'},installation_jobs:[item]};
 const host={innerHTML:'',querySelectorAll(){return []}};
 const doc={getElementById(id){return fields.get(id)||null}};
 const win={};runInNewContext(js,{window:win,document:doc,console,Date,Intl});
 const api=win.QuoteFlowDeals;
 api.configure({rpc:async(name,args)=>{calls.push({name,args});if(name==='internal_deal_detail')return detail;if(name==='internal_deal_save_installation')return {id:'job-1'};},
   getHost:()=>host,getRole:()=> 'internal_staff',openModal:x=>{modal=x;},closeModal:()=>{},navigate:async()=>{}});
 return {fields,calls,modal:()=>modal,api,detail,host,item};
}
test('installation supports multiple dated visits and restricts direct public writes',()=>{
 assert.match(sql,/create table if not exists public\.deal_installation_jobs/i);
 assert.match(sql,/id uuid primary key default gen_random_uuid/i);
 assert.match(sql,/deal_id uuid not null references public\.deals\(id\)/i);
 assert.match(sql,/delivery_id uuid references public\.deliveries\(id\)/i);
 assert.match(sql,/scheduled_start_at timestamptz/i);
 assert.match(sql,/scheduled_end_at timestamptz/i);
 assert.match(sql,/alter table public\.deal_installation_jobs enable row level security/i);
 assert.match(sql,/revoke all on public\.deal_installation_jobs from public, anon, authenticated/i);
});
test('write transaction locks deal and ensures actual order without external approval',()=>{
 const s=getImpl();
 assert.match(s,/from public\.deals d where d\.id=p_deal_id for update/i);
 assert.match(s,/v_deal\.sales_outcome\s*<>\s*'won'/i);
 assert.match(s,/from public\.orders/i);
 assert.match(s,/app_private\.is_internal\(\)/i);
 assert.match(s,/auth\.jwt\(\)->>'aal'/i);
 assert.doesNotMatch(s,/approve_quote/i);
});
test('delivery links are validated by real order/deal relationship, never customer alone',()=>{
 const s=getImpl();
 assert.match(s,/from public\.deliveries/i);
 assert.match(s,/join public\.orders/i);
 assert.match(s,/d\.customer_id\s*=\s*v_deal\.customer_id/i);
 assert.match(s,/o\.deal_id\s*=\s*p_deal_id/i);
 assert.match(s,/delivery is not linked to the deal/i);
});
test('install schedule validation, postpone note, acceptance conditions and immutable audit snapshots',()=>{
 const s=getImpl();
 assert.match(s,/scheduled_end_at/i);
 assert.match(s,/v_state\s*=\s*'postponed'/i);
 assert.match(s,/postpone|延期理由/i);
 assert.match(s,/v_state\s*=\s*'completed'/i);
 assert.match(s,/acceptance_state/i);
 assert.match(s,/insert into public\.deal_events/i);
 assert.match(s,/to_jsonb\(v_before\)/i);
 assert.match(s,/to_jsonb\(v_saved\)/i);
 assert.match(s,/insert into public\.audit_logs/i);
 assert.doesNotMatch(s,/update public\.(deliveries|assets)/i);
});
test('save reuses an existing id and avoids duplicate records',()=>{
 const s=getImpl();
 assert.match(s,/where j\.id=v_job_id and j\.deal_id=p_deal_id for update/i);
 assert.match(s,/update public\.deal_installation_jobs/i);
 assert.match(s,/insert into public\.deal_installation_jobs/i);
 assert.match(s,/is distinct from/i);
});
test('detail RPC includes linked installation jobs and authenticated write RPC exists',()=>{
 const detail=readFileSync('sql/deal_workflow_queries.sql','utf8');
 assert.match(detail,/'installation_jobs'\s*,\s*\(select/i);
 assert.match(sql,/create or replace function public\.internal_deal_save_installation\(/i);
 assert.match(sql,/grant execute on function public\.internal_deal_save_installation\(uuid,jsonb\) to authenticated/i);
});
test('won deal offers multiple job registration and editing, with separate delivery info',async()=>{
 const f=fixture();await f.api.openDetail('deal-1');
 assert.match(f.host.innerHTML,/工事日を登録/);
 assert.match(f.host.innerHTML,/本店3F/);
 assert.match(f.host.innerHTML,/工事日程を編集/);
 assert.equal(typeof f.api.openInstallationDialog,'function');
 f.api.openInstallationDialog('deal-1','job-1');
 assert.match(f.modal().body,/id="dealInstallStart"/);
 assert.match(f.modal().body,/id="dealInstallState"/);
 assert.match(f.modal().body,/id="dealInstallAcceptance"/);
 assert.match(f.modal().body,/本店3F/);
});
test('invalid time range and missing postpone reason never reach RPC',async()=>{
 const f=fixture();await f.api.openDetail('deal-1');
 f.api.openInstallationDialog('deal-1','job-1');
 const vals={dealInstallStart:'2026-10-22T12:00',dealInstallEnd:'2026-10-22T10:00',
   dealInstallState:'postponed',dealInstallNote:'',dealInstallSite:'本店3F',
   dealInstallAcceptance:'pending',dealInstallAcceptanceBy:'',dealInstallDelivery:'',dealInstallAssignee:''};
 for(const [id,value]of Object.entries(vals))f.fields.set(id,{value});
 await assert.rejects(f.modal().onSubmit(),/終了|時刻/);
 f.fields.get('dealInstallEnd').value='2026-10-22T15:00';
 await assert.rejects(f.modal().onSubmit(),/延期理由/);
 assert.equal(f.calls.filter(x=>x.name==='internal_deal_save_installation').length,0);
});
test('an existing visit is updated and Japanese local 10AM saved unambiguously in UTC',async()=>{
 const f=fixture();await f.api.openDetail('deal-1');
 f.api.openInstallationDialog('deal-1','job-1');
 const vals={dealInstallStart:'2026-10-22T10:00',dealInstallEnd:'2026-10-22T12:00',
  dealInstallState:'confirmed',dealInstallNote:'搬入と設置',dealInstallSite:'本店3F',
  dealInstallAcceptance:'pending',dealInstallAcceptanceBy:'',dealInstallDelivery:'',dealInstallAssignee:''};
 for(const [id,value]of Object.entries(vals))f.fields.set(id,{value});
 await f.modal().onSubmit();
 const save=f.calls.find(x=>x.name==='internal_deal_save_installation');
 assert.equal(save.args.p_deal_id,'deal-1');
 assert.equal(save.args.p_job.id,'job-1');
 assert.equal(save.args.p_job.state,'confirmed');
 assert.equal(save.args.p_job.scheduled_start_at,'2026-10-22T01:00:00.000Z');
 assert.equal(save.args.p_job.scheduled_end_at,'2026-10-22T03:00:00.000Z');
});
