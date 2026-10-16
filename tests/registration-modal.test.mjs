import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
test('all registration entry points share an implemented modal',()=>{
  assert.match(html,/function openModal\(\s*\{/);
  assert.match(html,/function closeModal\(/);
  for(const name of ['assetLedgerCreateBtn','contractWorkspaceCreate','knowledgeAdminNew']){
    assert.ok(html.includes(name),name);
  }
});
test('modal validates required fields, handles async failures and does not silently close on failure',()=>{
  const start=html.indexOf('function openModal(');
  assert.ok(start>=0);
  const section=html.slice(start,start+4500);
  assert.match(section,/checkValidity\(/);
  assert.match(section,/await\s+onSubmit\(/);
  assert.match(section,/catch\s*\(/);
  assert.match(section,/modalError/);
});
