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

console.log('Operations UI stylesheet integration checks passed.');
