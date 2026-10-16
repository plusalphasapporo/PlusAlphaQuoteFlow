import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

let source='';
try { source=readFileSync(new URL('../assets/support-flow-state.js',import.meta.url),'utf8'); }
catch { /* test-first: red until implementation exists */ }

function derive({ticket={},handoff=null,assignment={state:'assigned'},role='support_staff'}={}){
 assert.ok(source,'support-flow-state.js must exist');
 const window={};
 runInNewContext(source,{window,console});
 assert.equal(typeof window.QuoteFlowSupportFlowState?.derive,'function');
 const input={ticket,handoff,assignment,role};
 return JSON.parse(JSON.stringify(window.QuoteFlowSupportFlowState.derive(input)));
}

test('障害・設定・問い合わせは同じ一次対応フローを使う',()=>{
 for(const type of ['incident','setting_request','inquiry']){
  const initial=derive({ticket:{status:'open',request_type:type,support_stage:'unhandled'}});
  assert.equal(initial.stage,'受付');
  assert.match(initial.nextAction,/一次対応/);
  assert.equal(initial.action,'start');
  assert.equal(initial.canClose,false);
  const active=derive({ticket:{status:'open',request_type:type,support_stage:'in_progress'}});
  assert.equal(active.stage,'一次対応');
  assert.match(active.nextAction,/対応結果|報告|引継ぎ/);
  assert.equal(active.action,'resolve_or_handoff');
  assert.equal(active.canClose,true,'report is validated by existing completion RPC');
 }
});

test('リモート対応は任意で、未実施でも解決・報告へ進める',()=>{
 const remote=derive({ticket:{status:'open',support_stage:'teamviewer_waiting'}});
 assert.equal(remote.stage,'リモート対応');
 assert.match(remote.nextAction,/リモート/);
 assert.equal(remote.action,'remote_or_report');
 assert.equal(remote.canClose,true);
 const review=derive({ticket:{status:'open',support_stage:'support_review_waiting'}});
 assert.equal(review.stage,'対応報告');
 assert.match(review.nextAction,/報告/);
 assert.equal(review.action,'report');
});

test('引継ぎ pending は自社受領待ち、社内だけが受領できる',()=>{
 const ticket={status:'open',support_stage:'internal_handoff_waiting'};
 const handoff={id:'h1',state:'pending'};
 const internal=derive({ticket,handoff,role:'internal_staff'});
 assert.equal(internal.stage,'自社受領待ち');
 assert.match(internal.nextAction,/受領/);
 assert.equal(internal.action,'accept_handoff');
 assert.equal(internal.canClose,false);
 const vendor=derive({ticket,handoff,role:'support_staff'});
 assert.equal(vendor.stage,'自社受領待ち');
 assert.equal(vendor.action,'wait_internal');
 assert.equal(vendor.canClose,false);
});

test('引継ぎ accepted は自社対応中、サポート会社は自社完了操作不可',()=>{
 const ticket={status:'open',support_stage:'internal_in_progress'};
 const handoff={id:'h1',state:'accepted'};
 const internal=derive({ticket,handoff,role:'internal_admin'});
 assert.equal(internal.stage,'自社対応中');
 assert.match(internal.nextAction,/自社対応/);
 assert.equal(internal.action,'finish_handoff');
 assert.equal(internal.canClose,false);
 const vendor=derive({ticket,handoff,role:'support_staff'});
 assert.equal(vendor.action,'wait_internal');
 assert.equal(vendor.canClose,false);
});

test('自社作業 completed でもチケットは別途報告してから完了する',()=>{
 const input={ticket:{status:'open',support_stage:'support_review_waiting'},
  handoff:{state:'completed',id:'h1'}};
 const vendor=derive({...input,role:'support_staff'});
 assert.equal(vendor.stage,'対応報告');
 assert.match(vendor.nextAction,/報告/);
 assert.equal(vendor.action,'report');
 assert.equal(vendor.canClose,true);
 const internal=derive({...input,role:'internal_staff'});
 assert.equal(internal.action,'report');
 const closed=derive({...input,ticket:{status:'closed',support_stage:'completed'}});
 assert.equal(closed.stage,'完了');
 assert.equal(closed.action,'view');
 assert.equal(closed.canClose,false);
});

test('担当会社が未割当・重複・確認不能なら一次対応を確定した扱いにしない',()=>{
 for(const state of ['unassigned','ambiguous','unknown']){
  const input={ticket:{status:'open',support_stage:'unhandled'},assignment:{state},role:'support_staff'};
  const result=derive(input);
  assert.equal(result.stage,'担当会社の確認');
  assert.equal(result.action,'wait_assignment');
  assert.equal(result.canClose,false);
 }
 const internal=derive({ticket:{status:'open',support_stage:'unhandled'},
  assignment:{state:'unassigned'},role:'internal_staff'});
 assert.equal(internal.action,'assign_vendor');
 assert.match(internal.nextAction,/割当/);
});

test('対応中の顧客返信待ちなど、既存 next_action を尊重する',()=>{
 const waiting=derive({ticket:{status:'open',support_stage:'in_progress',support_next_action:'customer_reply_waiting'}});
 assert.equal(waiting.stage,'顧客返信待ち');
 assert.match(waiting.nextAction,/顧客/);
 assert.equal(waiting.action,'wait_customer');
 const review=derive({ticket:{status:'open',support_stage:'in_progress',support_next_action:'internal_review_waiting'}});
 assert.equal(review.stage,'自社確認待ち');
 assert.equal(review.action,'wait_internal');
});

test('引継ぎ中に closed が観測された場合は誤って完了表示しない',()=>{
 for(const state of ['pending','accepted']){
  const result=derive({ticket:{status:'closed',support_stage:'completed'},handoff:{state},role:'internal_admin'});
  assert.equal(result.stage,'引継ぎ状態の確認');
  assert.equal(result.action,'inspect');
  assert.equal(result.canClose,false);
 }
});

test('顧客ロールには内部引継ぎ操作を公開しない',()=>{
 for(const state of ['pending','accepted','completed']){
  const result=derive({role:'customer_user',ticket:{status:'open',support_stage:'internal_in_progress'},handoff:{state}});
  assert.equal(result.action,'view');
  assert.equal(result.canClose,false);
  assert.doesNotMatch(result.nextAction,/自社受領|自社完了|内部/);
 }
});

test('入力は変更せず、未知の状態では誤った完了を表示しない',()=>{
 const ticket=Object.freeze({status:'open',support_stage:'strange_state'});
 const handoff=Object.freeze({state:'unexpected'});
 const assignment=Object.freeze({state:'assigned'});
 const result=derive({ticket,handoff,assignment});
 assert.equal(result.stage,'状態の確認');
 assert.equal(result.canClose,false);
 assert.equal(ticket.support_stage,'strange_state');
});
