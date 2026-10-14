import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');
const helperStart=html.indexOf('  function assetLedgerWarrantyDays(');
const ledgerStart=html.indexOf('  async function renderAssetLedger(){');
const ledgerEnd=html.indexOf('  async function renderContractDetail(',ledgerStart);
assert.ok(helperStart>=0&&ledgerStart>helperStart&&ledgerEnd>ledgerStart,
  'Asset warranty helpers and ledger renderer must exist');
const helperSource=html.slice(helperStart,ledgerStart);
const {assetLedgerWarrantyDays,assetLedgerMatchesQuickFilter}=vm.runInNewContext(
  helperSource+'\n({assetLedgerWarrantyDays,assetLedgerMatchesQuickFilter})'
);
const asOf=new Date(2026,9,13,12);
const active={id:'a1',status:'active',open_ticket_count:2,contract_id:null,contract_number:null,warranty_until:'2026-10-15'};
assert.equal(assetLedgerWarrantyDays(active,asOf),2);
assert.equal(assetLedgerWarrantyDays({warranty_until:'2026-10-12'},asOf),-1);
assert.equal(assetLedgerWarrantyDays({warranty_until:'2026-10-13'},asOf),0);
assert.equal(assetLedgerWarrantyDays({warranty_until:null},asOf),null);
assert.equal(assetLedgerMatchesQuickFilter(active,'all',asOf),true);
assert.equal(assetLedgerMatchesQuickFilter(active,'open_tickets',asOf),true);
assert.equal(assetLedgerMatchesQuickFilter(active,'contract_unlinked',asOf),true);
assert.equal(assetLedgerMatchesQuickFilter(active,'warranty_soon',asOf),true);
assert.equal(assetLedgerMatchesQuickFilter(active,'warranty_expired',asOf),false);
assert.equal(assetLedgerMatchesQuickFilter({...active,warranty_until:'2026-10-12'},'warranty_expired',asOf),true);
assert.equal(assetLedgerMatchesQuickFilter({...active,warranty_until:'2027-01-01'},'warranty_soon',asOf),false);
assert.equal(assetLedgerMatchesQuickFilter({...active,open_ticket_count:0},'open_tickets',asOf),false);
assert.equal(assetLedgerMatchesQuickFilter({...active,contract_id:'c1'},'contract_unlinked',asOf),false);
assert.equal(assetLedgerMatchesQuickFilter({...active,contract_number:'C-12'},'contract_unlinked',asOf),false);

const ledger=html.slice(ledgerStart,ledgerEnd);
for(const id of ['assetLedgerDirectory','assetLedgerDetailHost','assetLedgerResults','assetListHost']){
  assert.ok(ledger.includes('id="'+id+'"'),'Ledger element missing: '+id);
}
assert.ok(ledger.includes("listToolbar('assetLedger'"),'Ledger must preserve existing search / status / sorting toolbar');
assert.ok(ledger.includes("listToolbarState('assetLedger')"),'Ledger search must be connected to rendering');
assert.ok(ledger.includes('assetLedgerMatchesQuickFilter(a,quickFilter'),'Quick filters must affect actual rows');
assert.ok(ledger.includes('assetLedgerQuickFilter'),'Quick filter buttons must be functional');
assert.ok(ledger.includes('aria-pressed'),'Quick filter buttons must expose active state');
assert.ok(ledger.includes('assetLedgerCustomerOpen'),'Customer shortcut must be accessible directly from the ledger');
assert.ok(ledger.includes('renderAssetDetail(btn.dataset.id)'),'Ledger must preserve asset detail opening');
assert.ok(ledger.includes("await go('customers')"),'Customer shortcut must navigate to the customer workspace');
assert.ok(ledger.includes("if(role==='customer_user')"),'Customer portal path must remain available');
assert.ok(ledger.includes("rpc('create_asset'"),'Asset creation must remain available');
assert.ok(ledger.includes('一致する機器はありません'),'Filtered empty state must be explained');

const detailStart=html.indexOf('  async function renderAssetDetail(');
const detail=html.slice(detailStart,helperStart);
assert.ok(detail.includes('assetOpenCustomer'),'Asset detail must include customer shortcut');
assert.ok(detail.includes('assetDetailForm'),'Asset editing must be preserved');
assert.ok(detail.includes('assetNewTicketBtn'),'Ticket creation must be preserved');
assert.ok(detail.includes('assetTicketOpen'),'Linked ticket history must be accessible');
for(const selector of ['.assetLedgerMetrics','.assetLedgerMetric','.assetLedgerDirectory','.assetLedgerResultTable']){
  assert.ok(css.includes(selector),'Missing asset ledger responsive styles: '+selector);
}
assert.ok(css.includes('@media(max-width:620px)'),'Asset ledger must fit narrow screens');
console.log('Asset ledger navigation, filtering and warranty-day checks passed.');
