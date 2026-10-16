import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const html=readFileSync('index.html','utf8');
const publicAssets=new Set([...html.matchAll(/(?:src|href)=["'](\.\/assets\/[^"']+)["']/g)]
 .map(x=>x[1].slice(2)));
publicAssets.add('index.html');
publicAssets.add('manifest.webmanifest');
publicAssets.add('sw.js');

test('staging builder delivers all HTML-linked browser assets byte for byte',()=>{
 const build=spawnSync(process.execPath,['scripts/build-staging-preview.mjs'],{encoding:'utf8'});
 assert.equal(build.status,0,build.stdout+'\n'+build.stderr);
 for(const file of publicAssets){
  const path=join('public',file);
  assert.ok(existsSync(path),'staging output is missing referenced browser asset: '+file);
  assert.deepEqual(readFileSync(path),readFileSync(file),'staging output differs from source: '+file);
 }
 assert.ok(!existsSync('public/sql'),'private SQL must never be served');
 assert.ok(!existsSync('public/tests'),'test fixtures must never be served');
 assert.ok(!existsSync('public/.github'),'CI workflows must never be served');
});
test('GitHub Pages verifies every browser asset that is rendered by the app',()=>{
 const workflow=readFileSync('.github/workflows/verify-pages-release.yml','utf8');
 for(const file of publicAssets)assert.ok(workflow.includes("'"+file+"'"),
   'published-file verification does not include '+file);
});
test('static validator checks syntax for all JS runtime assets and the deal stylesheets',()=>{
 const validator=readFileSync('scripts/validate-static.mjs','utf8');
 assert.match(validator,/matchAll\(\/<(?:script|link)/);
 assert.match(validator,/node.*--check|--check.*asset/);
 for(const file of publicAssets){
  if(!file.endsWith('.js'))continue;
  const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(check.status,0, 'Browser script syntax error: '+file+'\n'+check.stderr);
 }
});
