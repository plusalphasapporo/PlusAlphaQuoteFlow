import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');
const helperStart=html.indexOf('  function caseDirectoryMatchesQuickFilter(');
const casesStart=html.indexOf('  async function renderCasesWorkspace(){');
const casesEnd=html.indexOf('  async function renderHandoffsWorkspace(){',casesStart);
assert.ok(helperStart>=0&&casesStart>helperStart&&casesEnd>casesStart,'Case filter helper and case directory must be present');
const helperSource=html.slice(helperStart,casesStart);
const matcher=helperSource.match(/  function caseDirectoryMatchesQuickFilter\(ticket,filter\)\{[\s\S]*?\n  \}/);
assert.ok(matcher,'Case quick filter must be a pure function');
const matches=vm.runInNewContext('('+matcher[0].trim()+')');
const ticket={status:'open',priority:'urgent',assigned_name:'',handoff_state:'pending'};
for(const key of ['all','active','priority','unassigned','handoff']){
  assert.equal(matches(ticket,key),true,'Expected ticket to match '+key);
}
assert.equal(matches({...ticket,status:'closed'},'active'),false);
assert.equal(matches({...ticket,status:'closed'},'priority'),false);
assert.equal(matches({...ticket,priority:'low'},'priority'),false);
assert.equal(matches({...ticket,priority:'high'},'priority'),true);
assert.equal(matches({...ticket,assigned_name:'担当者'},'unassigned'),false);
assert.equal(matches({...ticket,assigned_name:'未割当'},'unassigned'),true);
assert.equal(matches({...ticket,handoff_state:'completed'},'handoff'),false);
assert.equal(matches({...ticket,handoff_state:'accepted'},'handoff'),true);
assert.equal(matches({...ticket,handoff_state:null},'handoff'),false);

const cases=html.slice(casesStart,casesEnd);
for(const id of ['caseDirectory','caseDirectoryListHost','caseDirectoryResults']){
  assert.ok(cases.includes('id="'+id+'"'),'Case directory element missing: '+id);
}
assert.ok(cases.includes("rpc('internal_case_directory')"),'Existing case directory RPC must stay');
assert.ok(cases.includes("listToolbar('caseDirectory'"),'Search/sort/status controls required');
assert.ok(cases.includes("listToolbarState('caseDirectory')"),'Search controls must filter the same case list');
assert.ok(cases.includes('caseDirectoryMatchesQuickFilter(x,quickFilter)'), 'Quick filters must affect displayed cases');
assert.ok(cases.includes('aria-pressed'),'Filter selection must be accessible');
assert.ok(cases.includes('caseDirectoryOpen'),'Case rows must open the full work area');
assert.ok(cases.includes("openTicketWorkspace(btn.dataset.id,'cases')"),'Opening a case should allow return to case directory');
assert.ok(cases.includes("caseDirectoryCustomerOpen"),'Customer record shortcut must be available');
assert.ok(cases.includes("await go('customers')"),'Customer shortcut must use existing customer workspace');
assert.ok(cases.includes('条件に一致する案件はありません'), 'No-results state must explain how to recover');

const workspaceStart=html.indexOf('  async function openTicketWorkspace(');
const workspaceEnd=html.indexOf('  async function renderTicketDetail(',workspaceStart);
const workspace=html.slice(workspaceStart,workspaceEnd);
assert.ok(workspace.includes("returnPage==='cases'"),'Case workspace must allow a safe return to case management');
assert.ok(workspace.includes('ticketWorkspaceBack'),'Back to case directory button must remain');
const supportStart=html.indexOf('  async function renderSupport(){');
const supportEnd=html.indexOf('  async function renderAssets(){',supportStart);
const support=html.slice(supportStart,supportEnd);
assert.ok(support.includes('internalSupportFastIntake'),'Internal support intake shortcut must exist');
assert.ok(support.includes("go('support_new')"),'Support team must be able to start intake from case list');
assert.ok(support.includes("go('support_handoffs')"),'Support team must see handoffs from case list');
assert.ok(support.includes("go('cases')"),'Internal support management must link to case directory');
for(const selector of ['.caseDirectoryMetrics','.caseDirectoryMetric','.caseDirectoryResults','.supportQuickBar']){
  assert.ok(css.includes(selector),'Missing responsive workflow styling: '+selector);
}
assert.ok(css.includes('@media(max-width:620px)'),'Narrow-screen support layouts must exist');
console.log('Case directory filtering, intake and work navigation checks passed.');
