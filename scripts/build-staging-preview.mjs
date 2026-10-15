import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Security gate: ONLY build a staging-bound preview. Never publish this
// staging Supabase configuration as a Vercel production deployment.
const STAGING_REF = 'dqtqoghnctdqoljxbjjz';
const STAGING_URL = 'https://' + STAGING_REF + '.supabase.co';
const STAGING_WSS = 'wss://' + STAGING_REF + '.supabase.co';
const BUILD_COMMAND = 'node scripts/build-staging-preview.mjs';
const OUT = 'dist';

function block(message) {
  console.error('QuoteFlow STAGING PREVIEW blocked: ' + message);
  process.exit(1);
}
if (process.env.VERCEL_ENV !== 'preview') {
  block('Only preview deployments are authorized for this staging-bound repository.');
}
if (process.env.VERCEL_GIT_REPO_OWNER &&
  process.env.VERCEL_GIT_REPO_OWNER !== 'plusalphasapporo') {
  block('Unreviewed repository owner');
}
if (process.env.VERCEL_GIT_REPO_SLUG &&
  process.env.VERCEL_GIT_REPO_SLUG !== 'PlusAlphaQuoteFlow') {
  block('Unreviewed repository name');
}
const html = fs.readFileSync('index.html', 'utf8');
const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const m = html.match(/const supabase\s*=\s*createClient\(\s*"(https:\/\/[a-z0-9]{20}\.supabase\.co)"\s*,\s*"(sb_publishable_[A-Za-z0-9_-]+)"/);
if (!m || m[1] !== STAGING_URL) block('Supabase browser client must target staging.');
if (!html.includes("const AUTH_STORAGE_KEY = 'sb-" + STAGING_REF + "-auth-token';")) {
  block('Supabase auth storage is not scoped to staging.');
}
const metaCsp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
const headerCsp = config.headers?.flatMap(rule => rule.headers || [])
  .find(header => String(header.key || '').toLowerCase() === 'content-security-policy')?.value;
if (![metaCsp,headerCsp].every(csp => typeof csp === 'string' &&
  csp.includes(STAGING_URL) && csp.includes(STAGING_WSS))) {
  block('CSP must restrict API traffic to staging.');
}
if (config.buildCommand !== BUILD_COMMAND || config.outputDirectory !== OUT ||
  config.framework !== null) {
  block('Vercel must use the reviewed preview build and dist output.');
}
const files = [
  'index.html',
  'ui/workspace-redesign.css',
  'ui/workspace-redesign.js'
];
for (const file of files) {
  if (!fs.existsSync(file)) block('Missing reviewed file: ' + file);
}
if (!html.includes('href="./ui/workspace-redesign.css"') ||
    !html.includes('src="./ui/workspace-redesign.js"')) {
  block('The approved UI files must be referenced by the application.');
}
const check = spawnSync(process.execPath, ['--check','ui/workspace-redesign.js'], {encoding:'utf8'});
if (check.status !== 0) block('Redesigned UI script syntax check failed.');
// Avoid accidental publication of build scripts, migrations, or source secrets.
fs.rmSync(OUT, {recursive:true, force:true});
for (const file of files) {
  const dest = path.join(OUT,file);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.copyFileSync(file,dest);
}
for (const file of files) {
  const dest=path.join(OUT,file);
  if (!fs.statSync(dest).isFile()) block('Missing built asset: ' + file);
}
console.log('QuoteFlow STAGING PREVIEW ready: ' + files.join(', '));
