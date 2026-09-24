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
requireText('TRUST_DEVICE_KEY', 'trusted-device session handling');

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

if (failures.length) {
  console.error('\nQuoteFlow static validation failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log('QuoteFlow static validation passed.');
