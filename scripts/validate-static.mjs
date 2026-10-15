import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = fs.readFileSync('index.html', 'utf8');
const failures = [];
const requireText = (needle, label) => {
  if (!html.includes(needle)) failures.push(`Missing: ${label}`);
};

requireText('<title>QuoteFlow Cloud</title>', 'QuoteFlow Cloud title');
requireText('createClient(', 'Supabase client initialization');
requireText('getAuthenticatorAssuranceLevel', 'MFA assurance-level check');
requireText('AAL2_REQUIRED', 'AAL2 enforcement handling');
requireText("redirectTo:window.location.origin+window.location.pathname", 'environment-aware auth redirect');
requireText('sessionStorage.getItem(key)', 'session-only auth storage read');
requireText('sessionStorage.setItem(key,value)', 'session-only auth storage write');
requireText("localStorage.removeItem('quoteflow_trusted_device')", 'legacy trusted-device cleanup');
requireText('localStorage.removeItem(AUTH_STORAGE_KEY)', 'persistent auth-token cleanup');

for (const forbidden of ['sb_secret_', 'SUPABASE_SERVICE_ROLE_KEY', 'service_role']) {
  if (html.includes(forbidden)) failures.push(`Forbidden browser secret marker: ${forbidden}`);
}

if (!/sb_publishable_[A-Za-z0-9_-]+/.test(html)) {
  failures.push('Missing Supabase publishable key');
}

const match = html.match(/<script\s+type=["']module["']\s*>([\s\S]*?)<\/script>/i);
if (!match) {
  failures.push('Module script block not found');
} else {
  const tmp = '.quoteflow-index-check.mjs';
  fs.writeFileSync(tmp, match[1]);
  const checked = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (checked.status !== 0) {
    failures.push(`JavaScript syntax check failed:\n${checked.stderr || checked.stdout}`);
  }
}

// Ensure the brand image referenced by both entry points is actually deployed.
const logoPath = 'assets/quoteflow-mark.png';
const logoReferenceCount = (html.match(/src="\/assets\/quoteflow-mark\.png"/g) || []).length;
if (logoReferenceCount < 2) {
  failures.push('Logo must appear in both the application header and login screen');
}
if (!html.includes('rel="icon" type="image/png" href="/assets/quoteflow-mark.png"')) {
  failures.push('QuoteFlow favicon reference is missing');
}
if (!fs.existsSync(logoPath)) {
  failures.push('QuoteFlow logo asset is missing');
} else {
  const logo = fs.readFileSync(logoPath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (logo.length < 24 || !logo.subarray(0, 8).equals(pngSignature)) {
    failures.push('QuoteFlow logo asset is not a valid PNG header');
  } else {
    const width = logo.readUInt32BE(16);
    const height = logo.readUInt32BE(20);
    if (width < 64 || height < 64 || width > 4096 || height > 4096) {
      failures.push('QuoteFlow logo dimensions are outside supported bounds');
    }
  }
}

// Notification center and installable web app checks.
requireText('<script src="/assets/notification-center.js"></script>', 'Notification-center runtime');
requireText('<link rel="manifest" href="/manifest.webmanifest">', 'Installable app manifest');
requireText("navigator.serviceWorker.register('/sw.js')", 'Service worker registration');
requireText("window.QuoteFlowNotificationCenter?.mount(", 'Notification center mounting');
requireText("mark_all_quote_notifications_read", 'Role-scoped mark-all-read RPC wiring');
if (html.includes('>🔔<')) failures.push('Legacy emoji notification icon remains');
for (const path of ['assets/notification-center.js','manifest.webmanifest','sw.js','sql/quote_notifications_mark_all_read.sql']) {
  if (!fs.existsSync(path)) failures.push('Missing notification asset: '+path);
}
for (const path of ['assets/notification-center.js','sw.js']) {
  if (fs.existsSync(path)) {
    const checked=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
    if(checked.status!==0) failures.push('Notification JavaScript syntax error: '+path+' '+(checked.stderr||checked.stdout));
  }
}
// Ensure the tabbed support-ticket UI is loaded and its implementation is syntactically valid.
requireText('<script src="/assets/support-ticket-tabs.js"></script>', 'Support ticket navigation script');
requireText('window.QuoteFlowTicketTabs?.mount(', 'Tabbed ticket detail mounting');
if (!fs.existsSync('assets/support-ticket-tabs.js')) {
  failures.push('Missing support ticket tab UI script');
} else {
  const check=spawnSync(process.execPath,['--check','assets/support-ticket-tabs.js'],{encoding:'utf8'});
  if(check.status!==0) failures.push('Support tab script syntax error: '+(check.stderr||check.stdout));
  const tabsSource=fs.readFileSync('assets/support-ticket-tabs.js','utf8');
  const navigationContracts=[
    ['tab navigation', "button.dataset.ticketTab"],
    ['workflow-aware selection', "workflowAdvanced"],
    ['workflow progress labels', "function computeStepState("],
    ['step status refresh', "function refreshStepStates("],
    ['draft capture', "function captureInProgress("],
    ['draft restoration', "function restoreInProgress("],
    ['new-message editing guard', "function hasUnsentEdits("],
    ['pending message notification', "function showPendingMessage("],
    ['leave confirmation', "function confirmLeave("],
    ['attachment input restoration', "input.dispatchEvent(new Event('change'"],
    ['unsaved case-management fields captured', "'ticketProfileInternalNote','ticketProfilePriority','ticketProfileAssigned'"],
    ['unsaved deadline fields captured', "'ticketProfileAsset','ticketProfileContract','ticketFirstResponseDue','ticketResolutionDue'"],
    ['only committed edits cleared', "function clearSavedEdits(ticketId,values)"]
  ];
  for (const [name,needle] of navigationContracts) {
    if(!tabsSource.includes(needle)) failures.push('Support ticket UI contract missing: '+name);
  }
  for (const [name,needle] of [
    ['draft snapshot before refresh', "const ticketInProgressSnapshot=window.QuoteFlowTicketTabs?.captureInProgress(t.id)"],
    ['draft restoration after refresh', "window.QuoteFlowTicketTabs?.restoreInProgress(t.id,ticketInProgressSnapshot)"],
    ['message-realtime protection', "window.QuoteFlowTicketTabs?.hasUnsentEdits(msg.ticket_id)"],
    ['back navigation uses shared route', "$('#ticketWorkspaceBack').onclick=()=>go(backPage)"],
    ['ticket close guard', "window.QuoteFlowTicketTabs?.confirmLeave(t.id)"],
    ['sidebar navigation guard', "window.QuoteFlowTicketTabs?.confirmLeave(activeTicketId)"],
    ['cross-ticket unsent draft guard', "window.QuoteFlowTicketTabs?.hasUnsentEdits(previousId)"],
    ['case-management save clears saved edits', 'window.QuoteFlowTicketTabs?.clearSavedEdits(t.id,submittedProfile)'],
    ['deadline save clears saved edits', 'window.QuoteFlowTicketTabs?.clearSavedEdits(t.id,submittedDeadlines)'],
    ['restored first response due is preserved', "firstDue.dataset.ticketUnsaved!=='1'"],
    ['restored resolution due is preserved', "resolutionDue.dataset.ticketUnsaved!=='1'"]
  ]) {
    if(!html.includes(needle)) failures.push('Ticket refresh integration missing: '+name);
  }
}

if (failures.length) {
  console.error('\nQuoteFlow static validation failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log('QuoteFlow static validation passed.');
