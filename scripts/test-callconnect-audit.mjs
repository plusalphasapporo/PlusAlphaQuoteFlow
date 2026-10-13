import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync('supabase/functions/callconnect-records-sync/index.ts', 'utf8');
assert.match(source, /const \{error: auditError\} = await admin\.from\("audit_logs"\)\.insert\(\{/);
assert.match(source, /if \(auditError\)/);
assert.match(source, /callconnect_transcript_cron_audit_failed/);
assert.doesNotMatch(source, /\.insert\([\s\S]*?\)\.catch\(/);
console.log('CallConnect audit regression check passed.');
