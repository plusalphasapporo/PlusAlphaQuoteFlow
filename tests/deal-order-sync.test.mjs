import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const sql=readFileSync('sql/deal_workflow_quote_order.sql','utf8');
test('both legacy and direct order creation update deal in a single statement transaction',()=>{
 assert.match(sql,/create or replace function app_private\.sync_order_deal_after_insert\(/i);
 assert.match(sql,/create trigger orders_deal_sync_after_insert after insert on public\.orders/i);
 assert.match(sql,/update public\.deals set sales_outcome='won',current_stage='order'/i);
 assert.match(sql,/insert into public\.deal_events/i);
});
test('before insert locks deal, blocks loss and a second order across different quote versions',()=>{
 const start=sql.indexOf('CREATE OR REPLACE FUNCTION app_private.guard_deal_order_insert()');
 const end=sql.indexOf('CREATE OR REPLACE FUNCTION app_private.deal_create_order_from_quote_impl',start);
 const guard=sql.slice(start,end);
 assert.match(guard,/FOR UPDATE/i);
 assert.match(guard,/v_deal\.sales_outcome<>'open'/i);
 assert.match(guard,/from public\.orders\s+existing/i);
 assert.match(guard,/existing\.quote_id IN\s*\(SELECT/i);
 assert.match(guard,/quote_id/);
});
test('direct RPC relies on shared synchronization rather than writing won and event twice',()=>{
 const start=sql.indexOf('CREATE OR REPLACE FUNCTION app_private.deal_create_order_from_quote_impl');
 const end=sql.indexOf('CREATE OR REPLACE FUNCTION public.deal_issue_quote',start);
 const body=sql.slice(start,end);
 assert.doesNotMatch(body,/UPDATE public\.deals SET sales_outcome='won'/i);
 assert.doesNotMatch(body,/INSERT INTO public\.deal_events\(deal_id,event_type,message,actor_user_id\)/i);
});
