import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync('index.html','utf8');

test('demo cleanup preview is an admin-only, read-only RPC',()=>{
  const sql=readFileSync('sql/demo_cleanup_preview.sql','utf8');
  assert.match(sql,/create\s+or\s+replace\s+function\s+app_private\.internal_demo_cleanup_preview_impl\s*\(\s*\)/i);
  assert.match(sql,/app_private\.is_internal_admin_aal2\s*\(\s*\)/i);
  assert.match(sql,/create\s+or\s+replace\s+function\s+public\.internal_demo_cleanup_preview\s*\(\s*\)/i);
  assert.match(sql,/revoke\s+all\s+on\s+function\s+public\.internal_demo_cleanup_preview\s*\(\s*\)\s+from\s+public\s*,\s*anon/i);
  assert.doesNotMatch(sql,/\b(delete\s+from|truncate\s+table|drop\s+table)\b/i,'preview must not delete data');
});

test('demo cleanup review includes untagged demo customers and preserves CallConnect recordings',()=>{
  const sql=readFileSync('sql/demo_cleanup_preview.sql','utf8');
  assert.match(sql,/DEMO-CUSTOMER/);
  assert.match(sql,/DEMO-HOKKAIDO/);
  assert.match(sql,/DEMO-MIRAI/);
  assert.match(sql,/QF_DEMO_20260925_V1/);
  assert.match(sql,/callconnect_calls/);
  assert.match(sql,/quoteflow-data\.json:2026-10-06/);
  assert.match(sql,/imported_customers/);
  assert.match(sql,/imported_products/);
});

test('settings page loads full preview before stating no demo data remains',()=>{
  assert.match(html,/rpc\('internal_demo_cleanup_preview'\)/,'show verified full preview');
  assert.match(html,/demoCleanupPreview/,'display full residual count');
  assert.match(html,/DEMO-CUSTOMER/,'identify the unseeded demo customer in UI');
  assert.match(html,/CallConnect.*通話.*残す|通話.*CallConnect.*残す/s,'avoid deleting provider call logs');
});

test('legacy seed cleanup is not mislabeled as complete demo purge',()=>{
  const start=html.indexOf("const deleteDemoBtn=$('#deleteDemoSeedBtn');");
  assert.ok(start>=0,'seed deletion control exists');
  const handler=html.slice(start,start+1900);
  assert.match(handler,/delete_demo_seed/);
  assert.match(handler,/シード|一部/,'only report partial seed deletion');
  assert.doesNotMatch(handler,/デモデータを削除しました。ログイン用デモアカウントと既存本データは残っています。/);
});
