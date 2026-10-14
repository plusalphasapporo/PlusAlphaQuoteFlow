/**
 * Regression checks for the ticket's customer/device modal and its
 * Microsoft 365 folder shortcut.
 *
 * Uses the actual Edge Function code with synthetic requests and a local
 * jsdom UI. No live user data, Graph, Supabase or browser credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { JSDOM } from 'jsdom';

const ui = fs.readFileSync('index.html', 'utf8');
function extract(start, end) {
  const from = ui.indexOf(start);
  const to = ui.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'Missing original UI source: ' + start);
  return ui.slice(from, to);
}
const modalFns = extract(
  '  function closeAppModal(){',
  '\n  function localDateValue('
);
const ticketPanel = extract(
  '    const openTicketCustomerPanel=()=>{',
  '\n    const ticketCallAiSummary='
);
assert.match(ui, /if\(actionCustomer\) actionCustomer\.onclick=openTicketCustomerPanel;/);
assert.match(ui, /if\(linearCustomer\) linearCustomer\.onclick=openTicketCustomerPanel;/);
assert.match(ui, /if\(customerBtn\) customerBtn\.onclick=openTicketCustomerPanel;/);
assert.match(ui, /if\(topCustomer\) topCustomer\.onclick=openTicketCustomerPanel;/);
assert.match(ui, /if\(customerJump\) customerJump\.onclick=openTicketCustomerPanel;/);
assert.match(ticketPanel, /get_quick_link/);
assert.match(ticketPanel, /noopener noreferrer/);
assert.doesNotMatch(ticketPanel, /await go\(|renderCustomerDetail\(/);

const ticketId='22222222-2222-4222-8222-222222222222';
const otherTicketId='44444444-4444-4444-8444-444444444444';
const customerId='33333333-3333-4333-8333-333333333333';
const otherCustomerId='55555555-5555-4555-8555-555555555555';
const userId='11111111-1111-4111-8111-111111111111';
const trustedFolderUrl='https://tenant.sharepoint.com/sites/support/Shared%20Documents/CustomerA';

const edgeSource = fs.readFileSync('supabase/functions/customer-onedrive/index.ts', 'utf8');
assert.match(edgeSource, /withSupabase\(\{\s*auth:\s*'user'\s*\}/);
assert.match(edgeSource, /if \(action === 'get_quick_link'\)/);
let edgeScript = edgeSource
  .replace("import { withSupabase } from 'npm:@supabase/server'",
           'const withSupabase = (_options, handler) => handler')
  .replace('export default {', 'globalThis.__customerFolder = {');
assert.notEqual(edgeScript, edgeSource);
edgeScript = stripTypeScriptTypes(edgeScript);

const state = {
  profiles: [{user_id:userId, role:'support_staff', is_active:true}],
  customers: [
    {id:customerId, name:'株式会社アクメ設備', customer_code:'AC-001'},
    {id:otherCustomerId, name:'別の顧客', customer_code:'OT-002'}
  ],
  support_tickets: [
    {id:ticketId, customer_id:customerId},
    {id:otherTicketId, customer_id:otherCustomerId}
  ],
  customer_onedrive_folders: [
    {customer_id:customerId, web_url:trustedFolderUrl, folder_name:'アクメ設備'}
  ],
  m365_customer_folder_roots: [{root_key:'customer_data',drive_id:'drive-1',item_id:'root-1'}],
  accessibleTickets: new Set([ticketId]),
  graphChildren:[],
  graphError:false,
  graphRequests:[],
  databaseWrites:0
};

function tableBuilder(table, scope) {
  assert.ok(Object.hasOwn(state, table), 'Unknown mock table: ' + table);
  const conditions=[];
  const builder={
    select() { return builder; },
    eq(field, expected) {
      conditions.push(row => row[field] === expected);
      return builder;
    },
    async single() {
      const record=state[table].find(row => conditions.every(fn => fn(row)));
      if (!record || (scope==='user' && table==='support_tickets' && !state.accessibleTickets.has(record.id))) {
        return {data:null,error:{message:'not found or forbidden'}};
      }
      return {data:record,error:null};
    },
    async maybeSingle() {
      const record=state[table].find(row => conditions.every(fn => fn(row)));
      return {data:record||null,error:null};
    },
    async insert() { state.databaseWrites++; throw new Error('Read-only shortcut must not insert'); },
    async upsert() { state.databaseWrites++; throw new Error('Read-only shortcut must not upsert'); },
    async update() { state.databaseWrites++; throw new Error('Read-only shortcut must not update'); },
    async delete() { state.databaseWrites++; throw new Error('Read-only shortcut must not delete'); }
  };
  return builder;
}
const ctx = {
  jwtClaims: { sub:userId,aal:'aal2' },
  supabase: { from:table => tableBuilder(table,'user') },
  supabaseAdmin: { from:table => tableBuilder(table,'admin') }
};
async function fakeGraphFetch(url) {
  state.graphRequests.push(url);
  if (url.startsWith('https://login.microsoftonline.com/')) {
    return Response.json({access_token:'SYNTHETIC_TOKEN'});
  }
  assert.match(url,/^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\//);
  if (state.graphError) return Response.json({error:{message:'synthetic failure'}},{status:503});
  return Response.json({value:state.graphChildren});
}
const backend = {
  Response, URL, URLSearchParams, console,
  Deno:{env:{get:key=>({
    MICROSOFT_TENANT_ID:'synthetic-tenant',
    MICROSOFT_CLIENT_ID:'synthetic-client',
    MICROSOFT_CLIENT_SECRET:'synthetic-secret'
  })[key]||''}},
  fetch:fakeGraphFetch
};
vm.runInNewContext(edgeScript, backend);
assert.equal(typeof backend.__customerFolder?.fetch, 'function');
async function request(body, overrides={}) {
  if(overrides.role!==undefined) state.profiles[0].role=overrides.role;
  if(overrides.aal!==undefined) ctx.jwtClaims.aal=overrides.aal;
  const resp=await backend.__customerFolder.fetch({
    method:'POST',
    headers:{get(){return null;}},
    async json(){return body;}
  },ctx);
  return {status:resp.status,body:await resp.json()};
}
const quickRequest={action:'get_quick_link',customerId,ticketId};

let result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.linked,true);
assert.equal(result.body.webUrl,trustedFolderUrl);
assert.equal(result.body.source,'mapped');
assert.equal(state.graphRequests.length,0,'Mapped folder lookup should not contact Graph');
assert.doesNotMatch(JSON.stringify(result.body),/SYNTHETIC_TOKEN|drive-1|root-1/);

result=await request({...quickRequest,customerId:otherCustomerId});
assert.equal(result.status,404,'A customer not on the ticket must not be accessible');
assert.equal(result.body.error,'TICKET_NOT_FOUND_OR_FORBIDDEN');

result=await request({...quickRequest,ticketId:otherTicketId,customerId:otherCustomerId});
assert.equal(result.status,404,'Unauthorized ticket must not reveal the folder');

result=await request({...quickRequest,ticketId:'not-a-uuid'});
assert.equal(result.status,400,'Malformed ticket must be rejected');

result=await request(quickRequest,{role:'customer_user'});
assert.equal(result.status,403,'Customers must not use internal folder shortcut');

result=await request(quickRequest,{role:'support_staff',aal:'aal1'});
assert.equal(result.status,403,'MFA must be required');
ctx.jwtClaims.aal='aal2';

result=await request({action:'get_folder',customerId});
assert.equal(result.status,403,'Support cannot access the full M365 folder contents API');

result=await request({action:'get_quick_link',customerId},{role:'internal_staff'});
assert.equal(result.status,200,'Internal user can open a mapped folder');
assert.equal(result.body.webUrl,trustedFolderUrl);

state.profiles[0].role='support_staff';
state.customer_onedrive_folders[0].web_url='https://tenant.sharepoint.com.attacker.invalid/folder';
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.linked,false,'Unsafe stored links must fail closed');
assert.ok(!result.body.webUrl);
state.customer_onedrive_folders=[];

state.graphChildren=[
  {id:'folder-a',name:'アクメ設備',folder:{childCount:1},webUrl:trustedFolderUrl}
];
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.linked,true,'Unique exact normalized name should resolve');
assert.equal(result.body.source,'unique_exact_match');
assert.equal(result.body.webUrl,trustedFolderUrl);
assert.equal(state.databaseWrites,0,'Fallback must not silently change mappings');

state.graphChildren.push({
  id:'folder-b',name:'株式会社アクメ設備',folder:{childCount:1},
  webUrl:'https://tenant.sharepoint.com/sites/support/Shared%20Documents/Other'
});
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.linked,false,'Ambiguous exact matches must require a human link');
assert.equal(result.body.reason,'needs_manual_link');

state.graphChildren=[{
  id:'folder-c',name:'アクメ設備・東京',folder:{childCount:1},webUrl:trustedFolderUrl
}];
result=await request(quickRequest);
assert.equal(result.body.linked,false,'Loose name match must not expose another folder');

state.graphError=true;
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.reason,'folder_lookup_unavailable');
state.graphError=false;
const savedEnv=backend.Deno.env.get;
backend.Deno.env.get=key=>key==='MICROSOFT_CLIENT_SECRET'?'':savedEnv(key);
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.reason,'integration_not_configured');
backend.Deno.env.get=savedEnv;

state.m365_customer_folder_roots=[];
result=await request(quickRequest);
assert.equal(result.status,200);
assert.equal(result.body.reason,'root_not_configured');
assert.equal(state.databaseWrites,0);
console.log('M365 folder shortcut Edge Function tests passed: ticket ACL, MFA, tenant boundary, safe URL, exact matching, ambiguity and no writes.');

// Exercise the exact modal implementation using a browser-like document. The
// application itself must keep the original ticket node and its unsent draft.
const safeEsc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function uiHarness(reply) {
  const dom=new JSDOM('<!doctype html><html><body><main id="home"><div id="ticketDetailHost"><div id="ticketExisting"><textarea id="ticketMessageBody"></textarea><button id="ticketActionCustomer">顧客・機器</button></div></div></main></body></html>', {
    url:'https://quote-flow-preview.example/',runScripts:'outside-only'
  });
  const doc=dom.window.document;
  const calls=[];
  const ctx={
    document:doc,window:dom.window,URL,
    $:selector=>doc.querySelector(selector),
    esc:safeEsc,
    t:{id:ticketId,customer_id:customerId,ticket_number:'TKT-001'},
    cust:{name:'株式会社アクメ設備',customer_code:'AC-001'},
    primary:{name:'サンプル担当',phone:'011-000-0000'},
    asset:{asset_number:'ASSET-001',model_name:'サンプル機器',serial_number:'SERIAL-001'},
    contract:{contract_number:'CONTRACT-001'},
    customerM365Invoke:async args=>{calls.push(args);return typeof reply==='function'?reply():reply;}
  };
  vm.createContext(ctx);
  vm.runInContext(modalFns+'\n'+ticketPanel+'\nglobalThis.openPanel=openTicketCustomerPanel;',ctx);
  const input=doc.querySelector('#ticketMessageBody');
  input.value='保存前の対応メモ';
  const ticketNode=doc.querySelector('#ticketExisting');
  return {dom,doc,ctx,input,ticketNode,calls};
}
{
  const h=uiHarness({linked:true,webUrl:trustedFolderUrl});
  h.ctx.openPanel();
  assert.match(h.doc.querySelector('#appModalLayer').textContent,/顧客・機器情報/);
  assert.match(h.doc.querySelector('#appModalLayer').textContent,/サンプル機器/);
  await tick();
  const link=h.doc.querySelector('#ticketCustomerFolderLink a');
  assert.ok(link,'The folder open action must be immediately accessible from the modal');
  assert.equal(link.href,trustedFolderUrl);
  assert.equal(link.target,'_blank','Open the M365 folder in another tab');
  assert.match(link.rel,/noopener/);
  assert.match(link.rel,/noreferrer/);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].action,'get_quick_link');
  assert.equal(h.calls[0].ticketId,ticketId);
  assert.equal(h.calls[0].customerId,customerId);
  h.doc.querySelector('#ticketCustomerPanelDone').click();
  assert.equal(h.doc.querySelector('#appModalLayer'),null);
  assert.equal(h.doc.querySelector('#ticketExisting'),h.ticketNode,'The ticket element must survive modal open and close');
  assert.equal(h.input.value,'保存前の対応メモ','Unsent ticket text must be preserved');
  h.dom.window.close();
}
{
  const h=uiHarness({linked:false,reason:'needs_manual_link'});
  h.ctx.openPanel();
  await tick();
  assert.equal(h.doc.querySelector('#ticketCustomerFolderLink a'),null);
  assert.match(h.doc.querySelector('#ticketCustomerFolderStatus').textContent,/紐付け/);
  h.doc.querySelector('#ticketCustomerPanelClose').click();
  assert.equal(h.doc.querySelector('#appModalLayer'),null);
  assert.equal(h.input.value,'保存前の対応メモ');
  h.dom.window.close();
}
{
  const h=uiHarness({linked:false,reason:'integration_not_configured'});
  h.ctx.openPanel();
  await tick();
  assert.match(h.doc.querySelector('#ticketCustomerFolderStatus').textContent,/Microsoft 365連携の認証情報が未設定/);
  assert.equal(h.doc.querySelector('#ticketCustomerFolderLink a'),null);
  h.dom.window.close();
}
{
  const h=uiHarness({linked:true,webUrl:'https://tenant.sharepoint.com.attacker.invalid/folder'});
  h.ctx.openPanel();
  await tick();
  assert.equal(h.doc.querySelector('#ticketCustomerFolderLink a'),null,'UI must also reject untrusted URLs');
  h.dom.window.close();
}
{
  let release;
  const h=uiHarness(()=>new Promise(resolve=>{release=resolve;}));
  h.ctx.openPanel();
  await tick();
  h.doc.querySelector('#ticketCustomerPanelDone').click();
  release({linked:true,webUrl:trustedFolderUrl});
  await tick();
  assert.equal(h.doc.querySelector('#appModalLayer'),null,'Delayed response must not resurrect a closed modal');
  assert.equal(h.input.value,'保存前の対応メモ');
  h.dom.window.close();
}
console.log('Ticket customer modal DOM tests passed: customer/device details, safe M365 link, back-to-ticket draft preservation, unavailable folder and delayed response.');
