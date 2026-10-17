import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const text=readFileSync('assets/deal-customer-step.js','utf8');
const make=()=>{const window={};runInNewContext(text,{window,document:{getElementById:()=>null}});return window.QuoteFlowDealCustomerStep};
const records=[{id:'h',name:'本店',customer_code:'C01',branch_type:'head_office',status:'active'},
{id:'b',name:'支店',customer_code:'C02',branch_type:'branch',parent_customer_id:'h',status:'active'},
{id:'x',name:'別社',customer_code:'C03',branch_type:'head_office',status:'active'},
{id:'hold',name:'取引停止',branch_type:'head_office',status:'inactive'}];
test('selected customer and branch are preserved and linked to parent',async()=>{
 const m=make();const calls=[];m.configure({getRole:()=> 'internal_staff',rpc:async(n,a)=>{calls.push(n);if(n==='internal_customers_list')return records;if(n==='internal_customer_detail')return records.find(r=>r.id===a.p_customer_id);if(n==='internal_customer_contacts')return [{id:'c',customer_id:'b',name:'担当'}]},getHost:()=>({innerHTML:''}),createQuote:async x=>calls.push(x)});
 await m.open();const c=await m.confirm({customerId:'b',contactId:'c',installationAddress:'支店2階'});
 assert.equal(c.customerId,'b');assert.equal(c.parentCustomerId,'h');assert.equal(c.installationAddress,'支店2階');
 await m.proceed(c);assert.equal(calls.at(-1).preselectedCustomerId,'b');
});
test('rejects missing, invalid, on-hold or cross-customer contact',async()=>{
 const m=make();m.configure({getRole:()=> 'internal_staff',rpc:async(n,a)=>n==='internal_customers_list'?records:n==='internal_customer_detail'?records.find(r=>r.id===a.p_customer_id):[{id:'else',customer_id:'x'}],getHost:()=>({innerHTML:''}),createQuote:async()=>{}});
 await m.open();for(const customerId of ['', 'missing','hold'])await assert.rejects(()=>m.confirm({customerId}));
 await assert.rejects(()=>m.confirm({customerId:'b',contactId:'else'}));
});
test('role cannot fetch sales customers or proceed as support company',async()=>{
 const m=make();let calls=0;m.configure({getRole:()=> 'support_staff',rpc:async()=>{calls++;},getHost:()=>({innerHTML:''})});await assert.rejects(()=>m.open(),/社内/);assert.equal(calls,0);
});
test('page loads customer-first script and sale route',()=>{
 const html=readFileSync('index.html','utf8');
 assert.match(html,/assets\/deal-customer-step\.js/);
 assert.match(html,/window\.QuoteFlowDealCustomerStep\?\.configure/);
 assert.match(html,/renderCustomerQuoteCreate\(preselectedCustomerId,customerContext/);
});

test('clearing a confirmed quote reloads the fixed customer, contact and installation before it can be saved',()=>{
 const html=readFileSync('index.html','utf8');
 const clear=html.match(/\$\('#quoteCreateDraftClear'\)\.onclick=async\(\)=>\{([\s\S]*?)\n    \};/);
 assert.ok(clear,'clear handler exists and awaits customer restore');
 assert.match(clear[1],/form\.reset\(\)/);
 assert.match(clear[1],/if\(preselectedCustomerId\)\s*\{\s*try\{await loadConfirmedCustomer\(\)/);
 assert.match(html,/const loadConfirmedCustomer=async\(\)=>\{/);
 assert.match(html,/if\(preselectedCustomerId\) \$\('#quoteCreateCustomer'\)\.value=preselectedCustomerId/);
 assert.match(html,/customerContext\?\.contactId/);
 assert.match(html,/customerContext\?\.installationAddress/);
});

test('customer detail and transaction pages use the confirmed customer-first quote path',()=>{
 const html=readFileSync('index.html','utf8');
 for(const [label,source] of [
  ['customer detail',"$('#customerQuoteCreateBtn').onclick=()=>window.QuoteFlowDealCustomerStep.open({preselectedCustomerId:c.id})"],
  ['customer overview',"$('#customerOverviewNewQuote').onclick=()=>window.QuoteFlowDealCustomerStep.open({preselectedCustomerId:customerId})"],
  ['customer transactions',"newQuoteBtn.onclick=()=>window.QuoteFlowDealCustomerStep.open({preselectedCustomerId:customerId})"]
 ]){
  assert.ok(html.includes(source),label+' should require customer confirmation before quote registration');
 }
 assert.doesNotMatch(html,/\$\('#customerQuoteCreateBtn'\)\.onclick=\(\)=>renderCustomerQuoteCreate\(c\.id\)/);
 assert.doesNotMatch(html,/\$\('#customerOverviewNewQuote'\)\.onclick=\(\)=>renderCustomerQuoteCreate\(customerId\)/);
 assert.doesNotMatch(html,/newQuoteBtn\.onclick=\(\)=>renderCustomerQuoteCreate\(customerId\)/);
 assert.match(html,/const linked=await window\.QuoteFlowDeals\.linkQuote\(createdQuote\.id\)/);
});
