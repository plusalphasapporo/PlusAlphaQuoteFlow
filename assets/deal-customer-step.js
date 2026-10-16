(function(){
'use strict';
let deps,customers=[],requestVersion=0;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const role=()=>{if(!['internal_admin','internal_staff'].includes(deps?.getRole?.()))throw Error('社内職員のみ利用できます');};
function configure(v){deps=v;}
async function open({preselectedCustomerId=null}={}){
 role();customers=await deps.rpc('internal_customers_list')||[];
 const host=deps.getHost();
 host.innerHTML='<section class="card section"><h2>① 顧客情報確認</h2><p>本支店・連絡先・担当者・設置場所を確認し、見積へ進みます。</p>'+
 '<div class="field"><label>顧客検索</label><input id="dealCustomerSearch" placeholder="顧客番号・会社名・本支店"></div>'+
 '<div class="field"><label>顧客</label><select id="dealCustomerChoice"><option value="">選択してください</option>'+customers.map(c=>'<option value="'+esc(c.id)+'"'+(c.id===preselectedCustomerId?' selected':'')+'>'+esc(c.customer_code||'')+' / '+esc(c.name)+'</option>').join('')+'</select></div>'+
 '<div id="dealCustomerInfo"></div><div id="dealCustomerMsg" class="notice" role="alert"></div><div class="field"><label>担当者</label><select id="dealCustomerContact"><option value="">指定なし</option></select></div>'+
 '<div class="field"><label>設置場所・階数（任意）</label><input id="dealCustomerInstallation" placeholder="例：本店3階"></div>'+
 '<div class="row"><button class="ghost" id="dealCustomerNew" type="button">新規顧客登録</button><button class="primary" id="dealCustomerNext" type="button">この顧客で見積へ進む</button></div></section>';
 const $=id=>document.getElementById(id);
 const msg=$('dealCustomerMsg');
 const notify=message=>{if(msg)msg.textContent=message||'';};
 const next=$('dealCustomerNext');
 const choice=$('dealCustomerChoice'),search=$('dealCustomerSearch');
 if(choice&&preselectedCustomerId)choice.value=preselectedCustomerId;
 if(choice){
  choice.onchange=async()=>{const id=choice.value,version=++requestVersion;const rec=customers.find(c=>c.id===id);const info=$('dealCustomerInfo');const contact=$('dealCustomerContact');
   notify('');if(next)next.disabled=true;
   if(info)info.innerHTML=rec?'<div class="notice">顧客番号: '+esc(rec.customer_code)+'　会社名: '+esc(rec.name)+'<p>本支店: '+esc(rec.branch_type==='branch'?'支店・営業所':'本店')+' / 親顧客: '+esc(customers.find(c=>c.id===rec.parent_customer_id)?.name||'—')+'</p><p>連絡先: '+esc(rec.phone||rec.mobile||'未登録')+'　'+esc(rec.email||'')+'</p><p>住所: '+esc([rec.address1,rec.address2].filter(Boolean).join(' ')||'未登録')+'</p><p>営業担当: '+esc(rec.sales_owner_name||'未登録')+'</p></div>':'';
   if(contact)contact.innerHTML='<option value="">指定なし</option>';
   if(!rec)return;
   try{const all=await deps.rpc('internal_customer_contacts',{p_customer_id:id})||[];
     if(version!==requestVersion||choice.value!==id)return;
     if(contact)contact.innerHTML+=[...all].filter(c=>c.customer_id===id&&c.active!==false).map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('');
     if(next)next.disabled=false;
   }catch(error){if(version===requestVersion){notify(error.message||String(error));if(next)next.disabled=true;}}
  };
  if(preselectedCustomerId)await choice.onchange();
 }
 if(search&&choice)search.oninput=()=>{const q=search.value.toLowerCase();for(const option of choice.options){if(!option.value)continue;const c=customers.find(x=>x.id===option.value);option.hidden=!([c?.name,c?.customer_code,c?.address1,customers.find(x=>x.id===c?.parent_customer_id)?.name].some(x=>String(x||'').toLowerCase().includes(q)));}};
 if(next)next.onclick=async()=>{try{notify('');next.disabled=true;const result=await confirm({customerId:choice?.value,contactId:$('dealCustomerContact')?.value||null,installationAddress:$('dealCustomerInstallation')?.value||null});await proceed(result);}catch(error){notify(error.message||String(error));}finally{next.disabled=false;}};
 const create=$('dealCustomerNew');if(create)create.onclick=()=>deps.openCustomerCreate?.({onCreated:async createdId=>{await open({preselectedCustomerId:createdId});}});
 return customers;
}
async function confirm({customerId,contactId=null,installationAddress=null}={}){
 role();
 if(!customerId)throw Error('顧客を選択してください');
 let record=customers.find(c=>c.id===customerId);
 if(!record)throw Error('顧客が存在しません');
 const current=await deps.rpc('internal_customer_detail',{p_customer_id:customerId});
 if(!current||current.id!==customerId)throw Error('顧客の確認に失敗しました');
 if(current.manual_hold||current.status==='inactive'||current.status==='suspended')throw Error('取引停止中の顧客です');
 if(current.branch_type==='branch'&&(!current.parent_customer_id||!customers.some(c=>c.id===current.parent_customer_id&&c.branch_type==='head_office')))throw Error('本支店の紐づけを確認してください');
 if(contactId){const contacts=await deps.rpc('internal_customer_contacts',{p_customer_id:customerId})||[];if(!contacts.some(x=>x.id===contactId&&x.customer_id===customerId&&x.active!==false))throw Error('担当者が選択顧客に属していません');}
 return {customerId,contactId,installationAddress:String(installationAddress||'').trim()||null,parentCustomerId:current.parent_customer_id||null};
}
async function proceed(customerContext){role();if(!customerContext?.customerId)throw Error('顧客選択が必要です');return deps.createQuote({preselectedCustomerId:customerContext.customerId,customerContext});}
window.QuoteFlowDealCustomerStep={configure,open,confirm,proceed};
})();