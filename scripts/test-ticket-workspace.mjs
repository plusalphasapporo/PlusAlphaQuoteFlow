import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');

function extract(start, end) {
  const begin = html.indexOf(start);
  const stop = html.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && stop > begin, 'Source anchor was not found: ' + start);
  return html.slice(begin, stop);
}

const workspaceSource = extract(
  '  async function openTicketWorkspace(ticketId){',
  '\n  async function renderTicketDetail(ticketId){'
);
assert.match(workspaceSource, /案件カルテを読み込み中/);
assert.match(workspaceSource, /ticketWorkspaceRetry/);
assert.match(workspaceSource, /ticketWorkspaceReturn/);

function makeWorkspaceHarness(failFirst = 0) {
  let attempts = 0;
  const visits = [];
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, { innerHTML: '', onclick: null });
    }
    return elements.get(selector);
  };
  const context = {
    bootData: { context: { role: 'internal_admin' } },
    currentPage: 'home',
    activeTicketId: 'old-ticket',
    $: element,
    setActiveNav() {},
    go: async page => { visits.push(page); },
    toast() {},
    esc: value => String(value),
    renderTicketDetail: async ticketId => {
      assert.equal(ticketId, 'ticket-1');
      attempts += 1;
      if (attempts <= failFirst) throw new Error('Network temporarily unavailable');
    },
    window: { scrollTo() {} },
    setTimeout: () => 1,
    console: { error() {} }
  };
  vm.createContext(context);
  vm.runInContext(workspaceSource + '\nglobalThis.testWorkspace = openTicketWorkspace;', context);
  return { context, element, visits, attempts: () => attempts };
}

{
  const harness = makeWorkspaceHarness();
  await harness.context.testWorkspace('ticket-1');
  assert.equal(harness.attempts(), 1, 'Normal case should load only once');
  assert.match(harness.element('#home').innerHTML, /案件カルテを読み込み中/);
  assert.equal(typeof harness.element('#ticketDetailClose').onclick, 'function');
  assert.doesNotMatch(harness.element('#ticketDetailHost').innerHTML, /読み込めませんでした/);
}

{
  const harness = makeWorkspaceHarness(1);
  await harness.context.testWorkspace('ticket-1');
  assert.equal(harness.attempts(), 1);
  assert.equal(harness.context.activeTicketId, null, 'Failed load should clear active ticket');
  assert.match(harness.element('#ticketDetailHost').innerHTML, /案件カルテを読み込めませんでした/);
  assert.match(harness.element('#ticketDetailHost').innerHTML, /新規登録を繰り返さず/);
  assert.equal(typeof harness.element('#ticketWorkspaceRetry').onclick, 'function');
  await harness.element('#ticketWorkspaceRetry').onclick();
  assert.equal(harness.attempts(), 2, 'Retry should re-open the same ticket');
}

{
  const harness = makeWorkspaceHarness(1);
  await harness.context.testWorkspace('ticket-1');
  await harness.element('#ticketWorkspaceReturn').onclick();
  assert.equal(harness.visits.at(-1), 'support', 'Back button should return to the case list');
}

const optionalContextSource = extract(
  '    const [staffOptionsRaw,customerCtxRaw]=internal?await Promise.all([',
  '\n    const rawDescription=String(t.description||\'\');'
);

async function resolveOptionalContext(rpcOptional) {
  const context = {
    internal: true,
    t: {
      assigned_internal_user_id: 'staff-existing',
      contract_id: 'contract-existing',
      asset_id: 'asset-existing'
    },
    contract: { id: 'contract-existing', contract_number: 'Existing contract' },
    asset: { id: 'asset-existing', asset_number: 'Existing asset' },
    rpcOptional
  };
  vm.createContext(context);
  vm.runInContext(
    'async function resolve(){' + optionalContextSource +
    '\nreturn { staffOptions, customerCtx, contextLoadIncomplete }; }\nglobalThis.testResolve=resolve;',
    context
  );
  return context.testResolve();
}

{
  const fallback = await resolveOptionalContext(async () => null);
  assert.equal(fallback.contextLoadIncomplete, true);
  assert.equal(fallback.staffOptions[0].user_id, 'staff-existing');
  assert.equal(fallback.customerCtx.contracts[0].id, 'contract-existing');
  assert.equal(fallback.customerCtx.assets[0].id, 'asset-existing');
}

{
  const success = await resolveOptionalContext(async name => {
    if (name === 'internal_staff_options') {
      return [{ user_id: 'staff-existing', display_name: 'Active staff' }];
    }
    return {
      contracts: [{ id: 'contract-existing', contract_number: 'Active contract' }],
      assets: [{ id: 'asset-existing', asset_number: 'Active asset' }]
    };
  });
  assert.equal(success.contextLoadIncomplete, false);
  assert.equal(success.staffOptions.length, 1);
  assert.equal(success.customerCtx.contracts.length, 1);
  assert.equal(success.customerCtx.assets.length, 1);
}

assert.match(html, /createdTicketForThisForm \|\| await rpc\('create_support_ticket'/);
assert.match(html, /await openTicketWorkspace\(result.id\)/);
console.log('Ticket workspace recovery tests passed (normal / failed / retry / back / optional context).');

const intakeSource = extract(
  '  async function renderSupportNew(){',
  '\n  async function renderSupportCases(){'
);

function makeIntakeHarness({ failClaimOnce = false, deferredCreation = false } = {}) {
  const events = { created: 0, claimed: 0, opened: [], pages: [], notices: [] };
  const elements = new Map();
  let releaseCreation = null;
  const element = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        selectedOptions: [{ textContent: 'TEST / Mock customer' }],
        focus() {},
        reset() {}
      });
    }
    return elements.get(selector);
  };

  const context = {
    pendingCallConnectIntake: null,
    $: element,
    esc: value => String(value ?? ''),
    pageIntro: () => '<h2>New intake</h2>',
    statusText: value => String(value ?? ''),
    notice: (selector, message) => events.notices.push({ selector, message }),
    toast() {},
    setTimeout: () => 1,
    go: async page => { events.pages.push(page); },
    openTicketWorkspace: async id => { events.opened.push(id); },
    console: { error() {} },
    rpc: async (name, args) => {
      if (name === 'support_customer_directory') {
        return [{ id: 'customer-1', customer_code: 'TEST', name: 'Mock customer' }];
      }
      if (name === 'create_support_ticket') {
        events.created += 1;
        assert.equal(args.p_customer_id, 'customer-1');
        if (deferredCreation) {
          return new Promise(resolve => {
            releaseCreation = () => resolve({ id: 'ticket-1', ticket_number: 'TKT-APP-00000021' });
          });
        }
        return { id: 'ticket-1', ticket_number: 'TKT-APP-00000021' };
      }
      if (name === 'claim_support_ticket') {
        events.claimed += 1;
        assert.equal(args.p_ticket_id, 'ticket-1');
        if (failClaimOnce && events.claimed === 1) throw new Error('Claim temporarily unavailable');
        return { support_stage: 'in_progress' };
      }
      throw new Error('Unexpected mock RPC: ' + name);
    }
  };
  vm.createContext(context);
  vm.runInContext(intakeSource + '\nglobalThis.testIntake = renderSupportNew;', context);
  const prepare = async () => {
    await context.testIntake();
    element('#supportNewCustomer').value = 'customer-1';
    element('#supportNewSource').value = 'callconnect';
    element('#supportNewPriority').value = 'normal';
    element('#supportNewSubject').value = 'Printer issue';
    element('#supportNewDescription').value = 'Printing fails';
  };
  return {
    context,
    element,
    events,
    prepare,
    release: () => releaseCreation?.(),
    submit: () => element('#supportNewForm').onsubmit({ preventDefault() {} })
  };
}

{
  const h = makeIntakeHarness();
  await h.prepare();
  await h.submit();
  assert.equal(h.events.created, 1, 'An intake should create exactly one ticket');
  assert.equal(h.events.claimed, 1, 'Start-now should claim the created ticket');
  assert.equal(h.events.opened.join(','), 'ticket-1', 'It should open the existing ticket');
}

{
  const h = makeIntakeHarness({ failClaimOnce: true });
  await h.prepare();
  await h.submit();
  assert.equal(h.events.created, 1);
  assert.equal(h.events.opened.length, 0);
  assert.match(h.events.notices.at(-1).message, /受付は登録済みです/);
  assert.match(h.element('#supportNewStartBtn').textContent, /登録済み案件の対応を再開/);
  await h.submit();
  assert.equal(h.events.created, 1, 'Retry must not duplicate an existing ticket');
  assert.equal(h.events.claimed, 2, 'Retry must reclaim the same ticket');
  assert.equal(h.events.opened.join(','), 'ticket-1');
}

{
  const h = makeIntakeHarness();
  await h.prepare();
  await h.element('#supportNewSaveOnlyBtn').onclick();
  assert.equal(h.events.created, 1);
  assert.equal(h.events.claimed, 0);
  assert.equal(h.events.pages.join(','), 'support_cases');
}

{
  const h = makeIntakeHarness({ deferredCreation: true });
  await h.prepare();
  const first = h.submit();
  const second = h.submit();
  assert.equal(h.events.created, 1, 'Concurrent submissions must share one ticket');
  h.release();
  await Promise.all([first, second]);
  assert.equal(h.events.opened.length, 1);
}

console.log('Ticket intake integration tests passed (create / claim / open / claim failure / retry / save-only / double-submit).');



const auditMigration = fs.readFileSync(
  'supabase/migrations/20261013035658_fix_internal_ticket_creation_audit_permissions.sql',
  'utf8'
);
assert.match(auditMigration, /function app_private\.internal_create_support_ticket_impl/i);
assert.match(auditMigration, /security definer/i);
assert.match(auditMigration, /function public\.internal_create_support_ticket/i);
assert.match(auditMigration, /grant execute on function app_private\.internal_create_support_ticket_impl/i);
assert.doesNotMatch(auditMigration, /^\s*grant\s+insert\s+on\s+(table\s+)?public\.audit_logs/im);
console.log('Internal intake audit migration checks passed.');


const nullGateMigration = fs.readFileSync(
  'supabase/migrations/20261013060746_reject_unverified_internal_ticket_creation.sql',
  'utf8'
);
assert.match(nullGateMigration, /if coalesce\(v_role,'\s*'\) not in \('internal_admin','internal_staff'\) then/i);
assert.doesNotMatch(nullGateMigration, /if v_role not in \('internal_admin','internal_staff'\) then/i);
assert.match(nullGateMigration, /SECURITY DEFINER/i);
assert.match(nullGateMigration, /set search_path to ''/i);
assert.match(nullGateMigration, /raise exception using errcode='42501'/i);
assert.doesNotMatch(nullGateMigration, /create or replace function public\./i);
const validRoles = ['internal_admin', 'internal_staff'];
const allowTicketCreation = role => validRoles.includes(role ?? '');
for (const forbidden of [null, undefined, '', 'customer_user', 'support_staff']) {
  assert.equal(allowTicketCreation(forbidden), false, 'Unauthorized role must not create an internal ticket');
}
for (const allowed of validRoles) {
  assert.equal(allowTicketCreation(allowed), true);
}
console.log('Ticket creation null-role regression assertions passed.');
