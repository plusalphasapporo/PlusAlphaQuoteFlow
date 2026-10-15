import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync('index.html','utf8');
const begin=html.indexOf('  async function renderCustomers(){');
const end=html.indexOf('  async function customerMap(){',begin);
assert.ok(begin>=0&&end>begin,'customer list renderer is present');
const rendererSource=html.slice(begin,end);

const customers=[
  {id:'head',customer_code:'PA-0001',name:'札幌本店',name_kana:'サッポロホンテン',branch_type:'head_office',
   representative_name:'北村 代表',phone:'011-222-3333',email:'head@example.jp',
   address1:'札幌市中央区大通西1丁目',postal_code:'0600001',sales_owner_name:'佐藤',
   customer_type:'corporation',status:'active',updated_at:'2026-10-15'},
  {id:'branch',customer_code:'PA-0002',name:'札幌北支店',branch_type:'branch',parent_customer_id:'head',
   representative_name:'鈴木 代表',phone:'011-999-0000',email:'branch@example.jp',
   address1:'札幌市北区北1条',sales_owner_name:'高橋',status:'active',updated_at:'2026-10-14'}
];

function makeEnvironment(){
 const nodes=new Map();
 const $=selector=>{
   if(!nodes.has(selector)){
     nodes.set(selector,{innerHTML:'',value:'',textContent:'',dataset:{active:'all'},disabled:false,onclick:null,oninput:null,onchange:null});
   }
   return nodes.get(selector);
 };
 const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
 let calls=0;
 const ctx={
   $,
   document:{querySelectorAll:()=>[]},
   rpc:async(name)=>{assert.equal(name,'internal_customers_list');calls++;return customers;},
   esc:escape,
   pageIntro:(title,desc)=>'<header>'+escape(title)+' '+escape(desc)+'</header>',
   listToolbar:()=>'<div>toolbar</div>',
   listToolbarState:()=>({status:'all',query:$('#customerListSearch').value.toLowerCase(),sort:$('#customerListSort').value||'updated_desc'}),
   updateListCount:(prefix,shown,total)=>$('#customerListCount').textContent=shown+' / '+total,
   dataTable:(headers,rows)=>'<table><thead>'+headers.join('|')+'</thead><tbody>'+rows.join('')+'</tbody></table>',
   statusText:s=>s==='active'?'有効':s,
   dateText:s=>String(s||'').slice(0,10)||'—',
   compareText:(a,b)=>String(a||'').localeCompare(String(b||''),'ja'),
   timeValue:s=>new Date(s||0).getTime(),
   bindListToolbar:(prefix,renderRows)=>{ $('#customerListSearch').oninput=renderRows; $('#customerListSort').onchange=renderRows; },
   renderCustomerDetail:async()=>{},
   renderCustomerCreate:async()=>{},
   console
 };
 vm.runInNewContext(rendererSource+';globalThis.testRenderCustomers=renderCustomers;',ctx);
 return {$,run:ctx.testRenderCustomers,calls:()=>calls};
}

test('customer cards show basic contact, address, representative, and branch before opening a chart',async()=>{
 const env=makeEnvironment();
 await env.run();
 const cards=env.$('#customerListHost').innerHTML;
 assert.match(cards,/customerDirectoryCard/,'customer list defaults to readable cards');
 assert.match(cards,/PA-0001/);
 assert.match(cards,/札幌市中央区大通西1丁目/,'address visible without opening details');
 assert.match(cards,/北村 代表/,'representative visible without opening details');
 assert.match(cards,/011-222-3333/,'phone visible without opening details');
 assert.match(cards,/head@example\.jp/,'email visible without opening details');
 assert.match(cards,/本店.*33件|支店\s*1件/s,'head office shows linked branch count');
 assert.match(cards,/PA-0001.*札幌本店/s,'branch shows linked head-office identity');
 assert.equal(env.calls(),1,'only one bulk customer API call');
});

test('customer cards can switch to dense list without losing search',async()=>{
 const env=makeEnvironment();
 await env.run();
 assert.match(env.$('#home').innerHTML,/customerViewTable/,'table view selector exists');
 env.$('#customerListSearch').value='011-999-0000';
 env.$('#customerListSearch').oninput();
 assert.doesNotMatch(env.$('#customerListHost').innerHTML,/札幌本店/);
 assert.match(env.$('#customerListHost').innerHTML,/札幌北支店/);
 env.$('#customerViewTable').onclick();
 const table=env.$('#customerListHost').innerHTML;
 assert.match(table,/<table>/,'dense list is available');
 assert.match(table,/札幌北支店/);
 assert.match(table,/札幌市北区北1条/,'dense list still shows the address');
 assert.doesNotMatch(table,/札幌本店/,'search is preserved during view switch');
});

test('customer chart surfaces read-only customer facts before support KPIs',()=>{
 const from=html.indexOf("  async function renderCustomerDetail(customerId,tab='overview')");
 const to=html.indexOf("      $('#customerDetailClose').onclick",from);
 const detail=html.slice(from,to);
 const bodyStart=detail.indexOf("'<div id=\"customerUnifiedTabBody\">'");
 assert.ok(bodyStart>=0,'customer overview body exists');
 const body=detail.slice(bodyStart);
 assert.match(body,/customerIdentitySummary/,'read-only basic information is prominent');
 assert.ok(body.indexOf('customerIdentitySummary')<body.indexOf('kpis(['),'customer identity precedes support KPIs');
 assert.match(body,/代表者/);
 assert.match(body,/所在地/);
 assert.match(body,/主担当者/);
 assert.match(body,/所属する本店|本店・本社/);
});

test('basic information edit action opens and scrolls to the editing form',()=>{
 const start=html.indexOf("$('#customerOverviewEditToggle').onclick=");
 assert.ok(start>=0);
 const handler=html.slice(start,start+480);
 assert.match(handler,/scrollIntoView/,'edit action must bring the distant form into view');
 assert.match(handler,/customerOverviewEditBox/);
});
