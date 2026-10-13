import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('assets/operations-ui.css','utf8');

const head=html.split('</head>')[0];
const stylesheet='<link rel="stylesheet" href="./assets/operations-ui.css">';
const stylesheetAt=head.indexOf(stylesheet);
const inlineStyleEnd=head.lastIndexOf('</style>');
assert.ok(inlineStyleEnd>=0,'Embedded application styles must remain');
assert.ok(stylesheetAt>inlineStyleEnd,'Operations UI stylesheet must load after the existing styles');
assert.ok(html.includes('<nav id="navMenu"'),'Existing navigation must be preserved');

for(const selector of ['.appShell','.side','.navBtn.active','.workspaceHead','.kpi','.tableWrap','.workspaceTab.active']){
  assert.ok(css.includes(selector),'Missing business UI styling for '+selector);
}
assert.ok(css.includes('@media(max-width:980px)'),'Tablet navigation must be responsive');
assert.ok(css.includes('@media(max-width:780px)'),'Mobile header and tables must be responsive');
assert.ok(css.includes(':focus-visible'),'Keyboard users must be able to see focus');

for(const role of ['support_staff','customer_user']){
  for(const selector of ['.brand','.brandBlock .sub','.headerActions']){
    assert.ok(css.includes('body[data-role="'+role+'"] '+selector),
      'Role '+role+' must preserve header readability: '+selector);
  }
}

const homeStart=html.indexOf('  async function renderHome(){');
const supportStart=html.indexOf("    if(role==='support_staff'){",homeStart);
assert.ok(homeStart>=0&&supportStart>homeStart,'Internal dashboard block must be present');
const internalHome=html.slice(homeStart,supportStart);
for(const id of ['internalPriority','internalTodayWork','internalRegularWork','internalOperationsDetails']){
  assert.equal(internalHome.split('id="'+id+'"').length-1,1,'Dashboard section missing or duplicated: '+id);
}
assert.ok(internalHome.indexOf('id="internalPriority"')<internalHome.indexOf('id="internalTodayWork"'),"Priority cases must appear before today's work");
assert.ok(internalHome.indexOf('id="internalTodayWork"')<internalHome.indexOf('id="internalRegularWork"'),"Today's work must appear before routine KPIs");
assert.ok(internalHome.includes('class="internalDashNav"'),'Dashboard section shortcuts must exist');
assert.ok(internalHome.includes("target.tagName==='DETAILS'"),'Dashboard navigation must expand collapsed detail lists');
assert.ok(internalHome.includes('data-focus="unassigned"'),'Unassigned support cases must be directly accessible');
assert.ok(internalHome.includes("rpcOptional('callconnect_dashboard'"),'CallConnect failures must not block the whole dashboard');
for(const selector of ['.internalDashNav','.internalDashDetails','.internalCommandCenter .supportTodayGrid']){
  assert.ok(css.includes(selector),'Dashboard responsive styling missing: '+selector);
}

console.log('Operations UI stylesheet integration checks passed.');
