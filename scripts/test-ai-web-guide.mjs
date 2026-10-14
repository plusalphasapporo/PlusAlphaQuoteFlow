/**
 * QuoteFlow AI Web Guide: mocked end-to-end regression checks.
 * Runs the production Edge Function source with a synthetic authenticated
 * context and a fake OpenAI web search response.
 * NEVER touches the live Supabase project or OpenAI API.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync('supabase/functions/ai-web-guide/index.ts', 'utf8');
assert.match(source, /withSupabase\(\{\s*auth:\s*'user'\s*\}/);
let script = source
  .replace("import { withSupabase } from 'npm:@supabase/server'",
           'const withSupabase = (_opts, handler) => handler')
  .replace('export default {', 'globalThis.__aiWebGuide = {');
assert.notEqual(script, source, 'Edge Function must use the expected source structure');
script = stripTypeScriptTypes(script);

const state = {
  profiles: [{ user_id: '11111111-1111-4111-8111-111111111111', role: 'support_staff', is_active: true }],
  support_tickets: [
    { id: '22222222-2222-4222-8222-222222222222', customer_id: '33333333-3333-4333-8333-333333333333' },
    { id: '44444444-4444-4444-8444-444444444444', customer_id: '55555555-5555-4555-8555-555555555555' }
  ],
  knowledge_articles: [],
  webCalls: [],
  allowTicket: true,
  upstreamOk: true,
  persistOk: true
};

function selectBuilder(table) {
  let checks = [];
  let inserted = null;
  const api = {
    select() { return api; },
    eq(field, value) { checks.push(row => row[field] === value); return api; },
    contains(field, values) {
      checks.push(row => values.every(value => (row[field] || []).includes(value)));
      return api;
    },
    order() { return api; },
    async limit(max) {
      return { data: state[table].filter(row => checks.every(fn => fn(row))).slice(0, max), error: null };
    },
    async single() {
      if (inserted) return { data: { id: inserted.id }, error: null };
      const result = state[table].filter(row => checks.every(fn => fn(row)));
      const accessible = table !== 'support_tickets' || state.allowTicket;
      return accessible && result.length
        ? { data: result[0], error: null }
        : { data: null, error: { message: 'Not found' } };
    },
    insert(row) {
      assert.equal(table, 'knowledge_articles');
      if (!state.persistOk) {
        // Deliberately return an error without inserting anything.
        return {
          select() {
            return {
              async single() { return { data: null, error: { message: 'Test-only write failure' } }; }
            };
          }
        };
      }
      inserted = { ...row, id: 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(state.knowledge_articles.length + 1).padStart(12, '0'),
        created_at: new Date().toISOString() };
      state[table].push(inserted);
      return api;
    }
  };
  return api;
}

const ctx = {
  jwtClaims: { sub: state.profiles[0].user_id },
  supabase: { from: selectBuilder },
  supabaseAdmin: {
    from: selectBuilder,
    async rpc(name) {
      assert.equal(name, 'openai_service_credentials');
      return { data: { api_key: 'example-test-key-not-a-secret', analysis_model: 'test-web-search-model' }, error: null };
    }
  }
};

async function fakeFetch(url, init) {
  if (url === 'https://api.openai.com/v1/models/test-web-search-model') {
    assert.equal(init.method, 'GET');
    return Response.json({id:'test-web-search-model'});
  }
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer example-test-key-not-a-secret');
  const request = JSON.parse(init.body);
  assert.equal(request.tools[0].type, 'web_search');
  assert.equal(request.store, false);
  const technicalInput = request.input.find(item => item.role === 'user').content[0].text;
  state.webCalls.push(technicalInput);
  if (!state.upstreamOk) return Response.json({ error: { message: 'Synthetic provider failure' } }, { status: 503 });
  return Response.json({
    output: [
      { type: 'web_search_call',
        action: { sources: [{ title: 'Microsoft Learn', url: 'https://learn.microsoft.com/en-us/windows/' }] } },
      { type: 'message',
        content: [{ type: 'output_text',
          text: '手順1: 印刷キューを開く。\n手順2: 印刷状態を確認する。' }] }
    ]
  });
}

const sandbox = {
  Response, URL, AbortController, DOMException, TextEncoder, crypto: webcrypto,
  setTimeout, clearTimeout, Date, console,
  fetch: fakeFetch
};
runInNewContext(script, sandbox);
assert.equal(typeof sandbox.__aiWebGuide?.fetch, 'function');

const ticketA = state.support_tickets[0].id;
const ticketB = state.support_tickets[1].id;
async function request(body) {
  const response = await sandbox.__aiWebGuide.fetch(
    { method: 'POST', async json() { return body; } }, ctx);
  return { status: response.status, body: await response.json() };
}

// Read-only preflight must not call the provider, save records or disclose the API key.
const baselineCount=state.knowledge_articles.length;
let preflight=await request({ticketId:ticketA, diagnostics:true});
assert.equal(preflight.status,200);
assert.equal(preflight.body.diagnostics,true);
assert.equal(preflight.body.ready,true);
assert.equal(preflight.body.checks.knowledgeRead,true);
assert.equal(preflight.body.checks.aiConfigured,true);
assert.equal(state.webCalls.length,0);
assert.equal(state.knowledge_articles.length,baselineCount);
assert.doesNotMatch(JSON.stringify(preflight.body),/example-test-key|customer_id|33333333/);
const providerPreflight=await request({ticketId:ticketA,diagnostics:true,checkProvider:true});
assert.equal(providerPreflight.status,200);
assert.equal(providerPreflight.body.checks.modelAccessible,true);
assert.equal(providerPreflight.body.checks.modelStatus,'ok');
assert.equal(providerPreflight.body.billingVerified,false);
assert.equal(providerPreflight.body.generationVerified,false);
assert.equal(state.webCalls.length,0);
assert.equal(state.knowledge_articles.length,baselineCount);


// Input checks must block incomplete requests before calling the paid provider.
let res = await request({ ticketId: ticketA });
assert.equal(res.status, 400);
assert.equal(state.webCalls.length, 0);

state.allowTicket = false;
res = await request({ ticketId: ticketA, query: 'Windows 11 プリンターの印刷キュー' });
assert.equal(res.status, 404);
assert.equal(state.webCalls.length, 0);
state.allowTicket = true;

state.profiles[0].role = 'customer_user';
res = await request({ ticketId: ticketA, query: 'Windows 11 プリンターの印刷キュー' });
assert.equal(res.status, 403);
assert.equal(state.webCalls.length, 0);
state.profiles[0].role = 'support_staff';

// First look-up must research the web and save a non-public draft.
const query = 'Windows 11 プリンターの印刷キュー';
res = await request({ ticketId: ticketA, query });
assert.equal(res.status, 200);
assert.equal(res.body.fromCache, false);
assert.equal(res.body.saved, true);
assert.equal(res.body.verifiedByStaff, false);
assert.ok(res.body.text.includes('手順1'));
assert.equal(res.body.sources[0].url, 'https://learn.microsoft.com/en-us/windows/');
assert.equal(state.webCalls.length, 1);
assert.equal(state.knowledge_articles.length, 1);
assert.equal(state.knowledge_articles[0].is_active, false);
assert.equal(state.knowledge_articles[0].audience, 'support');
assert.ok(state.knowledge_articles[0].tags.includes('AI仮保存'));

// Second identical look-up must re-use the draft with its real citations.
res = await request({ ticketId: ticketA, query });
assert.equal(res.status, 200);
assert.equal(res.body.fromCache, true);
assert.equal(res.body.saved, true);
assert.equal(res.body.text, '手順1: 印刷キューを開く。\n手順2: 印刷状態を確認する。');
assert.equal(res.body.sources[0].title, 'Microsoft Learn');
assert.equal(state.webCalls.length, 1, 'Second request must not use the paid API');
assert.equal(state.knowledge_articles.length, 1, 'Second request must not create duplicate draft');

// A different customer is intentionally not permitted to re-use this cache.
res = await request({ ticketId: ticketB, query });
assert.equal(res.body.fromCache, false);
assert.equal(state.webCalls.length, 2);
assert.equal(state.knowledge_articles.length, 2);

// Refresh should research again and retain the original for audit history.
res = await request({ ticketId: ticketA, query, refresh: true });
assert.equal(res.body.fromCache, false);
assert.equal(state.webCalls.length, 3);
assert.equal(state.knowledge_articles.length, 3);

// Synthetic PII-like tokens must not appear in the outgoing search input.
res = await request({ ticketId: ticketA,
  query: 'Windows11 印刷できない 192.168.1.25 person@example.com C:\\Users\\private\\files' });
assert.equal(res.status, 200);
const outbound = state.webCalls.at(-1);
assert.doesNotMatch(outbound, /192\.168\.1\.25|person@example\.com|C:\\Users/i);
assert.match(outbound, /\[IP省略\]/);
assert.match(outbound, /\[メール省略\]/);
assert.match(outbound, /\[パス省略\]/);

// Fail closed: no fake success status on an unsuccessful draft write.
state.persistOk = false;
res = await request({ ticketId: ticketA, query: 'Windows 10 印刷スプーラーの停止' });
assert.equal(res.status, 200);
assert.equal(res.body.saved, false);
assert.equal(res.body.saveError, 'DRAFT_SAVE_FAILED');
state.persistOk = true;

state.upstreamOk = false;
res = await request({ ticketId: ticketA, query: 'Windows 11 コントロールパネル印刷設定' });
assert.equal(res.status, 502);
assert.equal(res.body.error, 'WEB_RESEARCH_FAILED');

console.log('AI Web Guide mocked E2E passed: authorization, web research, private draft save, reuse, refresh, tenant separation, redaction, error handling.');
