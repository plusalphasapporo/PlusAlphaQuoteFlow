/*
 * QuoteFlow Cloud — role-aware workspace redesign.
 * Presentation enhancement only: existing RPCs, auth, business rules, records,
 * DOM IDs and event handlers remain owned by the original application.
 * If the enhancement fails, the original application remains available.
 */
(function () {
  'use strict';
  const home = document.getElementById('home');
  const nav = document.getElementById('navMenu');
  if (!home || !nav) return;

  const primaryIcons = {
    home: 'home', support: 'headset', support_cases: 'headset',
    support_new: 'plus', support_customers: 'users',
    customers: 'users', assets: 'monitor', support_assets: 'monitor',
    cases: 'clipboard', handoffs: 'arrows', support_handoffs: 'arrows',
    sales: 'file', quotes: 'file', procurement: 'package',
    contracts: 'shield', analysis: 'chart', knowledge: 'book',
    knowledge_admin: 'book', support_callconnect: 'phone',
    accounts: 'users', audit: 'clipboard', security: 'shield',
    settings: 'settings', customer_status: 'clipboard',
    customer_history: 'history'
  };
  const iconPaths = {
    home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
    headset: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/><path d="M20 20c0 2-3 3-7 3"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2"/><path d="M16 5a3 3 0 0 1 0 6"/><path d="M18 14a5 5 0 0 1 3 5v1"/>',
    monitor: '<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8M12 18v4"/>',
    clipboard: '<rect x="5" y="4" width="14" height="18" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h6"/>',
    arrows: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
    file: '<path d="M5 2h10l5 5v15H5z"/><path d="M15 2v6h5M8 13h9M8 17h9"/>',
    package: '<path d="m12 2 9 5-9 5-9-5zM3 7v10l9 5 9-5V7M12 12v10"/>',
    shield: '<path d="m12 2 9 4v6c0 6-4 9-9 11-5-2-9-5-9-11V6z"/><path d="m8 12 3 3 5-6"/>',
    chart: '<path d="M4 20V4M4 20h17M8 16v-5M13 16V8M18 16V5"/>',
    book: '<path d="M3 5a3 3 0 0 1 3-2h6v18H6a3 3 0 0 0-3 2zM21 5a3 3 0 0 0-3-2h-6v18h6a3 3 0 0 1 3 2z"/>',
    phone: '<path d="M6 2h5l1 5-3 2a15 15 0 0 0 6 6l2-3 5 1v5c0 2-2 4-4 4A18 18 0 0 1 2 6c0-2 2-4 4-4z"/>',
    history: '<path d="M3 12a9 9 0 1 1 2 6M3 17v-5h5M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  function el(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function icon(key) {
    const span = el('span', 'qf-icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+
      (iconPaths[key] || iconPaths.clipboard) + '</svg>';
    return span;
  }
  function currentRole() { return String(document.body.dataset.role || ''); }
  function staffRole(role) { return role === 'support_staff' || role === 'internal_admin' || role === 'internal_staff'; }

  const groupDefs = {
    internal: [
      ['日々の業務', ['home','support','cases','handoffs']],
      ['営業・顧客', ['customers','assets','sales','procurement','contracts']],
      ['連携・情報', ['support_callconnect','analysis','knowledge_admin']],
      ['管理', ['accounts','audit','security','settings']]
    ],
    support: [
      ['サポート業務', ['home','support_cases','support_customers']],
      ['情報と引継ぎ', ['knowledge','support_handoffs','support_callconnect','support_assets','security']]
    ],
    customer: [
      ['お客様メニュー', ['home','support','customer_status','assets','customer_history','knowledge','security']]
    ]
  };
  function groupNavigation() {
    if (nav.querySelector('.qf-nav-group')) return;
    const buttons = Array.from(nav.children).filter(child => child.matches('button.navBtn[data-page]'));
    if (!buttons.length) return;
    const role = currentRole();
    const defs = role === 'support_staff' ? groupDefs.support
      : (role === 'customer_user' ? groupDefs.customer : groupDefs.internal);
    const seen = new Set();
    const addGroup = (label, ids) => {
      const matches = ids.map(id => buttons.find(b => b.dataset.page === id))
        .filter(Boolean).filter(b => !seen.has(b));
      if (!matches.length) return;
      const section = el('div', 'qf-nav-group');
      section.append(el('p', 'qf-nav-group-title', label));
      for (const button of matches) {
        seen.add(button);
        if (!button.querySelector('.qf-icon')) button.prepend(icon(primaryIcons[button.dataset.page]));
        section.append(button); // Move, never clone: existing click listeners survive.
      }
      nav.append(section);
    };
    defs.forEach(([label, ids]) => addGroup(label, ids));
    addGroup('その他', buttons.map(button => button.dataset.page));
    nav.setAttribute('aria-label', '業務メニュー');
    const sideTitle = document.querySelector('.sideTitle');
    if (sideTitle) sideTitle.textContent = 'WORKSPACE';
  }

  let activeHomeTab = { internal: 'today', support: 'today' };
  function homeMode(role) { return role === 'support_staff' ? 'support' : 'internal'; }
  function classifyHomeSection(section, mode) {
    const name = (section.querySelector('h2')?.textContent || '').trim();
    if (mode === 'support') {
      if (section.classList.contains('supportReceptionBar') ||
          section.classList.contains('supportTodayBoard') ||
          /^(新着|優先案件)$/.test(name)) return 'today';
      if (/最近の電話|CallConnect/.test(name)) return 'calls';
      return 'queue';
    }
    if (section.classList.contains('internalCommandCenter') ||
        /^今日の優先対応$/.test(name) || /サポート会社からの新着引継ぎ/.test(name)) return 'today';
    if (/通常業務|未入荷|納品予定|見積|仕入|発注|受注|売上|リース|請求/.test(name)) return 'business';
    return 'support';
  }
  function buildSwitchButton(key, label, current, handleClick) {
    const button = el('button', 'qf-switch-button', label);
    button.type = 'button';
    button.dataset.view = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(key === current));
    button.onclick = () => handleClick(key);
    return button;
  }
  function enhanceHome() {
    const role = currentRole();
    if (!staffRole(role)) return;
    const selected = nav.querySelector('.navBtn.active[data-page="home"]');
    if (!selected || home.querySelector('.qf-home-switcher')) return;
    const sections = Array.from(home.children).filter(child => child.tagName === 'SECTION');
    if (sections.length < 2) return;
    const mode = homeMode(role);
    const title = el('div', 'qf-view-title');
    title.append(el('span','qf-eyebrow', mode === 'support' ? 'SUPPORT DESK' : 'OPERATIONS'));
    title.append(el('h2','',mode === 'support' ? 'サポートワークスペース' : '自社ワークスペース'));
    title.append(el('p','qf-view-help',mode === 'support'
      ? '受付・対応・遠隔作業を、必要なところから始められます。'
      : '今日確認すべき業務と、サポート・営業管理を切り替えて確認できます。'));
    const shortcuts = el('div','qf-home-shortcuts');
    const actions = mode === 'support' ? [
      ['新規受付', '#supportNewFromHome', null, true],
      ['案件一覧', null, 'support_cases', false],
      ['顧客検索', null, 'support_customers', false]
    ] : [
      ['障害を依頼', '.internalQuickAction[data-action="incident"]', null, true],
      ['設定を依頼', '.internalQuickAction[data-action="setting"]', null, false],
      ['顧客管理', null, 'customers', false],
      ['見積・リース', null, 'sales', false]
    ];
    actions.forEach(([label, target, page, prominent]) => {
      const button = el('button',prominent?'qf-shortcut-button qf-shortcut-primary':'qf-shortcut-button',label);
      button.type = 'button';
      button.onclick = () => {
        const nativeAction = target ? home.querySelector(target) : nav.querySelector('.navBtn[data-page="'+page+'"]');
        if (nativeAction && !nativeAction.disabled) nativeAction.click();
      };
      shortcuts.append(button);
    });
    const command = el('div','qf-command-header');
    command.append(title,shortcuts);
    const switcher = el('div','qf-home-switcher');
    switcher.setAttribute('role','tablist');
    switcher.setAttribute('aria-label','ダッシュボード表示');
    const definition = mode === 'support'
      ? [['today','今日の対応'],['queue','対応キュー'],['calls','電話・履歴'],['all','すべて']]
      : [['today','今日の判断'],['support','サポート管理'],['business','営業・承認'],['all','すべて']];
    const content = el('div','qf-home-content');
    const panels = new Map();
    const views = definition.filter(([id])=>id!=='all');
    views.forEach(([id,label]) => {
      const p = el('div','qf-home-panel');
      p.dataset.qfView = id;
      p.setAttribute('role','tabpanel');
      p.setAttribute('aria-label',label);
      panels.set(id,p);
      content.append(p);
    });
    for (const section of sections) panels.get(classifyHomeSection(section,mode)).append(section);
    const available = activeHomeTab[mode] || 'today';
    const activate = view => {
      activeHomeTab[mode] = view;
      switcher.querySelectorAll('button').forEach(button =>
        button.setAttribute('aria-selected',String(button.dataset.view===view)));
      panels.forEach((panel,key)=>{panel.hidden = view!=='all' && key!==view;});
    };
    definition.forEach(([key,label]) => switcher.append(buildSwitchButton(key,label,available,activate)));
    const intro = home.querySelector(':scope > .pageIntro');
    if (intro) intro.classList.add('qf-native-intro');
    if (intro) intro.after(command,switcher,content);
    else home.prepend(command,switcher,content);
    const disclosure = home.querySelector('.internalActionStrip');
    if (disclosure && mode === 'internal' && !disclosure.closest('details')) {
      const details = el('details','qf-extra-actions');
      const summary = el('summary','', 'その他の操作を表示');
      disclosure.before(details);
      details.append(summary,disclosure);
    }
    activate(available);
    home.dataset.qfView = mode;
    home.__qfSwitchHomeTab = activate;
  }

  let lastTicketKey = '';
  let lastTicketTab = 'work';
  function classifyTicketContent(section) {
    const id = section.id || '';
    if (id === 'supportAssistWorkspace' || id === 'ticketAiIncidentSection' ||
        id === 'internalHandoffWorkspace') return 'work';
    if (id === 'supportTicketCustomerContext' ||
        section.classList.contains('customerSupportSnapshot')) return 'customer';
    const label = String(section.querySelector(':scope > h3, :scope > .row h3, :scope > .formSectionHead h3')?.textContent || '');
    if (/対応履歴・メッセージ|メッセージを送信/.test(label) || section.querySelector('#ticketMessageForm')) return 'messages';
    if (/対応履歴タイムライン|引き継ぎ履歴|通話/.test(label)) return 'history';
    if (/写真・添付|対応期限|案件管理|連絡・対象/.test(label) ||
        section.querySelector('#ticketDeadlineSave,#internalTicketEditForm')) return 'details';
    if (section.querySelector('#ticketMessageList')) return 'messages';
    return 'work'; // Unknown content remains accessible, never discarded.
  }
  function enhanceTicket() {
    const role = currentRole();
    if (!staffRole(role)) return;
    const host = home.querySelector('#ticketDetailHost');
    const root = host?.querySelector(':scope > section.card.section');
    if (!root || root.dataset.qfEnhanceVersion === '1') return;
    if (!root.querySelector('.quoteDetailHead')) return;
    const key = String(root.querySelector('.quoteDetailHead .sectionDesc')?.textContent || '');
    if (key !== lastTicketKey) {lastTicketKey = key;lastTicketTab='work';}
    const definitions = [['work','対応・AI'],['messages','連絡'],['history','履歴'],['customer','顧客・機器'],['details','詳細・添付']];
    const firstChildren = Array.from(root.children);
    const headerNodes = firstChildren.filter(node=>node.matches(
      '.quoteDetailHead,.supportTicketTopbar,.supportTicketFacts,.internalTicketTopbar,.internalTicketOverviewGrid'
    ));
    const heading = root.querySelector(':scope > .quoteDetailHead');
    const tabs = el('div','qf-ticket-tabs');
    tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','案件カルテのメニュー');
    const shell = el('div','qf-ticket-shell');
    const main = el('div','qf-ticket-main');
    const rail = el('aside','qf-ticket-context');
    rail.setAttribute('aria-label','案件の概要');
    const note = el('div','qf-context-heading','対応中もここから情報を確認');
    rail.append(note);
    const facts = root.querySelectorAll(':scope > .supportTicketFacts .supportTicketFact,:scope > .internalTicketOverviewGrid .internalTicketOverviewItem');
    Array.from(facts).slice(0,4).forEach(fact=>{
      const item=el('div','qf-context-fact');
      item.append(el('span','',fact.querySelector('span')?.textContent || '概要'));
      item.append(el('strong','',fact.querySelector('strong')?.textContent || '—'));
      rail.append(item);
    });
    const panels = new Map();
    definitions.forEach(([id,label])=>{
      const panel=el('section','qf-ticket-pane');
      panel.dataset.qfView=id;panel.setAttribute('role','tabpanel');
      panel.setAttribute('aria-label',label);
      panels.set(id,panel);
      main.append(panel);
    });
    const show = view => {
      if (!panels.has(view)) view='work';
      lastTicketTab=view;
      tabs.querySelectorAll('button').forEach(button =>
        button.setAttribute('aria-selected',String(button.dataset.view === view)));
      panels.forEach((panel,key)=>{panel.hidden = view!==key;});
    };
    definitions.forEach(([key,label])=>tabs.append(buildSwitchButton(key,label,lastTicketTab,show)));
    [['作業を進める','work'],['顧客情報','customer'],['メッセージ','messages']].forEach(([label,view])=>{
      const b=el('button','qf-context-action',label);
      b.type='button';b.onclick=()=>show(view);
      rail.append(b);
    });
    firstChildren.filter(node=>!headerNodes.includes(node)).forEach(node=>{
      panels.get(classifyTicketContent(node)).append(node);
    });
    shell.append(main,rail);
    const marker=headerNodes.at(-1) || heading;
    if (marker) marker.after(tabs,shell);
    else root.prepend(tabs,shell);
    root.dataset.qfEnhanceVersion='1';
    root.__qfTicketTab=show;
    show(lastTicketTab);
    root.querySelectorAll('.supportLinearCard').forEach(card=>{
      const head=card.querySelector(':scope > .supportLinearHead');
      const body=card.querySelector(':scope > .supportLinearBody');
      if (!head || !body || head.querySelector('.qf-step-toggle'))return;
      const toggle=el('button','qf-step-toggle', '詳細を開く');
      toggle.type='button';
      toggle.setAttribute('aria-expanded','true');
      const expanded = card.classList.contains('active') || card.id === 'supportLinearIntake' && !root.querySelector('.supportLinearCard.active');
      card.classList.toggle('qf-step-collapsed',!expanded);
      toggle.textContent=expanded?'閉じる':'開く';
      toggle.setAttribute('aria-expanded',String(expanded));
      const setOpen=on=>{
        card.classList.toggle('qf-step-collapsed',!on);
        toggle.textContent=on?'閉じる':'開く';
        toggle.setAttribute('aria-expanded',String(on));
      };
      toggle.onclick=()=>setOpen(card.classList.contains('qf-step-collapsed'));
      head.append(toggle);
      card.__qfExpand=()=>setOpen(true);
    });
  }
  function revealTicketTarget(event) {
    const root=home.querySelector('#ticketDetailHost > section.qf-ticket-shell');
    const mainRoot=home.querySelector('#ticketDetailHost > section.card.section[data-qf-enhance-version="1"]');
    if (!mainRoot || !mainRoot.__qfTicketTab) return;
    const button=event.target.closest('button');
    if (!button) return;
    const id=button.id || '';
    const action=button.dataset.action || '';
    if (id==='internalTicketCustomer') mainRoot.__qfTicketTab('customer');
    else if (id==='internalTicketMessage' || /^(customer_reply|customer_wait)$/.test(action)) mainRoot.__qfTicketTab('messages');
    else if (id==='internalTicketAttachments' || id==='internalTicketEdit') mainRoot.__qfTicketTab('details');
    else if (action === 'history') mainRoot.__qfTicketTab('history');
    else if (button.id === 'supportTopPrimaryAction') {
      mainRoot.__qfTicketTab('work');
      const target= action === 'remote' ? '#supportRemoteWorkspace'
        : action === 'report' ? '#supportReportWorkspace'
        : action === 'procedure' || action === 'assist' ? '#supportKnowledgeWorkspace'
        : '#supportLinearIntake';
      mainRoot.querySelector(target)?.__qfExpand?.();
    }
  }
  function revealHomeTarget(event) {
    const element=event.target.closest('button');
    if (!element || !home.__qfSwitchHomeTab) return;
    if (element.matches('#supportUnansweredTile,#supportTeamViewerPendingTile,#supportRepeatTile,#supportReturnedTile')) {
      home.__qfSwitchHomeTab('queue');
    }
  }
  let queued=false;
  function synchronize() {
    if (queued) return;
    queued=true;
    requestAnimationFrame(()=>{
      queued=false;
      try {groupNavigation();enhanceHome();enhanceTicket();}
      catch(error){console.warn('Optional workspace layout enhancement skipped:', error);}
    });
  }
  home.addEventListener('click',event=>{revealHomeTarget(event);revealTicketTarget(event);},true);
  const observer = new MutationObserver(synchronize);
  observer.observe(home,{childList:true,subtree:true});
  observer.observe(nav,{childList:true,subtree:true});
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',synchronize,{once:true});
  else synchronize();
})();