import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function mount(handlers={},role='internal_staff'){
  const source=readFileSync('assets/deal-customer-step.js','utf8');
  const host={innerHTML:''};
  const ids=['dealCustomerChoice','dealCustomerSearch','dealCustomerInfo','dealCustomerContact','dealCustomerInstallation','dealCustomerNext','dealCustomerNew','dealCustomerMsg'];
  const nodes=Object.fromEntries(ids.map(id=>[id,{value:'',innerHTML:'',textContent:'',style:{},className:'',disabled:false,options:[],classList:{add(){},remove(){}}}]));
  const document={getElementById:id=>nodes[id]||null};
  const window={};runInNewContext(source,{window,document,console});
  const customers=[
    {id:'head-1',name:'本店',branch_type:'head_office',customer_code:'C01',status:'active'},
    {id:'branch-1',name:'第一支店',branch_type:'branch',parent_customer_id:'head-1',customer_code:'C02',status:'active'},
    {id:'branch-2',name:'第二支店',branch_type:'branch',parent_customer_id:'head-1',customer_code:'C03',status:'active'}
  ];
  const calls=[];
  const rpc=async(name,args)=>{
    calls.push({name,args});
    if(handlers[name])return handlers[name](args,customers);
    if(name==='internal_customers_list')return customers;
    if(name==='internal_customer_detail')return customers.find(c=>c.id===args.p_customer_id);
    if(name==='internal_customer_contacts')return [{id:'contact-1',customer_id:args.p_customer_id,name:'担当',active:true}];
    throw Error('unexpected RPC '+name);
  };
  const api=window.QuoteFlowDealCustomerStep;
  api.configure({getRole:()=>role,rpc,getHost:()=>host,
    openCustomerCreate:handlers.openCustomerCreate||(()=>{}),
    createQuote:handlers.createQuote||(()=>{})});
  return {api,nodes,host,customers,calls};
}
test('new customer creation returns to customer confirmation with the newly created account selected',async()=>{
  let capturedCallback;
  const f=mount({openCustomerCreate:async({onCreated})=>{
    capturedCallback=onCreated;
  }});
  await f.api.open();
  await f.nodes.dealCustomerNew.onclick();
  assert.equal(typeof capturedCallback,'function','new customer flow must accept an onCreated callback');
  f.customers.push({id:'brand-new',name:'新規顧客',customer_code:'C04',branch_type:'head_office',status:'active'});
  await capturedCallback('brand-new');
  assert.match(f.host.innerHTML,/brand-new" selected/);
  assert.match(f.nodes.dealCustomerInfo.innerHTML,/新規顧客/);
});
test('old slow contact lookup never replaces options for the currently selected branch',async()=>{
 let unblockOld;
 const oldContacts=new Promise(resolve=>unblockOld=resolve);
 const f=mount({internal_customer_contacts:async({p_customer_id})=>
 p_customer_id==='branch-1'?oldContacts:[{id:'c2',name:'支店2担当',customer_id:'branch-2',active:true}]});
 await f.api.open();
 const choice=f.nodes.dealCustomerChoice,contact=f.nodes.dealCustomerContact;
 choice.value='branch-1';const first=choice.onchange();
 choice.value='branch-2';await choice.onchange();
 unblockOld([{id:'c1',name:'支店1担当',customer_id:'branch-1',active:true}]);
 await first;
 assert.match(contact.innerHTML,/支店2担当/);
 assert.doesNotMatch(contact.innerHTML,/支店1担当/);
});
test('an RPC error is visible and does not appear as a valid empty contact list',async()=>{
 const f=mount({internal_customer_contacts:async()=>{throw Error('顧客担当者の取得に失敗');}});
 await f.api.open();
 f.nodes.dealCustomerChoice.value='branch-1';
 await f.nodes.dealCustomerChoice.onchange();
 assert.match(f.nodes.dealCustomerMsg.textContent,/顧客担当者の取得に失敗/);
 assert.equal(f.nodes.dealCustomerNext.disabled,true);
});
test('invalid customer input is explained inline, with no quote submission',async()=>{
 let created=0;
 const f=mount({createQuote:async()=>{created++}});
 await f.api.open();
 f.nodes.dealCustomerChoice.value='';
 await f.nodes.dealCustomerNext.onclick();
 assert.match(f.nodes.dealCustomerMsg.textContent,/顧客を選択/);
 assert.equal(created,0);
});
test('inactivated contact cannot be carried to a new quote',async()=>{
 const f=mount({internal_customer_contacts:async()=>[{id:'inactive',customer_id:'branch-1',name:'退職者',active:false}]});
 await f.api.open();
 await assert.rejects(()=>f.api.confirm({customerId:'branch-1',contactId:'inactive'}),/担当者/);
});
test('existing quote modal remains tied to the confirmed customer after a draft reset',()=>{
 const html=readFileSync('index.html','utf8');
 assert.match(html,/async function renderCustomerCreate\(onCreated=null\)/);
 assert.match(html,/if\(created\?\.id && typeof onCreated==='function'\)/);
 assert.match(html,/renderCustomerQuoteCreate\(preselectedCustomerId,customerContext/);
 assert.match(html,/customerContext\?\.customerId[\s\S]*?quoteCreateCustomer'\)\.disabled\s*=\s*true/);
});
