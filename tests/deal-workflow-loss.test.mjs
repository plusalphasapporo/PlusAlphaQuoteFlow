import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../sql/deal_workflow_loss.sql',import.meta.url),'utf8');
test('loss and reopen exposed through authenticated MFA checked functions',()=>{
 for(const name of ['internal_deal_mark_lost','internal_deal_reopen']){
  assert.match(sql,new RegExp('create or replace function public\\.'+name+'\\(' ,'i'));
  assert.match(sql,new RegExp('grant execute on function public\\.'+name+'\\(' ,'i'));
 }
 assert.match(sql,/app_private\.is_internal\(\)/i);
 assert.match(sql,/auth\.jwt\(\)\s*->>\s*'aal'/i);
});
test('loss is serialized and refused after any order',()=>{
 assert.match(sql,/from public\.deals where id=p_deal_id for update/i);
 assert.match(sql,/from public\.orders o[\s\S]*?o\.deal_id\s*=\s*p_deal_id/i);
 assert.match(sql,/o\.quote_id\s*=\s*p_quote_id/i);
 assert.match(sql,/sales_outcome\s*in\s*\('won','cancelled_after_order'\)/i);
});
test('loss requires reason, date, details for other and preserves quote status',()=>{
 for(const s of ['reason_category','lost_date','reproposal_on','competitor','detail'])assert.match(sql,new RegExp(s,'i'));
 assert.match(sql,/p_reason_category\s*=\s*'other'/i);
 assert.match(sql,/insert into public\.deal_loss_events/i);
 assert.match(sql,/insert into public\.audit_logs/i);
 assert.doesNotMatch(sql,/update public\.quotes\s+set status\s*=\s*'rejected'/i);
});
test('reopening requires reason, creates immutable event, never erases old loss',()=>{
 assert.match(sql,/nullif\(btrim\(coalesce\(p_reason,''\)\),''\)/i);
 assert.match(sql,/event_type[^\n]*'reopened'|values\([^;]*'reopened'/is);
 assert.doesNotMatch(sql,/delete from public\.deal_loss_events/i);
});
