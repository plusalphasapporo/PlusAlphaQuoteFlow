import assert from 'node:assert/strict';
import { test } from 'node:test';

// No credentials, recordings or customer data are used. CORS preflight must be
// allowed without a JWT, before an authenticated POST can be attempted.
const origin='https://quoteflow-cloud-staging-preview-4untrmgfz-plusalpha-apps.vercel.app';
const base='https://dqtqoghnctdqoljxbjjz.supabase.co/functions/v1';
for(const name of ['callconnect-openai-transcribe','openai-api-test']){
  test(name+' answers browser CORS preflight without credentials',async()=>{
    const response=await fetch(base+'/'+name,{
      method:'OPTIONS',
      headers:{
        Origin:origin,
        'Access-Control-Request-Method':'POST',
        'Access-Control-Request-Headers':'authorization,apikey,content-type,x-client-info'
      },
      signal:AbortSignal.timeout(20000)
    });
    assert.ok([200,204].includes(response.status),name+' returned '+response.status+' (expected 200/204)');
    const allowOrigin=response.headers.get('access-control-allow-origin');
    assert.ok(allowOrigin==='*'||allowOrigin===origin,'Missing CORS allow-origin: '+allowOrigin);
    const headers=(response.headers.get('access-control-allow-headers')||'').toLowerCase();
    for(const required of ['authorization','apikey','content-type','x-client-info']){
      assert.ok(headers.includes(required),'CORS missing allowed header: '+required);
    }
    const methods=(response.headers.get('access-control-allow-methods')||'POST, OPTIONS').toUpperCase();
    assert.ok(methods.includes('POST'),'CORS missing POST method');
  });
}
