import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');
const start=html.indexOf('  async function renderCustomers(){');
const end=html.indexOf('  async function customerMap(){',start);
assert.ok(start>=0&&end>start,'Customer directory renderer must remain available');
const directory=html.slice(start,end);

for(const key of ['all','hold','unassigned','no_phone']){
  assert.ok(directory.includes('data-quick-filter="'+key+'"')||
    directory.includes("['"+key+"'"),'Missing directory quick filter: '+key);
}
assert.ok(directory.includes('id="customerDirectory"'),'Customer directory must have a return anchor');
assert.ok(directory.includes('id="customerListResults"'),'Customer directory must announce filtered results');
assert.ok(directory.includes("customerMatchesQuickFilter(c,quickFilter)"),'Quick filter must affect displayed rows');
assert.ok(directory.includes("listToolbarState('customerList')"),'Existing search, sort and status toolbar must stay active');
assert.ok(directory.includes("c.internal_note"),'Customer internal note must remain searchable');
assert.ok(directory.includes("c.address1"),'Customer address must remain searchable');
assert.ok(directory.includes('customerDetail'),'Customer record must remain openable');
assert.ok(directory.includes("aria-pressed"),'Quick filter buttons must expose active state');
assert.ok(directory.includes("条件に一致する顧客はありません"),'Empty filtered results must be explained');

const filterMatch=html.match(/  function customerMatchesQuickFilter\(c,filter\)\{[\s\S]*?\n  \}/);
assert.ok(filterMatch,'Pure customer filter helper is missing');
const filter=vm.runInNewContext('('+filterMatch[0].trim()+')');
const sample={manual_hold:true,sales_owner_name:'',phone:'',mobile:''};
assert.equal(filter(sample,'all'),true);
assert.equal(filter(sample,'hold'),true);
assert.equal(filter(sample,'unassigned'),true);
assert.equal(filter(sample,'no_phone'),true);
assert.equal(filter({...sample,manual_hold:false},'hold'),false);
assert.equal(filter({...sample,sales_owner_name:'田中'},'unassigned'),false);
assert.equal(filter({...sample,phone:'011-123-4567'},'no_phone'),false);
assert.equal(filter({...sample,mobile:'090-1111-2222'},'no_phone'),false);

const profileStart=html.indexOf('  function customerIdentityHeader(');
const profileEnd=html.indexOf('  async function renderCustomerDetail(',profileStart);
assert.ok(profileStart>=0&&profileEnd>profileStart,'Customer profile header navigation helper must be defined');
const profileHelper=html.slice(profileStart,profileEnd);
for(const tab of ['overview','contacts','assets','tickets','files','transactions']){
  assert.ok(profileHelper.includes("['"+tab+"'"),'Customer profile shortcut missing: '+tab);
}
assert.ok(profileHelper.includes('customerProfileJumpBtn'),'Customer profile shortcut class missing');
assert.ok(profileHelper.includes('customerListHost'),'Close must return to customer directory');

const detailEnd=html.indexOf('  async function ',profileEnd+40);
const detail=html.slice(profileEnd,detailEnd>profileEnd?detailEnd:undefined);
assert.ok(detail.includes('customerIdentityHeader(c,tab,'),'Customer profile must use unified header for detail tabs');
assert.ok(detail.includes('bindCustomerIdentityNavigation(customerId,host)'),'Customer profile navigation must be bound');
assert.ok(detail.includes("unifiedTabs(tabs,tab,'customer')"),'Existing customer workspace tabs must remain');
for(const selector of ['.customerDirectoryMetrics','.customerDirectoryMetric','.customerIdentityHeader','.customerProfileJump','.customerProfileJumpBtn']){
  assert.ok(css.includes(selector),'Missing customer responsive style: '+selector);
}
assert.ok(css.includes('@media(max-width:620px)'),'Customer layout must work on narrow screens');
console.log('Customer directory and profile navigation checks passed.');
