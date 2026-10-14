/**
 * Actual DOM integration tests for QuoteFlow's optional UI layer.
 * No network/API/database access or real customer records.
 *
 * CI installs an exact jsdom version only for this test. The redesigned UI
 * script is evaluated unchanged against role-specific browser-like fixtures.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync('ui/workspace-redesign.js','utf8');

const supportHome = [
  '<div class="pageIntro"><h2>サポートTOP</h2></div>',
  '<section class="supportReceptionBar"><h2>受付</h2><button id="supportNewFromHome">新規受付</button></section>',
  '<section class="supportTodayBoard"><h2>今日やること</h2><button id="supportUnansweredTile">未返信</button></section>',
  '<section class="supportHomeSection"><h2>次の行動キュー</h2><button id="queueAction">続きを対応</button></section>',
  '<section id="supportUnansweredSection" class="supportHomeSection"><h2>未返信</h2></section>',
  '<section class="supportHomeSection"><h2>最近の電話</h2><button id="recentCall">通話を確認</button></section>'
].join('\n');

const internalHome = [
  '<div class="pageIntro"><h2>ダッシュボード</h2></div>',
  '<section class="card section internalCommandCenter"><h2>自社対応センター</h2><div class="internalActionStrip"><button class="internalQuickAction" data-action="incident">障害登録</button><button class="internalQuickAction" data-action="setting">設定登録</button></div></section>',
  '<section class="card section"><h2>通常業務</h2><button id="nativeSales">見積</button></section>',
  '<section class="card section"><h2>サポート期限管理</h2><button id="nativeDeadline">期限を見る</button></section>'
].join('\n');

function linear(id, state = '') {
  return '<section class="supportLinearCard '+state+'" id="'+id+'"><div class="supportLinearHead"><strong>'+id+'</strong></div><div class="supportLinearBody"><button class="nativeStep">次へ</button></div></section>';
}
function supportTicket(key='TKT-001') {
  return [
    '<div id="ticketDetailHost"><section class="card section">',
    '<div class="quoteDetailHead"><h2>サポート案件カルテ</h2><p class="sectionDesc">'+key+' / 印刷障害</p></div>',
    '<div class="supportTicketTopbar"><div>今やること</div><button id="supportTopPrimaryAction" data-action="remote">TeamViewerを開始</button></div>',
    '<div class="supportTicketFacts"><div class="supportTicketFact"><span>顧客 / 対象</span><strong>テスト機器</strong></div></div>',
    '<section id="supportAssistWorkspace" class="formSection"><h3>対応フロー</h3><div class="supportLinearFlow">',
    linear('supportLinearIntake','done'),
    linear('supportKnowledgeWorkspace','done'),
    linear('supportRemoteWorkspace'),
    linear('supportReportWorkspace'),
    '</div></section>',
    '<div id="supportTicketCustomerContext" class="modalGrid2"><section><h3>顧客</h3><button id="nativeCustomer">情報を開く</button></section></div>',
    '<section class="section"><h3>対応履歴タイムライン</h3><button id="nativeTimeline">履歴を開く</button></section>',
    '<section class="section"><h3>対応履歴・メッセージ</h3><form id="ticketMessageForm"><button id="nativeMessage" type="button">返信を送信</button></form></section>',
    '<section class="section" id="ticketAiIncidentSection"><h3>AI障害解析</h3><button id="nativeResearch">Web調査</button></section>',
    '<section class="section"><h3>写真・添付ファイル</h3><button id="nativeAttachment">ファイル</button></section>',
    '</section></div>'
  ].join('');
}
function get(doc, selector) {
  const result=doc.querySelector(selector);
  assert.ok(result,'Missing: '+selector);
  return result;
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,30));

async function fixture(role,pages,html) {
  const dom=new JSDOM('<!doctype html><html><body data-role="'+role+'"><aside class="side"><div class="sideTitle">MENU</div><nav id="navMenu"></nav></aside><main id="home"></main></body></html>',
    {url:'https://quote-flow-staging.example/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom, doc=window.document;
  const failures=[], clicks=[];
  window.console.warn=(...parts)=>failures.push(parts.join(' '));
  window.requestAnimationFrame=callback=>setTimeout(()=>callback(Date.now()),0);
  for (const [id,label] of pages) {
    const button=doc.createElement('button');
    button.className='navBtn'+(id==='home'?' active':'');
    button.type='button';button.dataset.page=id;button.textContent=label;
    button.onclick=()=>clicks.push(id);
    get(doc,'#navMenu').append(button);
  }
  get(doc,'#home').innerHTML=html;
  window.eval(source);
  await pause();
  assert.deepEqual(failures,[],role+' layout runtime warnings');
  return {dom,window,doc,clicks,failures};
}

{
  const {dom,doc,clicks,failures}=await fixture('support_staff',
    [['home','サポートTOP'],['support_cases','案件一覧'],['support_customers','顧客検索'],['knowledge','ナレッジ']],
    supportHome);
  assert.equal(doc.querySelectorAll('.qf-nav-group').length,2,'Support menu groups');
  get(doc,'.navBtn[data-page="support_cases"]').click();
  assert.deepEqual(clicks,['support_cases'],'Original navigation handlers must survive relocation');
  let count=0;
  get(doc,'#supportNewFromHome').onclick=()=>count++;
  get(doc,'.qf-shortcut-primary').click();
  assert.equal(count,1,'Shortcut must invoke original new-intake handler');
  get(doc,'.qf-home-switcher [data-view="queue"]').click();
  assert.equal(get(doc,'.qf-home-panel[data-qf-view="queue"]').hidden,false);
  assert.equal(get(doc,'.qf-home-panel[data-qf-view="today"]').hidden,true);
  get(doc,'.qf-home-switcher [data-view="today"]').click();
  get(doc,'#supportUnansweredTile').click();
  assert.equal(get(doc,'.qf-home-panel[data-qf-view="queue"]').hidden,false,'Open unread queue on tile click');
  // Route switch: keep the real nav nodes and use a fresh source-rendered ticket.
  get(doc,'.navBtn[data-page="home"]').classList.remove('active');
  get(doc,'.navBtn[data-page="support_cases"]').classList.add('active');
  const original=doc.createElement('div');
  get(doc,'#home').innerHTML=supportTicket();
  let messageSends=0, researches=0, remoteCalls=0;
  get(doc,'#nativeMessage').onclick=()=>messageSends++;
  get(doc,'#nativeResearch').onclick=()=>researches++;
  get(doc,'#supportRemoteWorkspace .nativeStep').onclick=()=>remoteCalls++;
  await pause();
  assert.deepEqual(failures,[]);
  assert.equal(doc.querySelectorAll('.qf-ticket-tabs [role="tab"]').length,5,'Ticket tab structure');
  assert.equal(get(doc,'.qf-ticket-pane[data-qf-view="messages"]').contains(get(doc,'#nativeMessage')),true);
  assert.equal(get(doc,'.qf-ticket-pane[data-qf-view="customer"]').contains(get(doc,'#nativeCustomer')),true);
  assert.equal(get(doc,'.qf-ticket-pane[data-qf-view="history"]').contains(get(doc,'#nativeTimeline')),true);
  assert.equal(get(doc,'.qf-ticket-pane[data-qf-view="details"]').contains(get(doc,'#nativeAttachment')),true);
  get(doc,'.qf-ticket-tabs [data-view="messages"]').click();
  get(doc,'#nativeMessage').click();
  assert.equal(messageSends,1,'Native message action must remain wired');
  get(doc,'.qf-ticket-tabs [data-view="work"]').click();
  get(doc,'#nativeResearch').click();
  assert.equal(researches,1,'Native AI research button must remain wired');
  assert.equal(get(doc,'#supportRemoteWorkspace').classList.contains('qf-step-collapsed'),true,'Non-current workflow card initially collapsed');
  get(doc,'#supportTopPrimaryAction').click();
  assert.equal(get(doc,'#supportRemoteWorkspace').classList.contains('qf-step-collapsed'),false,'Primary action opens remote step');
  get(doc,'#supportRemoteWorkspace .nativeStep').click();
  assert.equal(remoteCalls,1,'Native remote action must remain wired');
  get(doc,'.qf-step-toggle').click();
  assert.equal(get(doc,'#supportLinearIntake').classList.contains('qf-step-collapsed'),false,'Accordion toggle opens the original contents');
  get(doc,'.qf-ticket-tabs [data-view="messages"]').click();
  get(doc,'#home').innerHTML=supportTicket('TKT-002');
  await pause();
  assert.equal(get(doc,'.qf-ticket-tabs [data-view="work"]').getAttribute('aria-selected'),'true','New ticket resets tab to action view');
  assert.deepEqual(failures,[],'No runtime errors on ticket replacement');
  dom.window.close();
}
{
  const {dom,doc,failures}=await fixture('internal_admin',
    [['home','ダッシュボード'],['support','問い合わせ'],['customers','顧客'],['sales','見積・リース'],['cases','案件']],
    internalHome);
  let count=0;
  get(doc,'.internalQuickAction[data-action="incident"]').onclick=()=>count++;
  get(doc,'.qf-shortcut-primary').click();
  assert.equal(count,1,'Internal action shortcut preserves the native handler');
  get(doc,'.qf-home-switcher [data-view="business"]').click();
  assert.equal(get(doc,'#nativeSales').closest('.qf-home-panel').hidden,false);
  get(doc,'.qf-home-switcher [data-view="support"]').click();
  assert.equal(get(doc,'#nativeDeadline').closest('.qf-home-panel').hidden,false);
  assert.deepEqual(failures,[]);
  dom.window.close();
}
{
  const {dom,doc,failures}=await fixture('customer_user',
    [['home','ホーム'],['support','問い合わせ'],['customer_status','対応状況']],
    '<section id="customerOriginal"><button id="nativeCustomerOpen">問い合わせ</button></section>');
  assert.equal(doc.querySelector('.qf-home-switcher'),null,'Customer UI remains untouched');
  assert.equal(doc.querySelector('.qf-ticket-tabs'),null,'Customer ticket UI remains untouched');
  assert.ok(doc.querySelector('.qf-nav-group'),'Customer navigation grouped');
  assert.deepEqual(failures,[]);
  dom.window.close();
}
console.log('UI DOM integration tests passed: support, internal, customer, native handlers, ticket switching, accordion and rerender.');
