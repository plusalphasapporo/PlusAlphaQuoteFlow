import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync('supabase/functions/callconnect-records-sync/index.ts', 'utf8');
const start = source.indexOf('const {error: auditError} = await admin.from("audit_logs").insert({');
assert.ok(start >= 0, 'Awaited audit insert must be present');

const end = source.indexOf('return json(200,{', start);
assert.ok(end > start, 'Expected cron response after audit insertion');
const auditBlock = source.slice(start, end);

assert.match(auditBlock, /if \(auditError\)/);
assert.match(auditBlock, /callconnect_transcript_cron_audit_failed/);
assert.doesNotMatch(auditBlock, /\.catch\s*\(/);
assert.match(auditBlock, /code:\s*auditError\.code/);
console.log('CallConnect cron audit regression check passed.');
