import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const path = new URL('../sql/deal_workflow_quote_order.sql', import.meta.url);
let sql = '';
try { sql = readFileSync(path,'utf8'); } catch { /* red: workflow not implemented */ }

function bodyOf(name){
  const pattern = new RegExp('create\\s+or\\s+replace\\s+function\\s+app_private\\.'+name+'_impl\\s*\\([\\s\\S]*?\\$fn\\$;', 'i');
  return sql.match(pattern)?.[0] || '';
}

test('quote issuance and order conversion expose separately secured staff RPCs',()=>{
  for(const n of ['deal_issue_quote','deal_create_order_from_quote']){
    assert.match(sql,new RegExp('create\\s+or\\s+replace\\s+function\\s+public\\.'+n+'\\(','i'));
    assert.match(sql,new RegExp('grant\\s+execute\\s+on\\s+function\\s+public\\.'+n+'\\(','i'));
    const body=bodyOf(n);
    assert.match(body,/app_private\.is_internal\(\)/i);
    assert.match(body,/auth\.jwt\(\)\s*->>\s*'aal'/i);
    assert.match(body,/from\s+public\.deals\s+\w+\s+where\s+\w+\.id\s*=\s*p_deal_id\s+for\s+update/i);
    assert.match(body,/from\s+public\.quotes\s+\w+\s+where\s+\w+\.id\s*=\s*p_quote_id\s+for\s+update/i);
    assert.match(body,/v_quote\.customer_id\s*<>\s*v_deal\.customer_id/i);
  }
});
test('issue quote uses legacy number, emits issue event, and never requests manager approval',()=>{
  const body=bodyOf('deal_issue_quote');
  assert.match(body,/v_quote\.status\s*=\s*'finalized'/i);
  assert.match(body,/v_quote\.status\s*<>\s*'draft'/i);
  assert.match(body,/v_quote\.valid_until/i);
  assert.match(body,/public\.quote_items/i);
  assert.match(body,/app_private\.next_legacy_customer_quote_number/i);
  assert.match(body,/set\s+quote_number\s*=/i);
  assert.match(body,/status\s*=\s*'finalized'/i);
  assert.match(body,/'quote\.issued'/i);
  assert.doesNotMatch(body,/approve_quote|quote\.submitted_for_approval|quote\.admin_approved/i);
});
test('direct order requires issued quote, retains existing order on repeat, and records actor',()=>{
  const body=bodyOf('deal_create_order_from_quote');
  assert.match(body,/v_quote\.status\s+not\s+in\s*\('finalized','accepted'\)/i);
  assert.match(body,/v_deal\.sales_outcome\s*<>\s*'open'/i);
  assert.match(body,/app_private\.customer_allows_new_transaction/i);
  assert.match(body,/v_quote\.valid_until/i);
  assert.match(body,/from\s+public\.orders\s+\w+/i);
  assert.match(body,/already_exists/i);
  assert.match(body,/app_private\.next_document_number\('order'\)/i);
  assert.match(body,/insert\s+into\s+public\.orders/i);
  assert.match(body,/deal_id/i);
  assert.match(sql,/UPDATE public\.deals SET sales_outcome='won'/i);
  assert.match(body,/'deal\.order_created'/i);
  assert.match(body,/auth\.uid\(\)/i);
  assert.doesNotMatch(body,/approve_quote|quote\.admin_approved/i);
});
test('legacy accepted-order RPC cannot insert into a lost deal through old endpoint',()=>{
  assert.match(sql,/create\s+or\s+replace\s+function\s+app_private\.guard_deal_order_insert\(/i);
  assert.match(sql,/create\s+trigger\s+orders_deal_outcome_guard/i);
  assert.match(sql,/before\s+insert\s+on\s+public\.orders/i);
  assert.match(sql,/from\s+public\.deals\s+\w+\s+where\s+\w+\.id\s*=\s*v_deal_id\s+for\s+update/i);
  assert.match(sql,/sales_outcome\s*<>\s*'open'/i);
  assert.match(sql,/new\.deal_id\s*:=\s*v_deal_id/i);
  assert.match(sql,/new\.customer_id\s*<>\s*v_deal\.customer_id/i);
});
test('loss guard rejects any previous order on another quote belonging to the same deal',()=>{
  const loss=readFileSync(new URL('../sql/deal_workflow_loss.sql',import.meta.url),'utf8');
  assert.match(loss,/o\.quote_id\s+in\s*\(select\s+q\.id\s+from\s+public\.quotes\s+q\s+where\s+q\.deal_id\s*=\s*p_deal_id\)/i);
});
