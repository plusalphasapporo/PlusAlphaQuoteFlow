import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const workspaceSource = readFileSync('assets/support-ticket-tabs.js', 'utf8');
const stepIds = [
  'supportLinearIntake',
  'supportKnowledgeWorkspace',
  'supportRemoteWorkspace',
  'supportReportWorkspace'
];

class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.target = opts.target || null;
    this.bubbles = !!opts.bubbles;
    this.key = opts.key || '';
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.files = [];
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.handlers = {};
    this.scrolls = 0;
    this.focuses = 0;
    this.style = {};
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '),
      remove: (...names) => this.className = this.className.split(/\s+/).filter(x => !names.includes(x)).join(' '),
      toggle: (name, force) => {
        const state = force === undefined ? !this.classList.contains(name) : !!force;
        if (state) this.classList.add(name);
        else this.classList.remove(name);
        return state;
      }
    };
  }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.remove();
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  before(...nodes) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    for (const node of nodes) {
      node.remove();
      const index = parent.children.indexOf(this);
      node.parentElement = parent;
      parent.children.splice(index, 0, node);
    }
  }
  after(...nodes) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    for (const node of [...nodes].reverse()) {
      node.remove();
      const index = parent.children.indexOf(this);
      node.parentElement = parent;
      parent.children.splice(index + 1, 0, node);
    }
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s.startsWith('.')) return this.classList.contains(s.slice(1));
      if (s === 'button[data-ticket-tab]') return this.tagName === 'BUTTON' && Object.hasOwn(this.dataset, 'ticketTab');
      if (s === '[data-ticket-unsaved="1"]') return this.dataset.ticketUnsaved === '1';
      return this.tagName.toLowerCase() === s.toLowerCase();
    });
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) {
      if (el.matches(selector)) return el;
    }
    return null;
  }
  contains(node) {
    for (let el = node; el; el = el.parentElement) if (el === this) return true;
    return false;
  }
  addEventListener(type, listener) {
    (this.handlers[type] ||= []).push(listener);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (let node = this; node; node = node.parentElement) {
      for (const handler of node.handlers[event.type] || []) handler(event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }
  scrollIntoView() { this.scrolls++; }
  focus() { this.focuses++; }
}

class FakeDataTransfer {
  constructor() {
    this.files = [];
    this.items = { add: file => this.files.push(file) };
  }
}

function createEnvironment() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const host = new FakeElement('div');
  host.id = 'ticketDetailHost';
  body.append(host);
  const document = {
    head,
    body,
    createElement: tag => new FakeElement(tag),
    getElementById: id => body.querySelector('#' + id) || head.querySelector('#' + id)
  };
  const window = { confirm: () => true };
  vm.runInNewContext(workspaceSource, {
    window, document, console, Event: FakeEvent, DataTransfer: FakeDataTransfer
  }, { filename: 'assets/support-ticket-tabs.js' });
  return { host, document, window, api: window.QuoteFlowTicketTabs };
}

function element(tag, id = '', className = '') {
  const node = new FakeElement(tag);
  node.id = id;
  node.className = className;
  return node;
}

function fixture(host) {
  host.replaceChildren();
  host.classList.remove('ticketTabsEnabled');
  const root = element('section', '', 'card section');
  host.append(root);
  root.append(element('div', '', 'quoteDetailHead'));

  const work = element('section', '', 'section');
  const workTitle = element('h3');
  workTitle.textContent = '対応の進行';
  work.append(workTitle);
  const flow = element('div', '', 'supportLinearFlow');
  const steps = stepIds.map((id, index) => {
    const node = element('section', id, 'supportLinearCard ' + (index === 0 ? 'active' : ''));
    flow.append(node);
    return node;
  });
  work.append(flow);
  const remoteAction = element('textarea', 'ticketRemoteAction');
  work.append(remoteAction);
  root.append(work);

  const messages = element('section', '', 'section');
  const messagesTitle = element('h3');
  messagesTitle.textContent = '対応履歴・メッセージ';
  messages.append(messagesTitle);
  const messageBody = element('textarea', 'ticketMessageBody');
  const messageFiles = element('input', 'ticketMessageFiles');
  const replyContext = element('div', 'ticketMessageReplyContext', 'hidden');
  messages.append(messageBody, messageFiles, replyContext);
  root.append(messages);

  const manage = element('section', '', 'formSection');
  const fields = {};
  for (const id of [
    'ticketProfileInternalNote','ticketProfilePriority','ticketProfileAssigned',
    'ticketProfileAsset','ticketProfileContract','ticketFirstResponseDue','ticketResolutionDue'
  ]) {
    fields[id] = element(id === 'ticketProfileInternalNote' ? 'textarea' : 'input', id);
    manage.append(fields[id]);
  }
  root.append(manage);
  return { steps, fields, messageBody, messageFiles, replyContext, remoteAction };
}

function edit(field, value, type = 'input') {
  field.value = value;
  field.dispatchEvent(new FakeEvent(type, { bubbles: true }));
}

const options = ticketId => ({
  role: 'internal_admin', ticketId, nextTarget: 'content',
  title: 'Test customer', ticket: 'T-0001', subject: 'Demo', assignee: 'Tester', stage: '対応中'
});

test('four workflow screens and tabs navigate without replacing inputs', () => {
  const { api, host } = createEnvironment();
  const f = fixture(host);
  api.mount(options('case-1'));
  const footer = host.querySelector('.ticketWorkspaceStepFooter');
  assert.ok(footer, 'step navigation is rendered');
  const previous = footer.children[0];
  const next = footer.children[2];
  assert.equal(previous.disabled, true);
  assert.equal(f.steps[0].hidden, false);
  assert.equal(f.steps[1].hidden, true);
  edit(f.remoteAction, 'remote draft');
  for (let index = 1; index < stepIds.length; index++) {
    next.onclick();
    assert.equal(f.steps[index].hidden, false);
    assert.equal(f.steps[index - 1].hidden, true);
    assert.equal(previous.disabled, false);
  }
  assert.equal(next.disabled, true);
  previous.onclick();
  assert.equal(f.steps[2].hidden, false);
  const tabs = host.querySelector('.ticketWorkspaceTabRow');
  const messagesButton = host.querySelector('#ticketWorkspaceTab_messages');
  tabs.onclick({ target: messagesButton });
  assert.equal(host.querySelector('#ticketWorkspacePane_messages').hidden, false);
  assert.equal(host.querySelector('#ticketWorkspacePane_work').hidden, true);
  api.revealAndScroll(f.steps[1]);
  assert.equal(host.querySelector('#ticketWorkspacePane_work').hidden, false);
  assert.equal(f.steps[1].hidden, false);
  assert.equal(f.remoteAction.value, 'remote draft');
  assert.equal(api.hasUnsentEdits('case-1'), true);
});

test('refresh retains only edited fields and attachments for the same case', () => {
  const { api, host } = createEnvironment();
  const f = fixture(host);
  api.mount(options('case-1'));
  edit(f.fields.ticketProfileInternalNote, 'internal edit');
  edit(f.fields.ticketProfilePriority, 'urgent', 'change');
  edit(f.fields.ticketFirstResponseDue, '2026-10-20T12:00', 'change');
  edit(f.remoteAction, 'remote work');
  const attachment = { name: 'photo.png', size: 4000, lastModified: 1 };
  f.messageFiles.files = [attachment];
  const snapshot = api.captureInProgress('case-1');
  assert.equal(snapshot.fields.ticketProfilePriority, 'urgent');
  assert.equal(snapshot.fields.ticketProfileInternalNote, 'internal edit');
  assert.equal(snapshot.files.length, 1);
  assert.equal(api.captureInProgress('another-case'), null);

  const refreshed = fixture(host);
  api.mount(options('case-1'));
  api.restoreInProgress('case-1', snapshot);
  assert.equal(refreshed.fields.ticketProfilePriority.value, 'urgent');
  assert.equal(refreshed.fields.ticketProfileInternalNote.value, 'internal edit');
  assert.equal(refreshed.fields.ticketFirstResponseDue.value, '2026-10-20T12:00');
  assert.equal(refreshed.remoteAction.value, 'remote work');
  assert.equal(refreshed.messageFiles.files[0], attachment);
  assert.equal(api.hasUnsentEdits('case-1'), true);
  assert.equal(api.hasUnsentEdits('another-case'), false);

  // Once the server saves a value, only the matching submitted edit becomes clean.
  api.clearSavedEdits('case-1', { ticketProfileInternalNote: 'internal edit' });
  assert.equal(refreshed.fields.ticketProfileInternalNote.dataset.ticketUnsaved, undefined);
  edit(refreshed.fields.ticketProfilePriority, 'high', 'change');
  api.clearSavedEdits('case-1', { ticketProfilePriority: 'urgent' });
  assert.equal(refreshed.fields.ticketProfilePriority.dataset.ticketUnsaved, '1',
    'newer edits remain unsaved when an older request completes');
});

test('unsent replies trigger leave guard and pause new-message refresh', async () => {
  const { api, host, window } = createEnvironment();
  const f = fixture(host);
  api.mount(options('case-2'));
  let confirmations = 0;
  window.confirm = () => { confirmations++; return false; };
  edit(f.messageBody, 'reply not sent');
  assert.equal(api.hasUnsentEdits('case-2'), true);
  assert.equal(api.confirmLeave('case-2'), false);
  assert.equal(confirmations, 1);
  let refreshes = 0;
  api.showPendingMessage('case-2', '顧客の返信', async () => { refreshes++; });
  const banner = host.querySelector('#ticketPendingNewMessage');
  assert.ok(banner, 'pending message banner is visible');
  assert.equal(host.querySelector('#ticketWorkspaceTab_messages').textContent, '連絡・返信 ●');
  await banner.querySelector('button').onclick();
  assert.equal(refreshes, 0, 'refresh is blocked when confirmation is declined');
  window.confirm = () => true;
  await banner.querySelector('button').onclick();
  assert.equal(refreshes, 1, 'refresh proceeds after explicit confirmation');
});

test('unauthorized tab roles do not remount the customer view', () => {
  const { api, host } = createEnvironment();
  const f = fixture(host);
  api.mount({ ...options('case-3'), role: 'customer_user' });
  assert.equal(host.classList.contains('ticketTabsEnabled'), false);
  assert.equal(host.querySelector('.ticketWorkspaceStepFooter'), null);
  assert.equal(f.steps[0].hidden, false);
});
