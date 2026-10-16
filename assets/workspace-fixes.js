(function(){
  'use strict';
  function closeModal(){
    const root=document.getElementById('appModalLayer');
    if(root)root.remove();
    document.body.classList.remove('modalOpen');
  }
  function openModal(options={}){
    const title=String(options.title||'登録');
    const description=String(options.description||'');
    const closeText='閉じる';
    const text=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    closeModal();
    document.body.insertAdjacentHTML('beforeend',
      '<div id="appModalLayer" class="appModalLayer" role="dialog" aria-modal="true">'+
        '<div class="appModal'+(options.wide?' wide':'')+'">'+
          '<div class="appModalHead"><div><h2>'+text(title)+'</h2><p>'+text(description)+'</p></div>'+
          '<button type="button" id="standardModalClose" class="ghost" aria-label="'+closeText+'">×</button></div>'+
          '<form id="standardModalForm" class="appModalForm">'+
            '<div class="appModalBody">'+(options.body||'')+
              '<div id="standardModalError" class="notice error hidden" role="alert"></div></div>'+
            '<div class="appModalFoot"><button id="standardModalCancel" class="ghost" type="button">キャンセル</button>'+
              '<button id="standardModalSubmit" class="primary" type="submit">'+text(options.confirmLabel||'保存')+'</button></div>'+
          '</form>'+
        '</div>'+
      '</div>');
    document.body.classList.add('modalOpen');
    const root=document.getElementById('appModalLayer');
    const form=document.getElementById('standardModalForm');
    const submit=document.getElementById('standardModalSubmit');
    const error=document.getElementById('standardModalError');
    document.getElementById('standardModalClose').onclick=closeModal;
    document.getElementById('standardModalCancel').onclick=closeModal;
    root.onclick=e=>{if(e.target===root && !submit.disabled)closeModal();};
    form.onsubmit=async e=>{
      e.preventDefault();
      if(submit.disabled)return;
      if(!form.reportValidity())return;
      submit.disabled=true;
      error.classList.add('hidden');
      try{await options.onSubmit?.();}
      catch(err){
        error.textContent=err?.message||String(err);
        error.classList.remove('hidden');
      }finally{submit.disabled=false;}
    };
    const first=form.querySelector('input,select,textarea');
    if(first&&typeof first.focus==='function')first.focus();
    return root;
  }
  function revisionPayload(quote,items,residuals,today){
    if(!quote || quote.status==='draft')throw new Error('この見積は改訂対象ではありません。');
    if(!Array.isArray(items)||items.length===0)throw new Error('見積明細がありません。');
    const itemKeys=['product_id','description','manufacturer','supplier_name','unit','quantity','unit_price','cost_price','procurement_target','expected_delivery_date'];
    const residualKeys=['old_property_name','lessor_name','contract_number','remaining_count','monthly_amount_tax_included','residual_amount_tax_included','settlement_amount_tax_included','reflection_amount','payment_count','first_payment_amount','recurring_payment_amount','note'];
    const pick=(obj,keys)=>Object.fromEntries(keys.map(key=>[key,obj[key]??null]));
    return {
      p_customer_id:quote.customer_id,
      p_quote_date:today,
      p_valid_until:null,
      p_project_name:quote.project_name||null,
      p_honorific:quote.honorific||'御中',
      p_contact_name:quote.contact_name||null,
      p_lease_months:quote.lease_months??null,
      p_tax_rate:quote.tax_rate??10,
      p_internal_note:'元見積: '+(quote.quote_number||quote.id)+' / 改訂用の新しい下書き\n'+(quote.internal_note||''),
      p_items:items.map(item=>pick(item,itemKeys)),
      p_residual_items:(residuals||[]).map(item=>pick(item,residualKeys))
    };
  }
  window.openModal=openModal;
  window.closeModal=closeModal;
  window.QuoteFlowQuoteRevision={buildPayload:revisionPayload};
})();
