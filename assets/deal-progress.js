(function(){
'use strict';
function derive(x={}){
 const d=x.deal||{},quotes=x.quotes||[],orders=x.orders||[],fin=x.financing||null,
 pos=x.purchase_orders||[],items=x.receiving_items||[],deliveries=x.deliveries||[],
 jobs=x.installation_jobs||[],assets=x.assets||[],contracts=x.contracts||[];
 let stage='見積',nextAction='見積内容を確認',target='sales';
 if(d.sales_outcome==='lost')return {stage:'失注',nextAction:'失注案件を再開または再提案',target:'deals',steps:[]};
 if(d.sales_outcome==='cancelled_after_order')return {stage:'受注後キャンセル',nextAction:'キャンセル履歴を確認',target:'deals',steps:[]};
 if(!orders.length){
  if(d.sales_outcome==='won')nextAction='受注データを確認してください';
  else if(!quotes.length)nextAction='見積を作成してください';
  else if(quotes.at(-1)?.status==='draft')nextAction='見積を発行してください';
  else nextAction='受注または失注を登録してください';
  return {stage,nextAction,target,steps:[]};
 }
 stage='受注';
 if(!fin){nextAction='支払方法・リースを登録してください';target='finance';}
 else if(fin.method==='lease'&&fin.credit_status==='denied'){
  stage='支払・リース';nextAction='リース審査否決：支払方法を再検討';target='finance';
 }else if(fin.method==='lease'&&!['approved','conditional'].includes(fin.credit_status)){
  stage='支払・リース';nextAction='リース審査結果を確認';target='finance';
 }else if(pos.length&&(!items.length||items.some(i=>Number(i.received_quantity||0)<Number(i.quantity||0)))){
  stage='発注・入荷';nextAction=items.length?'未入荷の商品を登録してください':'発注明細と入荷状況を確認してください';target='receiving';
 }else if(pos.length&&!deliveries.length){stage='発注・入荷';nextAction='納品予定を作成してください';target='delivery';}
 else if(deliveries.some(d=>d.status!=='delivered')){stage='発注・入荷';nextAction='納品状況・完了確認を登録してください';target='delivery';}
 else if(!pos.length&&!deliveries.length&&!jobs.length){stage='発注・入荷';nextAction='必要に応じて発注・納品または工事日を登録してください';target='procurement';}
 else if(!jobs.length){stage='工事日';nextAction='工事日を登録するか、工事対象外を確認';target='installation';}
 else if(jobs.some(j=>j.state==='postponed')){stage='工事日';nextAction='延期された工事日を再調整';target='installation';}
 else if(jobs.some(j=>j.state==='revisit_required')){stage='施工';nextAction='再訪問の予定を登録';target='installation';}
 else if(jobs.some(j=>j.state==='tentative')){stage='工事日';nextAction='工事日時を確定';target='installation';}
 else if(jobs.some(j=>j.state==='confirmed'||j.state==='in_progress')){stage='施工';nextAction='施工状況を記録';target='installation';}
 else if(jobs.some(j=>j.state==='cancelled')){stage='工事日';nextAction='中止した工事の再手配・対応要否を確認';target='installation';}
 else if(jobs.some(j=>j.state==='completed'&&j.acceptance_state==='rejected')){stage='検収';nextAction='検収不合格の対応を記録';target='installation';}
 else if(jobs.some(j=>j.state==='completed'&&!['accepted','not_required'].includes(j.acceptance_state))){stage='検収';nextAction='未検収の工事を確認してください';target='installation';}
 else if(jobs.some(j=>j.state!=='completed')){stage='施工';nextAction='未完了の工事状況を確認';target='installation';}
 else if(!assets.length){stage='機器・保守';nextAction='機器台帳を確認してください';target='assets';}
 else if(!contracts.length){stage='機器・保守';nextAction='保守契約または対象外を確認';target='contracts';}
 else {stage='機器・保守';nextAction='サポートへ引継ぎ・運用管理';target='support';}
 return {stage,nextAction,target,steps:['見積','受注','支払・リース','発注・入荷','工事日','施工','検収','機器・保守','サポート']};
}
function scopeReceiving(items,purchaseOrderIds){
 if(!Array.isArray(items)||!Array.isArray(purchaseOrderIds)||!purchaseOrderIds.length)throw Error('対象発注と入荷明細を確認してください');
 const ids=new Set(purchaseOrderIds.filter(id=>typeof id==='string'&&id.trim()));
 if(!ids.size)throw Error('対象発注のIDを確認できません');
 return items.filter(item=>item&&ids.has(item.purchase_order_id));
}
window.QuoteFlowDealProgress={derive,scopeReceiving};
})();