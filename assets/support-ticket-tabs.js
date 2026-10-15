/* QuoteFlow Cloud support ticket detail presentation.
   UI-only: moving existing DOM nodes keeps the original handlers, RPCs and drafts intact. */
(function(){
  'use strict';
  const preferenceByTicket=new Map();
  let activeController=null;
  const tabDefinitions=[
    ['work','対応'],
    ['customer','顧客・機器'],
    ['messages','連絡・返信'],
    ['history','履歴・通話'],
    ['files','写真・資料'],
    ['ai','AI解析'],
    ['manage','期限・管理']
  ];
  const stepDefinitions=[
    ['supportLinearIntake','受付内容'],
    ['supportKnowledgeWorkspace','AI・ナレッジ'],
    ['supportRemoteWorkspace','TeamViewer'],
    ['supportReportWorkspace','作業報告']
  ];
  const styles=`
    #ticketDetailHost.ticketTabsEnabled .ticketWorkspaceDeck{margin-top:14px;min-width:0}
    #ticketDetailHost.ticketTabsEnabled .ticketWorkspaceBar{position:sticky;top:68px;z-index:12;background:#fff;border:1px solid #dfe6f1;border-radius:13px;padding:8px 10px 0;box-shadow:0 7px 24px rgba(15,23,42,.08);scroll-margin-top:74px}
    #ticketDetailHost .ticketWorkspaceMini{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:1px 4px 8px}
    #ticketDetailHost .ticketWorkspaceMiniTitle{display:flex;flex-direction:column;min-width:0;gap:2px}
    #ticketDetailHost .ticketWorkspaceMiniTitle strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ticketDetailHost .ticketWorkspaceMiniTitle small{font-size:11px;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ticketDetailHost .ticketWorkspaceMiniMeta{font-size:11px;color:#667085;white-space:nowrap}
    #ticketDetailHost .ticketWorkspaceTabRow{display:flex;align-items:center;gap:5px;overflow-x:auto;scrollbar-width:thin;padding:0 0 8px}
    #ticketDetailHost .ticketWorkspaceTab{flex:0 0 auto;border:1px solid transparent;border-radius:9px;padding:9px 12px;background:transparent;color:#475569;font-size:12px;font-weight:800;white-space:nowrap;box-shadow:none}
    #ticketDetailHost .ticketWorkspaceTab:hover{background:#eff6ff}
    #ticketDetailHost .ticketWorkspaceTab[aria-selected="true"]{background:#dbeafe;color:#1d4ed8;border-color:#93c5fd}
    #ticketDetailHost .ticketWorkspaceTab:focus-visible,#ticketDetailHost .ticketWorkspaceStepButton:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
    #ticketDetailHost .ticketWorkspacePane{padding:14px 2px 2px;min-width:0}
    #ticketDetailHost .ticketWorkspacePane[hidden]{display:none!important}
    #ticketDetailHost .ticketWorkspacePane>.section,#ticketDetailHost .ticketWorkspacePane>.formSection{margin-top:0;margin-bottom:14px}
    #ticketDetailHost .ticketWorkspacePane>.row{margin:12px 0}
    #ticketDetailHost.ticketTabsEnabled .supportLinearProgress{display:none}
    #ticketDetailHost.ticketTabsEnabled .supportLinearFlow>.supportLinearCard:not(.ticketStepActive){display:none!important}
    #ticketDetailHost .ticketWorkspaceStepNav{margin:12px 0;border:1px solid #bfdbfe;background:#f8fbff;border-radius:12px;padding:10px}
    #ticketDetailHost .ticketWorkspaceStepHead{font-size:12px;color:#1e40af;font-weight:800;margin-bottom:8px}
    #ticketDetailHost .ticketWorkspaceStepRow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    #ticketDetailHost .ticketWorkspaceStepButton{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:56px;border:1px solid #dbe4f0;border-radius:9px;background:#fff;color:#334155;padding:7px 5px;font-size:12px;font-weight:750;box-shadow:none}
    #ticketDetailHost .ticketWorkspaceStepState{font-size:10px;line-height:1.3;font-weight:750;color:#667085}
    #ticketDetailHost .ticketWorkspaceStepState[data-state="done"]{color:#047857}
    #ticketDetailHost .ticketWorkspaceStepState[data-state="active"]{color:#1d4ed8}
    #ticketDetailHost .ticketWorkspaceStepState[data-state="checked"]{color:#047857}
    #ticketDetailHost .ticketWorkspaceStepButton[aria-pressed="true"] .ticketWorkspaceStepState{color:#fff}
    #ticketDetailHost .ticketWorkspaceStepButton[aria-pressed="true"]{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
    #ticketDetailHost .ticketWorkspaceStepFooter{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0;padding:10px 0;border-top:1px solid #dfe6f1}
    #ticketDetailHost .ticketWorkspaceStepFootHint{font-size:11px;color:#667085;text-align:center}
    #ticketDetailHost .ticketWorkspaceStepFooter button{min-width:96px}
    #ticketDetailHost .ticketWorkspaceStepFooter button:disabled{opacity:.42;cursor:not-allowed}
    @media(max-width:780px){
      #ticketDetailHost.ticketTabsEnabled .ticketWorkspaceBar{top:68px;padding:7px 7px 0;border-radius:11px}
      #ticketDetailHost .ticketWorkspaceMiniMeta{display:none}
      #ticketDetailHost .ticketWorkspaceTab{padding:8px 10px}
      #ticketDetailHost .ticketWorkspaceStepRow{grid-template-columns:repeat(2,minmax(0,1fr))}
      #ticketDetailHost .ticketWorkspaceStepFooter button{min-width:75px;padding:9px 7px}
    }
  `;

  function appendStyles(){
    if(document.getElementById('ticketWorkspaceTabsStyles')) return;
    const style=document.createElement('style');
    style.id='ticketWorkspaceTabsStyles';
    style.textContent=styles;
    document.head.appendChild(style);
  }
  function headingText(element){
    return String(element.querySelector('h3')?.textContent||'');
  }
  function panelCategory(element){
    if(element.id==='supportTicketCustomerContext') return 'customer';
    if(element.id==='ticketCallTranscriptSection') return 'history';
    if(element.id==='supportTopOverview'||element.classList.contains('internalTicketOverviewGrid')) return 'customer';
    if(element.id==='ticketAiIncidentSection') return 'ai';
    if(element.classList.contains('formSection')) return element.id==='supportAssistWorkspace'?'work':'manage';
    const title=headingText(element);
    if(title.includes('対応履歴・メッセージ')) return 'messages';
    if(title.includes('対応履歴タイムライン')||title.includes('引き継ぎ履歴')||title.includes('操作履歴')) return 'history';
    if(title.includes('写真・添付ファイル')) return 'files';
    return 'work';
  }
  function mount(opts){
    activeController=null;
    const role=opts?.role;
    if(!['support_staff','internal_admin','internal_staff'].includes(role)) return;
    const host=document.getElementById('ticketDetailHost');
    const root=host?.firstElementChild;
    if(!root) return;
    appendStyles();
    const ticketId=String(opts.ticketId);
    const prior=preferenceByTicket.get(ticketId)||{};
    const deck=document.createElement('div');
    deck.className='ticketWorkspaceDeck';
    const bar=document.createElement('div');
    bar.className='ticketWorkspaceBar';
    const mini=document.createElement('div');
    mini.className='ticketWorkspaceMini';
    const heading=document.createElement('div');
    heading.className='ticketWorkspaceMiniTitle';
    const title=document.createElement('strong');
    title.textContent=String(opts.title||'サポート案件');
    const sub=document.createElement('small');
    sub.textContent=String(opts.ticket||'—')+' / '+String(opts.subject||'');
    heading.append(title,sub);
    const meta=document.createElement('span');
    meta.className='ticketWorkspaceMiniMeta';
    meta.textContent=String(opts.assignee||'')+' ・ '+String(opts.stage||'');
    mini.append(heading,meta);
    const nav=document.createElement('nav');
    nav.className='ticketWorkspaceTabRow';
    nav.setAttribute('role','tablist');
    nav.setAttribute('aria-label','案件カルテの表示切り替え');
    bar.append(mini,nav);
    deck.append(bar);
    const panes=new Map();
    for(const [key] of tabDefinitions){
      const pane=document.createElement('section');
      pane.className='ticketWorkspacePane';
      pane.id='ticketWorkspacePane_'+key;
      pane.dataset.ticketPane=key;
      pane.setAttribute('role','tabpanel');
      pane.setAttribute('aria-labelledby','ticketWorkspaceTab_'+key);
      pane.hidden=true;
      panes.set(key,pane);
      deck.append(pane);
    }
    const pinnedSelector='.quoteDetailHead,.supportTicketTopbar,.internalTicketTopbar,.supportTicketFacts,.internalTicketQuick';
    for(const child of [...root.children]){
      if(child.matches(pinnedSelector)) continue;
      (panes.get(panelCategory(child))||panes.get('work')).append(child);
    }
    root.append(deck);
    const buttons=new Map();
    for(const [key,label] of tabDefinitions){
      const pane=panes.get(key);
      if(!pane.children.length){
        pane.remove();
        panes.delete(key);
        continue;
      }
      const button=document.createElement('button');
      button.type='button';
      button.id='ticketWorkspaceTab_'+key;
      button.className='ticketWorkspaceTab';
      button.dataset.ticketTab=key;
      button.textContent=label;
      button.setAttribute('role','tab');
      button.setAttribute('aria-controls','ticketWorkspacePane_'+key);
      button.setAttribute('aria-selected','false');
      nav.append(button);
      buttons.set(key,button);
    }
    if(!buttons.size){deck.remove();return;}

    const flow=panes.get('work')?.querySelector('.supportLinearFlow');
    const steps=stepDefinitions.filter(([id])=>flow?.querySelector('#'+id));
    const stepForTarget={
      content:'supportLinearIntake',
      assist:'supportKnowledgeWorkspace',
      procedure:'supportKnowledgeWorkspace',
      remote:'supportRemoteWorkspace',
      report:'supportReportWorkspace'
    };
    const nextTarget=String(opts.nextTarget||'');
    const guessedStep=stepForTarget[nextTarget]||'supportLinearIntake';
    const targetTab=nextTarget==='history'?'history':['customer_reply','customer_wait'].includes(nextTarget)?'messages':'work';
    const workflowAdvanced=typeof prior.nextTarget==='string'&&prior.nextTarget!==nextTarget;
    let activeTab=!workflowAdvanced&&panes.has(prior.tab)?prior.tab:targetTab;
    if(!panes.has(activeTab)) activeTab='work';
    let activeStep=!workflowAdvanced&&steps.some(([id])=>id===prior.step)?prior.step:guessedStep;
    let stepButtons=[],previous=null,next=null,progress=null;
    function persist(){
      preferenceByTicket.set(ticketId,{tab:activeTab,step:activeStep,nextTarget});
    }
    function computeStepState(node){
      if(!node) return {name:'未着手',key:'pending'};
      if(node.classList.contains('done')) return {name:'完了',key:'done'};
      const checks=[...node.querySelectorAll('.ticketAssistStepCheck')];
      if(checks.length&&checks.every(x=>x.checked)) return {name:'手順チェック済み',key:'checked'};
      if(node.classList.contains('active')) return {name:'対応中',key:'active'};
      if(node.classList.contains('optional')) return {name:'必要時のみ',key:'optional'};
      return {name:'未着手',key:'pending'};
    }
    function refreshStepStates(){
      steps.forEach(([id,label],index)=>{
        const node=flow.querySelector('#'+id);
        const state=computeStepState(node);
        const button=stepButtons[index];
        const status=button?.querySelector('.ticketWorkspaceStepState');
        if(status){status.textContent=state.name;status.dataset.state=state.key;}
        if(button) button.setAttribute('aria-label',(index+1)+'. '+label+' / '+state.name);
      });
      const index=steps.findIndex(([id])=>id===activeStep);
      if(progress&&index>=0){
        const state=computeStepState(flow.querySelector('#'+activeStep));
        progress.textContent='表示中：'+(index+1)+' / '+steps.length+'　'+steps[index][1]+' ｜ '+state.name;
      }
    }
    function setTab(key,scroll){
      if(!panes.has(key)) key='work';
      activeTab=key;
      for(const [name,pane] of panes){
        const selected=name===key;
        pane.hidden=!selected;
        buttons.get(name)?.setAttribute('aria-selected',selected?'true':'false');
        buttons.get(name).tabIndex=selected?0:-1;
      }
      persist();
      if(scroll) bar.scrollIntoView({behavior:'smooth',block:'start'});
    }
    function setStep(id,scroll){
      if(!steps.length) return;
      if(!steps.some(([stepId])=>stepId===id)) id=steps[0][0];
      activeStep=id;
      steps.forEach(([stepId],i)=>{
        const element=flow.querySelector('#'+stepId);
        const selected=stepId===id;
        if(element){
          element.hidden=!selected;
          element.classList.toggle('ticketStepActive',selected);
        }
        stepButtons[i]?.setAttribute('aria-pressed',selected?'true':'false');
      });
      const index=steps.findIndex(([stepId])=>stepId===id);
      refreshStepStates();
      if(previous) previous.disabled=index===0;
      if(next) next.disabled=index===steps.length-1;
      persist();
      if(scroll) setTab('work',true);
    }
    if(steps.length>1){
      const stepNav=document.createElement('div');
      stepNav.className='ticketWorkspaceStepNav';
      progress=document.createElement('div');
      progress.className='ticketWorkspaceStepHead';
      progress.setAttribute('aria-live','polite');
      const stepRow=document.createElement('div');
      stepRow.className='ticketWorkspaceStepRow';
      stepButtons=steps.map(([id,label],index)=>{
        const button=document.createElement('button');
        button.type='button';
        button.className='ticketWorkspaceStepButton';
        const name=document.createElement('strong');
        name.textContent=(index+1)+'. '+label;
        const state=document.createElement('span');
        state.className='ticketWorkspaceStepState';
        button.append(name,state);
        button.setAttribute('aria-pressed','false');
        button.onclick=()=>{setStep(id,false);setTab('work',true);};
        stepRow.append(button);
        return button;
      });
      stepNav.append(progress,stepRow);
      flow.before(stepNav);
      const footer=document.createElement('div');
      footer.className='ticketWorkspaceStepFooter';
      previous=document.createElement('button');
      previous.type='button';
      previous.className='ghost';
      previous.textContent='← 前の画面';
      previous.onclick=()=>{
        const index=steps.findIndex(([id])=>id===activeStep);
        setStep(steps[Math.max(0,index-1)][0],false);
        setTab('work',true);
      };
      const hint=document.createElement('span');
      hint.className='ticketWorkspaceStepFootHint';
      hint.textContent='画面切替のみ。案件の状態は変更されません。';
      next=document.createElement('button');
      next.type='button';
      next.className='primary';
      next.textContent='次の画面 →';
      next.onclick=()=>{
        const index=steps.findIndex(([id])=>id===activeStep);
        setStep(steps[Math.min(steps.length-1,index+1)][0],false);
        setTab('work',true);
      };
      footer.append(previous,hint,next);
      flow.after(footer);
      flow.addEventListener('change',event=>{
        if(event.target.matches('.ticketAssistStepCheck')) refreshStepStates();
      });
    }
    nav.onclick=event=>{
      const button=event.target.closest('button[data-ticket-tab]');
      if(button) setTab(button.dataset.ticketTab,true);
    };
    nav.onkeydown=event=>{
      const current=event.target.closest('button[data-ticket-tab]');
      if(!current || !['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
      const keys=[...buttons.keys()];
      const index=keys.indexOf(current.dataset.ticketTab);
      if(index<0) return;
      event.preventDefault();
      const nextIndex=event.key==='Home'?0:event.key==='End'?keys.length-1:event.key==='ArrowRight'?(index+1)%keys.length:(index+keys.length-1)%keys.length;
      const nextKey=keys[nextIndex];
      setTab(nextKey,false);
      buttons.get(nextKey)?.focus({preventScroll:true});
    };
    function reveal(element){
      if(!host.contains(element)) return;
      const pane=element.closest('.ticketWorkspacePane');
      if(pane) setTab(pane.dataset.ticketPane,false);
      const step=element.closest('.supportLinearCard');
      if(step && steps.some(([id])=>id===step.id)) setStep(step.id,false);
    }
    const inProgressIds=new Set([
      'ticketMessageBody','ticketAiIncidentContext','ticketRemoteAction',
      'ticketRemoteResultNote','ticketKnowledgeSearch','ticketProfileInternalNote',
      'ticketProfilePriority','ticketProfileAssigned','ticketProfileAsset',
      'ticketProfileContract','ticketFirstResponseDue','ticketResolutionDue'
    ]);
    const markEdited=event=>{
      if(inProgressIds.has(event.target?.id)) event.target.dataset.ticketUnsaved='1';
    };
    deck.addEventListener('input',markEdited);
    deck.addEventListener('change',markEdited);
    activeController={ticketId,panes,reveal};
    host.classList.add('ticketTabsEnabled');
    if(steps.length) setStep(activeStep,false);
    setTab(activeTab,false);
  }
  function revealAndScroll(element,options={behavior:'smooth',block:'start'}){
    if(!element) return;
    const host=document.getElementById('ticketDetailHost');
    if(activeController && host?.contains(element)) activeController.reveal(element);
    element.scrollIntoView(options);
  }
  function inProgressHost(ticketId){
    const host=document.getElementById('ticketDetailHost');
    return activeController?.ticketId===String(ticketId)&&host?.classList.contains('ticketTabsEnabled')?host:null;
  }
  // Returning to a case or changing tabs never writes to the database.
  // Preserve only local transient fields and File objects during a full ticket re-render.
  function captureInProgress(ticketId){
    const host=inProgressHost(ticketId);
    if(!host) return null;
    const fields={};
    for(const id of ['ticketAiIncidentContext','ticketRemoteAction','ticketRemoteResultNote','ticketKnowledgeSearch']){
      const el=host.querySelector('#'+id);
      if(el?.dataset.ticketUnsaved==='1') fields[id]=el.value;
    }
    const input=host.querySelector('#ticketMessageFiles');
    const files=input?[...input.files]:[];
    return {ticketId:String(ticketId),fields,files};
  }
  function restoreInProgress(ticketId,snapshot){
    const host=inProgressHost(ticketId);
    if(!host||snapshot?.ticketId!==String(ticketId)) return;
    for(const [id,value] of Object.entries(snapshot.fields||{})){
      const el=host.querySelector('#'+id);
      if(!el) continue;
      el.value=value;
      el.dataset.ticketUnsaved='1';
      el.dispatchEvent(new Event('input',{bubbles:true}));
    }
    if(snapshot.files?.length){
      const input=host.querySelector('#ticketMessageFiles');
      if(input && typeof DataTransfer!=='undefined'){
        try{
          const transfer=new DataTransfer();
          snapshot.files.forEach(file=>transfer.items.add(file));
          input.files=transfer.files;
          input.dispatchEvent(new Event('change',{bubbles:true}));
        }catch(error){
          console.warn('Unable to restore in-progress ticket attachments',error);
        }
      }
    }
  }
  function hasUnsentEdits(ticketId){
    const host=inProgressHost(ticketId);
    if(!host) return false;
    const body=host.querySelector('#ticketMessageBody');
    const files=host.querySelector('#ticketMessageFiles');
    const reply=host.querySelector('#ticketMessageReplyContext');
    return !!(body?.value.trim()||files?.files.length||
      (reply&&!reply.classList.contains('hidden'))||
      host.querySelector('[data-ticket-unsaved="1"]'));
  }
  function showPendingMessage(ticketId,label,refresh){
    const host=inProgressHost(ticketId);
    if(!host) return;
    const tab=host.querySelector('#ticketWorkspaceTab_messages');
    if(tab && !tab.dataset.hasPendingMessage){
      tab.dataset.hasPendingMessage='1';
      tab.textContent='連絡・返信 ●';
    }
    const pane=host.querySelector('#ticketWorkspacePane_messages');
    if(!pane) return;
    let banner=pane.querySelector('#ticketPendingNewMessage');
    if(banner) return;
    banner=document.createElement('div');
    banner.id='ticketPendingNewMessage';
    banner.className='notice warn';
    banner.setAttribute('role','status');
    const message=document.createElement('strong');
    message.textContent=(label||'新着メッセージ')+'があります。入力・添付を保護するため自動更新を停止しました。';
    const actions=document.createElement('div');
    actions.className='supportQuickActions';
    actions.style.marginTop='8px';
    const button=document.createElement('button');
    button.type='button';
    button.className='ghost';
    button.textContent='最新を読み込む';
    button.onclick=async()=>{
      if(hasUnsentEdits(ticketId) && !window.confirm(
        '入力中の内容があります。添付ファイルの保持を試みますが、引用返信の設定は解除されます。最新の案件情報を読み込みますか？'
      )) return;
      button.disabled=true;
      try{await refresh();}catch(error){
        button.disabled=false;
        console.error('Ticket message refresh failed',error);
      }
    };
    actions.append(button);
    banner.append(message,actions);
    pane.prepend(banner);
  }
  function moveAudit(ticketId){
    const host=document.getElementById('ticketDetailHost');
    if(!activeController||activeController.ticketId!==String(ticketId)||!host) return;
    const audit=host.querySelector(':scope > .entityAuditSection');
    if(audit) activeController.panes.get('history')?.append(audit);
  }
  window.QuoteFlowTicketTabs={mount,revealAndScroll,moveAudit,captureInProgress,restoreInProgress,hasUnsentEdits,showPendingMessage};
})();
