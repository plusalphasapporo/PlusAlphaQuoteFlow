import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
// Extract the actual modal implementation without executing the full authenticated app.
const src=fs.readFileSync('index.html','utf8');
const begin=src.indexOf('  function closeAppModal(){');
const end=src.indexOf('  function localDateValue(',begin);
assert.ok(begin>=0&&end>begin,'Shared modal must be present');
const js=src.slice(begin,end);
const dom=new JSDOM('<!doctype html><body><div id="home"></div></body>',{url:'https://staging.example/'});
const {document,Event,KeyboardEvent}=dom.window;
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const errors=[];
const scope={document,$,esc,toast:msg=>errors.push(msg),console};
vm.createContext(scope);
vm.runInContext(js+';globalThis.modalApi={openModal,closeModal};',scope);
const {openModal,closeModal}=scope.modalApi;
const wait=()=>new Promise(resolve=>setTimeout(resolve,0));
for(const [label,selector] of [
 ['物件・残債','#cpName'],['月額支払','#cmCategory'],
 ['管理情報','#cmiCategory'],['営業対応履歴','#cshSubject']
]){
 openModal({title:label,body:'<label>入力<input id="'+selector.slice(1)+'" required></label>',onSubmit:async()=>{}});
 assert.ok($('#appModalLayer')&&$(selector),label+' dialog must open');
 $('#sharedModalCancel').click();
 assert.equal($('#appModalLayer'),null,label+' cancel');
}
let calls=0,resolve;
openModal({title:'保存',body:'<input id="requiredField" required>',onSubmit:async()=>{calls++;await new Promise(r=>resolve=r);}});
let form=$('#sharedModalForm'),save=$('#sharedModalSave');
assert.equal(form.checkValidity(),false,'required fields must be validated');
form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
await wait();
assert.equal(calls,0,'required field must prevent submit');
$('#requiredField').value='ok';
form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
assert.equal(save.disabled,true,'submission in progress');
form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
await wait();assert.equal(calls,1,'prevent double submit');
resolve();await wait();
assert.equal($('#appModalLayer'),null,'successful submit closes modal');
openModal({title:'error',body:'<input>',onSubmit:async()=>{throw Error('保存できません');}});
form=$('#sharedModalForm');
form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
await wait();
assert.match($('#sharedModalMsg').textContent,/保存できません/);
assert.equal($('#sharedModalSave').disabled,false);
$('#sharedModalClose').click();assert.equal($('#appModalLayer'),null);
openModal({title:'escape',body:'<input>',onSubmit:async()=>{}});
$('#appModalLayer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
assert.equal($('#appModalLayer'),null);
openModal({title:'backdrop',body:'<input>',onSubmit:async()=>{}});
$('#appModalLayer').click();assert.equal($('#appModalLayer'),null);
closeModal();
assert.deepEqual(errors,[]);
dom.window.close();
console.log('Shared create modal DOM tests passed: four forms, required input, save, error, cancel, double-submit, escape and backdrop.');
