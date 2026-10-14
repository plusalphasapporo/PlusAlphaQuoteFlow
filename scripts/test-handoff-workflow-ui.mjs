import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');
const handoffStart=html.indexOf('  function internalHandoffMatchesFilter(');
const rendererStart=html.indexOf('  async function renderHandoffsWorkspace(){');
const rendererEnd=html.indexOf('  async function renderAnalysis(){',rendererStart);
assert.ok(handoffStart>=0&&rendererStart>handoffStart&&rendererEnd>rendererStart,
  'Internal handoff filter and screen must exist');
const helper=html.slice(handoffStart,rendererStart);
const functions=helper.match(/  function internalHandoffMatchesFilter\([\s\S]*?\n  \}\n\n  function internalHandoffStateOrder\([\s\S]*?\n  \}/);
assert.ok(functions,'Handoff filter and priority order must be pure functions');
const {internalHandoffMatchesFilter:matches,internalHandoffStateOrder:rank}=vm.runInNewContext(
  functions[0]+'\n({internalHandoffMatchesFilter,internalHandoffStateOrder})'
);
const sample={
  state:'pending',ticket_number:'T-001',customer_name:'株式会社テスト',
  subject:'プリンター障害',reason:'管理者判断が必要',
  next_action:'障害内容を確認',requested_by_name:'佐藤'
};
assert.equal(matches(sample,'all',''),true);
assert.equal(matches(sample,'pending',''),true);
assert.equal(matches(sample,'accepted',''),false);
assert.equal(matches({...sample,state:'accepted'},'accepted',''),true);
assert.equal(matches({...sample,state:'completed'},'completed',''),true);
assert.equal(matches(sample,'all','t-001'),true);
assert.equal(matches(sample,'all','テスト'),true);
assert.equal(matches(sample,'all','管理者判断'),true);
assert.equal(matches(sample,'all','障害内容'),true);
assert.equal(matches(sample,'all','佐藤'),true);
assert.equal(matches(sample,'all','存在しない文字'),false);
assert.equal(matches({...sample,state:'unrecognized'},'all',''),true,
  'Unknown handoff states must not silently disappear from all');
assert.ok(rank('pending')<rank('accepted'));
assert.ok(rank('accepted')<rank('completed'));
assert.ok(rank('completed')<rank('unrecognized'));

const screen=html.slice(rendererStart,rendererEnd);
assert.ok(screen.includes("rpc('internal_handoff_history')"),'Existing read RPC must be preserved');
for(const id of ['handoffStateFilters','handoffSearch','handoffListCount','handoffCardsHost']){
  assert.ok(screen.includes('id="'+id+'"'),'Missing accessible handoff control: '+id);
}
for(const state of ['pending','accepted','completed','all']){
  assert.ok(screen.includes("['"+state+"'"),'State filter unavailable: '+state);
}
assert.ok(screen.includes('internalHandoffMatchesFilter(h,selectedFilter,query)'),
  'Filter and search must be applied together');
assert.ok(screen.includes('internalHandoffStateOrder(a.state)'),'Urgency sort must be applied');
assert.ok(screen.includes('aria-pressed'),'Filter state must be accessible');
assert.ok(screen.includes('renderHandoffCards()'),'Hand-off cards must update on filter changes');
assert.ok(screen.includes("esc(h.reason||'未記入')"),'Handoff reason must be escaped and explicit if blank');
assert.ok(screen.includes("esc(h.next_action||'未記入')"),'Next action must be escaped and explicit if blank');
assert.ok(screen.includes("rpc('accept_ticket_handoff'"),'Existing handoff acceptance RPC must be preserved');
assert.ok(screen.includes("openTicketWorkspace(btn.dataset.ticketId,'handoffs')"),
  'Handoff cards must open the existing workspace with a return route');
assert.ok(screen.includes('if(h.ticket_id)'), 'Opening missing ticket IDs must not be offered');
assert.ok(!screen.includes("rpc('complete_ticket_handoff'"),
  'Handoff history display must not silently add completion behavior');
assert.ok(screen.includes('検索条件を変更してください'), 'Empty filtered results must explain recovery');
const workStart=html.indexOf('  async function openTicketWorkspace(');
const workEnd=html.indexOf('  async function renderTicketDetail(',workStart);
const workspace=html.slice(workStart,workEnd);
assert.ok(workspace.includes("returnPage==='handoffs'"),
  'Ticket workspace must support return to internal handoffs');
assert.ok(workspace.includes("returnPage==='cases'"),
  'Existing cases back navigation must be preserved');
for(const selector of ['.handoffStateFilters','.handoffStateButton','.handoffDecisionGrid','.handoffReason','.handoffNextAction']){
  assert.ok(css.includes(selector),'Missing handoff layout: '+selector);
}
assert.ok(css.includes('@media(max-width:620px)'),'Mobile layout must remain responsive');
console.log('Internal handoff filters, priority, acceptance and navigation checks passed.');
