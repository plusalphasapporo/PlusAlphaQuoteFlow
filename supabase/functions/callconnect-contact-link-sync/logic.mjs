// Deterministic CallConnect/QuoteFlow matching; no network or database access.
// Shared with Node regression tests and the Supabase Edge Function.
export const STAGING_ORIGIN='https://quoteflow-cloud-staging-git-5459e1-nijiiroclassflat-s-projects.vercel.app';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_ID=/^[1-9][0-9]{0,17}$/;
const LINK_MARKER='QuoteFlow 顧客カルテ:';
const CODE_MARKER='QuoteFlow 顧客番号:';
const MAX_MEMO_LENGTH=1800;

export function normalizePhone(value){
  let digits=String(value??'').replace(/[^0-9]/g,'');
  if(digits.startsWith('0081')&&(digits.length===14||digits.length===15))digits='0'+digits.slice(4);
  else if(digits.startsWith('81')&&(digits.length===12||digits.length===13))digits='0'+digits.slice(2);
  if(!/^0[0-9]{9,10}$/.test(digits))return null;
  return digits;
}
export function maskedPhone(phone){
  const v=String(phone||'');
  return v.length>4?'••••'+v.slice(-4):'—';
}
export function customerLink(id,origin=STAGING_ORIGIN){
  if(!UUID.test(String(id||'')))throw Error('invalid_customer_id');
  const base=new URL(origin);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||
     base.pathname!=='/'||!(base.hostname.endsWith('.vercel.app')||base.hostname.endsWith('.quoteflow.cloud'))){
    throw Error('invalid_origin');
  }
  const url=new URL('/',base);
  url.searchParams.set('qf_customer',id);
  return url.toString();
}
function uniquePhones(values){
  return [...new Set(values.map(normalizePhone).filter(Boolean))];
}
export function remotePhones(c){
  const sources=[c.friendly_number,c.number,c.phone,c.mobile];
  if(Array.isArray(c.numbers)) sources.push(...c.numbers.map(n=>typeof n==='object'?(n.number||n.friendly_number):n));
  return uniquePhones(sources);
}
export function buildIndex(customers,contacts){
  const byCustomer=new Map();
  const byPhone=new Map();
  for(const c of customers||[]){
    if(!UUID.test(String(c.id||'')))continue;
    byCustomer.set(String(c.id),c);
    for(const n of uniquePhones([c.phone,c.mobile])){
      if(!byPhone.has(n))byPhone.set(n,new Set());
      byPhone.get(n).add(String(c.id));
    }
  }
  for(const c of contacts||[]){
    if(c.active===false||!byCustomer.has(String(c.customer_id)))continue;
    for(const n of uniquePhones([c.phone,c.mobile_e164])){
      if(!byPhone.has(n))byPhone.set(n,new Set());
      byPhone.get(n).add(String(c.customer_id));
    }
  }
  return {byPhone,byCustomer};
}
function existingLinks(memo){
  const ids=[];
  const matcher=/[?&]qf_customer=([0-9a-f-]{36})/gi;
  for(let match;(match=matcher.exec(memo))!==null;)ids.push(match[1].toLowerCase());
  return [...new Set(ids)];
}
export function prepareMemo(existingMemo,customer,link){
  const original=String(existingMemo??'');
  const current=existingLinks(original);
  // Never rewrite another customer's link, nor malformed QuoteFlow references.
  if(current.length>1||current.some(x=>x!==String(customer.id).toLowerCase()))
    return {status:'conflict_link',memo:null};
  if(current.length===1) return {status:'already_linked',memo:null};
  if(original.includes(LINK_MARKER)||original.includes('qf_customer='))
    return {status:'conflict_link',memo:null};
  const separator=original.trim()?'\n':'';
  const memo=original+separator+CODE_MARKER+' '+String(customer.customer_code||'未採番')+
    '\n'+LINK_MARKER+' '+link;
  if(memo.length>MAX_MEMO_LENGTH) return {status:'memo_too_long',memo:null};
  return {status:'eligible',memo};
}
export function buildPlan(remoteContacts,customers,localContacts,origin=STAGING_ORIGIN){
  const {byPhone,byCustomer}=buildIndex(customers,localContacts);
  const prepared=(remoteContacts||[]).map(c=>({
    source:c,
    id:String(c.id??'').trim(),
    numbers:remotePhones(c)
  }));
  const remoteNumberOwners=new Map();
  for(const c of prepared){
    for(const p of c.numbers){
      if(!remoteNumberOwners.has(p))remoteNumberOwners.set(p,new Set());
      remoteNumberOwners.get(p).add(c.id);
    }
  }
  return prepared.map(c=>{
    const item={
      contact_id:c.id,contact_name:String(c.source.name||c.source.company||'').slice(0,120),
      masked_phone:maskedPhone(c.numbers[0]),customer_id:null,customer_name:null,
      customer_code:null,status:'unmatched',existing_memo:String(c.source.memo??''),
      next_memo:null,link:null,phones:c.numbers
    };
    if(!REMOTE_ID.test(c.id)){item.status='invalid_contact_id';return item;}
    if(!c.numbers.length){item.status='no_phone';return item;}
    if(c.numbers.some(p=>(remoteNumberOwners.get(p)?.size||0)>1)){
      item.status='duplicate_remote_phone';return item;
    }
    const matches=new Set();
    for(const n of c.numbers)for(const id of byPhone.get(n)||[])matches.add(id);
    if(!matches.size){item.status='unmatched';return item;}
    if(matches.size!==1){item.status='ambiguous_customer';return item;}
    const customer=byCustomer.get([...matches][0]);
    if(!customer){item.status='unmatched';return item;}
    item.customer_id=String(customer.id);
    item.customer_name=String(customer.name||'').slice(0,140);
    item.customer_code=String(customer.customer_code||'').slice(0,80);
    item.link=customerLink(item.customer_id,origin);
    const memo=prepareMemo(item.existing_memo,customer,item.link);
    item.status=memo.status;
    item.next_memo=memo.memo;
    return item;
  });
}
export function publicPlanItem(x){
  const {contact_id,contact_name,masked_phone,customer_id,customer_name,customer_code,status}=x;
  return {contact_id,contact_name,masked_phone,customer_id,customer_name,customer_code,status};
}
export function summarize(plan){
  const counts={eligible:0,already_linked:0,conflict_link:0,ambiguous_customer:0,
    duplicate_remote_phone:0,unmatched:0,no_phone:0,invalid_contact_id:0,memo_too_long:0};
  for(const item of plan)counts[item.status]=(counts[item.status]||0)+1;
  return counts;
}
