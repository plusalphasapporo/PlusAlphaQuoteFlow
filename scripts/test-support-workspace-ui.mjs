import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');
const jumpStart=html.indexOf('  function supportWorkspaceJumpTarget(');
const workspaceStart=html.indexOf('  async function openTicketWorkspace(',jumpStart);
assert.ok(jumpStart>=0&&workspaceStart>jumpStart,
  'Support workspace jump target resolver must be declared outside render function');
const helperSource=html.slice(jumpStart,workspaceStart).match(
  /  function supportWorkspaceJumpTarget\(key\)\{[\s\S]*?\n  \}/
);
assert.ok(helperSource,'Support workspace jump target resolver must be a pure function');
const resolve=vm.runInNewContext('('+helperSource[0].trim()+')');
const targets={
  intake:'supportLinearIntake',
  knowledge:'supportKnowledgeWorkspace',
  remote:'supportRemoteWorkspace',
  report:'supportReportWorkspace',
  customer:'supportTicketCustomerContext',
  reply:'ticketMessageForm',
  history:'ticketMessageList',
  files:'ticketAttachmentGallery',
  handoffs:'ticketHandoffHistory'
};
for(const [key,id] of Object.entries(targets)){
  assert.equal(resolve(key),id,'Navigation target mismatch: '+key);
  assert.ok(html.includes('id="'+id+'"'), 'Navigation anchor not mounted: '+id);
}
for(const key of ['invalid','__proto__','constructor','']){
  assert.equal(resolve(key),null,'Unexpected navigation target allowed: '+key);
}

const detailStart=html.indexOf('  async function renderTicketDetail(');
const detailEnd=html.indexOf('  async function renderSupport(){',detailStart);
assert.ok(detailStart>=0&&detailEnd>detailStart,'Ticket details must stay accessible');
const detail=html.slice(detailStart,detailEnd);
for(const key of ['intake','knowledge','remote','report','customer','reply','history','files']){
  assert.ok(detail.includes('data-jump="'+key+'"'),'Missing shortcut: '+key);
}
assert.ok(detail.includes('class="supportStep supportWorkspaceJump '),
  'The four-step progress display must be keyboard-accessible buttons');
assert.equal((detail.match(/class="supportStep supportWorkspaceJump /g)||[]).length,4,
  'All four steps must support navigation');
assert.ok(detail.includes('class="supportWorkspaceQuickContext"'),
  'Customer, device and contract summary should be visible without expanding details');
assert.ok(detail.includes('class="supportWorkspaceQuickNav"'),
  'Support workspace shortcuts must be discoverable');
assert.ok(detail.includes("if(support){"),'Shortcuts must be limited to the support role');
assert.ok(detail.includes("document.querySelectorAll('.supportWorkspaceJump')"),
  'Shortcut controls must have an event handler');
assert.ok(detail.includes('supportWorkspaceJumpTarget(btn.dataset.jump)'),
  'Shortcuts must use a strict whitelist of allowed targets');
assert.ok(detail.includes("const target=document.getElementById(targetId)"),
  'Navigation must move to the intended section');
assert.ok(detail.includes('target.scrollIntoView('),
  'Navigation must scroll to the selected area');
assert.ok(detail.includes("supportReadOnlyByOther"),
  'Work permissions must continue to apply');
assert.ok(detail.includes("rpc('claim_support_ticket'"),
  'Existing assignment behavior must remain intact');
assert.ok(detail.includes('ticketCloseBtn'),
  'Existing work-report action must remain intact');
assert.ok(detail.includes('ticketHandoffBtn'),
  'Existing handoff flow must remain intact');
assert.ok(detail.includes('ticketTeamViewerCreate'),
  'Existing TeamViewer flow must remain intact');
assert.ok(detail.includes('ticketMessageForm'),
  'Customer message form must remain intact');

for(const selector of [
  '.supportWorkspaceQuickContext','.supportWorkspaceQuickNav',
  '.supportWorkspaceJump','.supportFlowHint'
]){
  assert.ok(css.includes(selector),'Missing support workspace CSS: '+selector);
}
assert.ok(css.includes('@media(max-width:620px)'),
  'Support workspace must have a mobile layout');
console.log('Support workspace navigation and action regression checks passed.');
