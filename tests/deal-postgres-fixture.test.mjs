import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const fixture=readFileSync('tests/fixtures/deal-order-postgres-base.sql','utf8');
const base=readFileSync('sql/deal_workflow_base.sql','utf8');
const order=readFileSync('sql/deal_workflow_quote_order.sql','utf8');
test('isolated fixture has all referenced core business relations',()=>{
 for(const table of ['customers','quotes','quote_items','orders','purchase_orders','purchase_order_items','purchase_serials','deliveries','assets','contracts','support_tickets','audit_logs'])
  assert.match(fixture,new RegExp('CREATE TABLE public\\.'+table+'\\(','i'));
 for(const name of ['auth.uid','auth.jwt','app_private.is_internal','app_private.current_role','app_private.next_document_number','app_private.next_legacy_customer_quote_number'])
  assert.ok(fixture.includes('FUNCTION '+name+'('),name);
});
test('fixture contains roles and supports MFA/RLS policy compilation',()=>{
 for(const role of ['anon','authenticated'])assert.ok(fixture.includes("rolname='"+role+"'"));
 assert.ok(fixture.includes('GRANT USAGE ON SCHEMA public, app_private TO authenticated'));
 assert.ok(base.includes('ENABLE ROW LEVEL SECURITY'));
});
test('order insert guard and synchronized order update require deal row locking',()=>{
 assert.match(order,/from public\.deals d where d\.id=v_deal_id for update/i);
 assert.match(order,/create trigger orders_deal_sync_after_insert after insert on public\.orders/i);
 assert.match(order,/update public\.deals set sales_outcome='won'/i);
});
