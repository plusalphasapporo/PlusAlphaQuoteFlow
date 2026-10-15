/**
 * CallConnect contact-memo deep-link regression tests.
 * Operates on actual QuoteFlow navigation handlers with mocked role-scoped
 * customer RPCs. No real customers, external calls or authentication tokens.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html=fs.readFileSync('index.html','utf8');
const edge=fs.readFileSync('supabase/functions/callconnect-contact-sync/index.ts','utf8');
const start=html.indexOf('  // The customer URL is a navigation hint, not an access token.');
const end=html.indexOf('  async function syncCustomerToCallConnect(',start);
const helperStart=html.indexOf('  async function showSupportCustomerDetail(');
const helperEnd=html.indexOf('  async function renderSupportCustomers()',helperStart);
assert.ok(start>=0&&end>start,'Customer deep-link logic exists');
assert.ok(helperStart>=0&&helperEnd>helperStart,'Role-scoped support customer renderer exists');
const source=html.slice(start,end);
const helper=html.slice(helperStart,helperEnd);
assert.match(html,/await startDeadlineWatch\(\);[\s\S]{0,220}await go\('home'\);[\s\S]{0,220}await openCallconnectCustomerDeepLink\(\);/,'Boot processes links after MFA');
assert.match(source,/if\(!role\) return false/,'Link waits for authentication');
assert.match(source,/!CALLCONNECT_CUSTOMER_ID_RE\.test\(id\)/);
assert.match(source,/await go\('customers'\)/);
assert.match(source,/await go\('support_customers'\)/);
assert.match(source,/removeCallconnectCustomerQuery\(\)/);
assert.match(helper,/rpc\('support_customer_context',\{p_customer_id:customerId\}\)/);
assert.match(edge,/form\.set\("memo",/);
assert.match(edge,/customerLink\.searchParams\.set\("qf_customer",String\(customer\.id\)\)/);
assert.match(edge,/QuoteFlow 顧客カルテ:/);
assert.match(edge,/QUOTEFLOW_CUSTOMER_LINK_ORIGIN/);
assert.match(edge,/res\.status===400&&msg\.includes\("登録済み"\)/,'Duplicate contacts are not overwritten');
assert.doesNotMatch(edge,/PUT.*\/v1\/contacts|PATCH.*\/v1\/contacts/,'Existing contacts must not be silently overwritten');

const customerId='91000000-0000-4000-8000-000000000001';
const otherId='92000000-0000-4000-8000-000000000002';
const stableOrigin='https://quoteflow-cloud-staging-git-5459e1-nijiiroclassflat-s-projects.vercel.app';
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function fixture(role,href,allowedId=customerId){
  const dom=new JSDOM('<!doctype html><html><body><main id="home"></main></body></html>',{
    url:href,runScripts:'outside-only'
  });
  const doc=dom.window.document;
  const visits=[],calls=[],toasts=[],warnings=[];
  const context={
    URL,window:dom.window,document:doc,
    bootData:role?{context:{role}}:null,
    $:q=>doc.querySelector(q),
    toast:msg=>toasts.push(msg),
    console:{warn:(...p)=>warnings.push(p.map(String).join(' '))},
    esc,
    statusText:()=> '対応中',
    dataTable:(headers,rows)=>'<table>'+rows.join('')+'</table>',
    pageIntro:()=>'<h1>顧客一覧</h1>',
    renderCustomerDetail:async(id,tab)=>{
      calls.push(['internal_detail',id,tab]);
      if(id!==allowedId)throw Error('unauthorized');
      doc.querySelector('#customerDetailHost').textContent='管理者向け顧客カルテ';
    },
    go:async page=>{
      visits.push(page);
      doc.querySelector('#home').innerHTML=page==='support_customers'
        ? '<div id="supportCustomerDetail"></div>'
        : page==='customers'?'<div id="customerDetailHost"></div>':'<div id="homeScreen"></div>';
      const host=doc.querySelector('#supportCustomerDetail');
      if(host)host.scrollIntoView=()=>{};
    },
    rpc:async(name,args)=>{
      calls.push([name,args?.p_customer_id]);
      assert.equal(name,'support_customer_context');
      if(args.p_customer_id!==allowedId)throw Error('not authorized');
      return {
        customer:{id:allowedId,name:'テスト顧客',phone:'000000'},
        assets:[{asset_number:'MOCK-A',model_name:'TEST',serial_number:'NONE',status:'active'}],
        tickets:[{ticket_number:'TKT-MOCK',subject:'仮の受付',status:'open',priority:'normal'}]
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(source+'\n'+helper+'\n globalThis.openDeepLink=openCallconnectCustomerDeepLink; globalThis.makeLink=callconnectCustomerLink;',context);
  return {dom,doc,context,visits,calls,toasts,warnings};
}

{
  const h=fixture(null,stableOrigin+'/?qf_customer='+customerId);
  assert.equal(await h.context.openDeepLink(),false,'Login must be completed first');
  assert.equal(h.visits.length,0);
  assert.equal(new URL(h.context.window.location.href).searchParams.get('qf_customer'),customerId);
  h.dom.window.close();
}
{
  const h=fixture('support_staff','https://quoteflow-cloud-staging-preview-123.vercel.app/?qf_customer='+customerId);
  const link=h.context.makeLink(customerId);
  assert.equal(link,stableOrigin+'/?qf_customer='+customerId);
  assert.equal(await h.context.openDeepLink(),true);
  assert.deepEqual(h.visits,['support_customers']);
  assert.ok(h.calls.some(x=>x[0]==='support_customer_context'&&x[1]===customerId));
  assert.match(h.doc.querySelector('#supportCustomerDetail').textContent,/テスト顧客/);
  assert.equal(new URL(h.context.window.location.href).searchParams.has('qf_customer'),false,'Consume after success');
  h.dom.window.close();
}
{
  const h=fixture('internal_admin',stableOrigin+'/?qf_customer='+customerId);
  assert.equal(await h.context.openDeepLink(),true);
  assert.deepEqual(h.visits,['customers']);
  assert.ok(h.calls.some(x=>x[0]==='internal_detail'&&x[1]===customerId));
  assert.equal(new URL(h.context.window.location.href).searchParams.has('qf_customer'),false);
  h.dom.window.close();
}
{
  const h=fixture('support_staff',stableOrigin+'/?qf_customer='+otherId,customerId);
  assert.equal(await h.context.openDeepLink(),false,'Support cannot view unassigned customers');
  assert.equal(h.doc.querySelector('#supportCustomerDetail').textContent,'');
  assert.equal(new URL(h.context.window.location.href).searchParams.get('qf_customer'),otherId,'Keep URL on network/authorization failure for retry');
  assert.match(h.toasts.join(' '),/開けませんでした/);
  h.dom.window.close();
}
{
  const h=fixture('customer_user',stableOrigin+'/?qf_customer='+customerId);
  assert.equal(await h.context.openDeepLink(),false);
  assert.equal(h.visits.length,0);
  assert.equal(new URL(h.context.window.location.href).searchParams.has('qf_customer'),false);
  h.dom.window.close();
}
{
  const h=fixture('internal_staff',stableOrigin+'/?qf_customer=javascript:alert(1)');
  assert.equal(await h.context.openDeepLink(),false);
  assert.equal(h.visits.length,0);
  assert.equal(new URL(h.context.window.location.href).searchParams.has('qf_customer'),false);
  h.dom.window.close();
}
{
  const h=fixture('internal_staff','https://quote.example.com/');
  assert.equal(h.context.makeLink(customerId),'https://quote.example.com/?qf_customer='+customerId);
  assert.throws(()=>h.context.makeLink('bad-id'));
  h.dom.window.close();
}


const contactMigration=fs.readFileSync('supabase/migrations/20261015043000_callconnect_contact_link_metadata.sql','utf8');
assert.match(contactMigration,/'contact_id',CASE WHEN cc\.contact_id ~/);
assert.match(html,/function callconnectContactConsoleUrl\(id\)/);
assert.match(html,/https:\/\/www\.callconnect\.jp\/console\/\?contacts\//);
assert.match(html,/callconnectContactOpen/);
assert.match(html,/callconnectCopyCustomerLink/);
assert.match(html,/class="linkBtn callconnectContactOpen"/);
assert.match(html,/class="linkBtn callconnectCopyCustomerLink"/);
assert.match(html,/navigator\.clipboard\.writeText\(callconnectCustomerLink\(btn\.dataset\.customerId\)\)/);
console.log('CallConnect 1-click links passed: staging alias, session/MFA gate, internal/support navigation, scoped access, safe invalid links, query cleanup and retry behavior.');
