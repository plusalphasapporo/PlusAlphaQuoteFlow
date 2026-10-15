/**
 * CallConnect transcript history regression tests.
 * Tests the exact production click handler against synthetic records only.
 * Live Supabase/CallConnect/OpenAI and real customer data are never accessed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const html=fs.readFileSync('index.html','utf8');
const sql=fs.readFileSync('supabase/migrations/20261015003000_callconnect_transcript_history_viewer.sql','utf8');
assert.match(sql, /'has_transcript',nullif\(btrim\(cc\.transcript_text\),''\) is not null/);
assert.match(sql, /'has_recording',nullif\(btrim\(cc\.voice_url\),''\) is not null/);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.callconnect_record_transcript\(p_call_id uuid\)/);
assert.match(sql, /RETURNS jsonb[\s\S]*?LANGUAGE sql\s+STABLE SECURITY INVOKER/);
assert.match(sql, /v_role NOT IN \('internal_admin','internal_staff','support_staff'\)/);
assert.match(sql, /v_role IN \('internal_admin','internal_staff'\)/);
assert.match(sql, /sa\.customer_id=cc\.matched_customer_id[\s\S]*?sa\.support_company_id=v_company/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.callconnect_record_transcript\(uuid\) FROM PUBLIC/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.callconnect_record_transcript\(uuid\) TO authenticated/);
assert.doesNotMatch(sql.split("CREATE OR REPLACE FUNCTION public.callconnect_record_transcript")[0],/select\s+cc\.transcript_text\s+from\s+public\.callconnect_calls/i,
  'Bulk history should not return transcript text');

assert.match(html, /'文字起こし','顧客照合','案件','操作'/);
assert.match(html, /x\.has_transcript[\s\S]{0,240}callconnectTranscriptOpen/);
assert.match(html, /x\.has_recording[\s\S]{0,250}callconnectTranscriptOpen/);

const start=html.indexOf("    // Transcripts are sensitive call content.");
const end=html.indexOf("    document.querySelectorAll('.callconnectTicketOpen')",start);
assert.ok(start>=0&&end>start,'CallConnect transcript handlers found');
const handler=html.slice(start,end);
assert.match(handler, /rpc\('callconnect_record_transcript',\{p_call_id:call\.id\},\{readOnly:true\}\)/);
assert.match(handler, /esc\(transcript\)/,'Always escape transcript text when rendering HTML');
assert.match(handler, /navigator\.clipboard\.writeText\(transcript\)/,'Explicit copy control');
assert.doesNotMatch(handler, /fetch\(|openai/i,'Reading a transcript must not trigger AI billing or remote download');

const safeEscape=v=>String(v??'')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function fixture(record){
  const dom=new JSDOM('<!doctype html><html><body><button class="callconnectTranscriptOpen" data-call-id="call-1">全文を開く</button></body></html>',{
    url:'https://quote-flow-staging.example/',runScripts:'outside-only'
  });
  const doc=dom.window.document, calls=[{
    id:'call-1',contact_name:'デモ顧客',call_ended_at:'2026-10-15T00:00:00Z'
  }];
  const rpcCalls=[],copied=[],toasts=[];
  const scope={
    document:doc,calls,
    $:selector=>doc.querySelector(selector),
    esc:safeEscape,
    dateTimeText:x=>String(x??''),
    mountAppModal:html=>{
      doc.querySelector('#appModalLayer')?.remove();
      doc.body.insertAdjacentHTML('beforeend','<div id="appModalLayer">'+html+'</div>');
    },
    closeAppModal:()=>doc.querySelector('#appModalLayer')?.remove(),
    navigator:{clipboard:{writeText:async text=>{copied.push(text);}}},
    rpc:async(name,args,options)=>{
      rpcCalls.push({name,args,options});
      assert.equal(name,'callconnect_record_transcript');
      assert.deepEqual(JSON.parse(JSON.stringify(args)),{p_call_id:'call-1'});
      assert.equal(options.readOnly,true);
      if(record instanceof Error)throw record;
      return record;
    },
    toast:msg=>toasts.push(msg)
  };
  vm.createContext(scope);
  vm.runInContext(handler,scope);
  const btn=doc.querySelector('.callconnectTranscriptOpen');
  async function open(){assert.ok(btn.onclick);await btn.onclick();}
  return {dom,doc,btn,open,rpcCalls,copied,toasts};
}

{
  const payload='<script>window.stolen=true</script> & <b>機械のエラー</b>';
  const h=fixture({status:'ready',transcript_text:payload,transcription_provider:'callconnect',transcript_synced_at:'2026-10-15T00:00:00Z'});
  assert.equal(h.rpcCalls.length,0,'Do not load transcript text on page render');
  await h.open();
  assert.equal(h.rpcCalls.length,1,'Fetch on explicit button click only');
  assert.equal(h.doc.querySelector('#callconnectTranscriptBody script'),null,'No script nodes from transcript text');
  assert.equal(h.doc.querySelector('#callconnectTranscriptBody b'),null,'No HTML formatting from untrusted text');
  assert.ok(h.doc.querySelector('#callconnectTranscriptBody').textContent.includes(payload),'Full original text remains visible');
  await h.doc.querySelector('#callconnectTranscriptCopy').onclick();
  assert.deepEqual(h.copied,[payload],'Copy exports the exact original transcript');
  assert.equal(h.btn.disabled,false);
  h.dom.window.close();
}
{
  const h=fixture({status:'pending',transcript_text:null});
  await h.open();
  assert.match(h.doc.querySelector('#callconnectTranscriptBody').textContent,/再同期/);
  assert.equal(h.doc.querySelector('#callconnectTranscriptCopy'),null);
  h.dom.window.close();
}
{
  const h=fixture({status:'no_recording',transcript_text:null});
  await h.open();
  assert.match(h.doc.querySelector('#callconnectTranscriptBody').textContent,/録音がない/);
  assert.equal(h.doc.querySelector('#callconnectTranscriptCopy'),null);
  h.dom.window.close();
}
{
  const h=fixture({status:'failed',transcript_text:null});
  await h.open();
  assert.match(h.doc.querySelector('#callconnectTranscriptBody').textContent,/文字起こしに失敗/);
  h.dom.window.close();
}
{
  const h=fixture(null);
  await h.open();
  assert.match(h.doc.querySelector('#callconnectTranscriptBody').textContent,/表示権限がありません/);
  h.dom.window.close();
}
{
  const h=fixture(new Error('permission denied'));
  await h.open();
  assert.match(h.doc.querySelector('#callconnectTranscriptBody').textContent,/取得に失敗しました/);
  assert.equal(h.btn.disabled,false);
  h.dom.window.close();
}

console.log('CallConnect transcript tests passed: role-scoped RPC migration, no eager private text, safe modal, copy, pending/no recording/error and access denied handling.');
