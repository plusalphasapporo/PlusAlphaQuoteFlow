import fs from 'node:fs';
import path from 'node:path';

// QuoteFlow Cloud currently contains public configuration for STAGING only.
// Production must use a separately reviewed, environment-specific build.
const STAGING_REF = 'dqtqoghnctdqoljxbjjz';
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
const STAGING_WSS = `wss://${STAGING_REF}.supabase.co`;
const expectedRepo = 'PlusAlphaQuoteFlow';
const expectedOwner = 'plusalphasapporo';

function fail(message) {
  console.error('QuoteFlow preview build blocked: ' + message);
  process.exit(1);
}

if (process.env.VERCEL_ENV !== 'preview') {
  fail('Only Vercel Preview may build this staging-bound application. Production configuration has not been approved.');
}
if (process.env.VERCEL_GIT_REPO_SLUG && process.env.VERCEL_GIT_REPO_SLUG !== expectedRepo) {
  fail('Connected Git repository does not match the reviewed PlusAlphaQuoteFlow repository.');
}
if (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_OWNER !== expectedOwner) {
  fail('Connected Git repository owner does not match the reviewed organization.');
}

const html = fs.readFileSync('index.html', 'utf8');
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const client = html.match(/const supabase\s*=\s*createClient\(\s*"(https:\/\/[a-z0-9]{20}\.supabase\.co)"\s*,\s*"(sb_publishable_[A-Za-z0-9_-]+)"/);
if (!client || client[1] !== STAGING_URL) {
  fail('Browser Supabase client is not explicitly configured for the staging project.');
}
if (!html.includes(`const AUTH_STORAGE_KEY = 'sb-${STAGING_REF}-auth-token';`)) {
  fail('Browser auth-storage namespace does not match the staging project.');
}
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i);
const headers = vercel.headers?.flatMap(rule => rule.headers || []) || [];
const headerCsp = headers.find(header => header.key?.toLowerCase() === 'content-security-policy')?.value;
if (!meta || !headerCsp || ![meta[1], headerCsp].every(csp => csp.includes(STAGING_URL) && csp.includes(STAGING_WSS))) {
  fail('HTML and Vercel Content-Security-Policy must both restrict connectivity to staging.');
}
if (vercel.outputDirectory !== 'dist' || vercel.buildCommand !== 'node scripts/build-staging-preview.mjs') {
  fail('Vercel must execute this safety check and serve only the reviewed dist directory.');
}

const cssSource = path.join('assets', 'operations-ui.css');
if (!fs.existsSync(cssSource) || !html.includes('./assets/operations-ui.css')) {
  fail('Required operations UI stylesheet was not found.');
}

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync(path.join('dist', 'assets'), { recursive: true });
fs.copyFileSync('index.html', path.join('dist', 'index.html'));
fs.copyFileSync(cssSource, path.join('dist', cssSource));
console.log('QuoteFlow STAGING PREVIEW build ready: reviewed HTML and operations stylesheet only.');
