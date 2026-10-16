import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../sql/deal_workflow_base.sql',import.meta.url),'utf8').toLowerCase();
test('deal stage and outcome are separate, preserving parent customer id',()=>{
 assert.match(sql,/create table if not exists public.deals/);
 assert.match(sql,/customer_id uuid not null references public.customers\(id\)/);
 for(const value of ['open','won','lost','cancelled_after_order'])assert.ok(sql.includes("'"+value+"'"),value);
});
test('legacy business records only receive nullable deal link',()=>{
 for(const table of ['quotes','orders','purchase_orders','deliveries','assets','contracts','support_tickets'])
 assert.match(sql,new RegExp('alter table public\\.'+table+' add column if not exists deal_id uuid'));
 assert.doesNotMatch(sql,/\b(?:drop table|truncate table|delete from)\b/);
 assert.match(sql,/foreign key \(deal_id,customer_id\) references public.deals\(id,customer_id\)/);
});
test('loss history and row-level access stay protected by MFA',()=>{
 for(const table of ['deals','deal_loss_events','deal_events']){
 assert.ok(sql.includes('alter table public.'+table+' enable row level security'));
 assert.ok(sql.includes('revoke all on public.'+table+' from public, anon, authenticated'));
 }
 assert.match(sql,/auth.jwt\(\)->>'aal'/);
 assert.match(sql,/app_private.is_internal\(\)/);
 assert.match(sql,/deal_loss_events_required_details/);
});
