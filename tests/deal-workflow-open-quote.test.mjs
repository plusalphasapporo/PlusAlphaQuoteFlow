import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let sql='';
try{sql=readFileSync('sql/deal_workflow_open_from_quote.sql','utf8');}catch{}
test('existing quote can establish single deal under existing authentication',()=>{
 assert.match(sql,/create or replace function app_private\.internal_deal_open_from_quote_impl\(/i);
 assert.match(sql,/create or replace function public\.internal_deal_open_from_quote\(/i);
 assert.match(sql,/app_private\.is_internal\(\)/i);
 assert.match(sql,/auth\.jwt\(\)->>'aal'/i);
 assert.match(sql,/from public\.quotes q where q\.id=p_quote_id for update/i);
 assert.match(sql,/if v_quote\.deal_id is not null then/i);
 assert.match(sql,/insert into public\.deals\(/i);
 assert.match(sql,/update public\.quotes set deal_id=v_deal_id where id=p_quote_id/i);
});
test('quote with existing order retains original order number and becomes a won deal',()=>{
 assert.match(sql,/from public\.orders o where o\.quote_id=p_quote_id/i);
 assert.match(sql,/v_sales_outcome:='won'/i);
 assert.match(sql,/update public\.orders set deal_id=v_deal_id where quote_id=p_quote_id/i);
 assert.doesNotMatch(sql,/delete from public\.orders|delete from public\.quotes|drop table/i);
});
test('quote linking preserves customer match and records an audit entry',()=>{
 assert.match(sql,/v_quote\.customer_id/i);
 assert.match(sql,/insert into public\.audit_logs/i);
 assert.match(sql,/grant execute on function public\.internal_deal_open_from_quote\(uuid\) to authenticated/i);
});
