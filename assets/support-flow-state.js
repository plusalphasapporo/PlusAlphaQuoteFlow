/* Pure support case progression. API permissions stay server-side. */
(function(){
'use strict';
const INTERNAL=new Set(['internal_admin','internal_staff']);
function derive({ticket={},handoff=null,assignment={state:'assigned'},role='support_staff'}={}){
 const staff=INTERNAL.has(role);
 if(role==='customer_user')return {stage:ticket.status==='closed'?'完了':'対応状況',nextAction:'対応状況を確認',action:'view',canClose:false};
 if(handoff && !['pending','accepted','completed'].includes(handoff.state))
   return {stage:'状態の確認',nextAction:'引継ぎ状態を確認',action:'inspect',canClose:false};
 if(handoff && ['pending','accepted'].includes(handoff.state) && ticket.status==='closed')
   return {stage:'引継ぎ状態の確認',nextAction:'完了済みチケットと未完了引継ぎを確認',action:'inspect',canClose:false};
 if(ticket.status==='closed')return {stage:'完了',nextAction:'対応報告・履歴を確認',action:'view',canClose:false};
 if(handoff?.state==='pending')
   return {stage:'自社受領待ち',nextAction:staff?'自社で引継ぎを受領':'自社受領を待つ',action:staff?'accept_handoff':'wait_internal',canClose:false};
 if(handoff?.state==='accepted')
   return {stage:'自社対応中',nextAction:staff?'自社対応の結果を記録':'自社対応を待つ',action:staff?'finish_handoff':'wait_internal',canClose:false};
 if(handoff?.state==='completed')
   return {stage:'対応報告',nextAction:'対応報告を記録して完了',action:'report',canClose:true};
 if(!assignment || !['assigned','active'].includes(assignment.state))
   return {stage:'担当会社の確認',nextAction:staff?'担当サポート会社の割当を確認':'担当会社の割当を待つ',action:staff?'assign_vendor':'wait_assignment',canClose:false};
 const stage=ticket.support_stage;
 if(ticket.support_next_action==='customer_reply_waiting')
   return {stage:'顧客返信待ち',nextAction:'顧客からの返信を待つ',action:'wait_customer',canClose:false};
 if(ticket.support_next_action==='internal_review_waiting')
   return {stage:'自社確認待ち',nextAction:'自社の確認を待つ',action:'wait_internal',canClose:false};
 switch(stage){
 case 'unhandled':return {stage:'受付',nextAction:'一次対応を開始',action:'start',canClose:false};
 case 'in_progress':return {stage:'一次対応',nextAction:'対応結果を記録・報告または引継ぎ',action:'resolve_or_handoff',canClose:true};
 case 'teamviewer_waiting':return {stage:'リモート対応',nextAction:'必要に応じてリモート対応、または報告',action:'remote_or_report',canClose:true};
 case 'support_review_waiting':return {stage:'対応報告',nextAction:'対応報告を記録して完了',action:'report',canClose:true};
 case 'internal_handoff_waiting':return {stage:'自社受領待ち',nextAction:'引継ぎ記録を確認',action:'inspect',canClose:false};
 case 'internal_in_progress':return {stage:'自社対応中',nextAction:'引継ぎ記録を確認',action:'inspect',canClose:false};
 case 'completed':return {stage:'対応報告',nextAction:'報告内容と完了状態を確認',action:'inspect',canClose:false};
 default:return {stage:'状態の確認',nextAction:'既存の対応状況を確認',action:'inspect',canClose:false};
 }
}
window.QuoteFlowSupportFlowState={derive};
})();