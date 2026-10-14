import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = 'supabase/migrations/20261013033808_support_ticket_auto_number_and_backfill.sql';
const sql = fs.readFileSync(file, 'utf8');
const compact = sql.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim().toLowerCase();

function check(pattern, message) {
  assert.match(compact, pattern, message);
}

check(/create sequence app_private\.support_ticket_app_number_seq/, 'The numbering sequence must be created');
check(/no cycle/, 'The sequence must not wrap back to already assigned numbers');
check(/revoke all on sequence app_private\.support_ticket_app_number_seq from public/, 'Sequence access should not be public');
check(/grant usage on sequence app_private\.support_ticket_app_number_seq to authenticated, service_role/, 'Authorized insert roles need sequence usage');
check(/create function app_private\.assign_support_ticket_app_number\(\)/, 'The trigger function must exist');
check(/security invoker/, 'The trigger must run with invoker privileges');
check(/if new\.ticket_number is null or btrim\(new\.ticket_number\) = '' then/, 'Existing explicitly assigned numbers must be preserved');
check(/new\.ticket_number := 'tkt-app-' \|\|/, 'Use the TKT-APP prefix');
check(/when length\(v_counter::text\) < 8 then lpad\(v_counter::text, 8, '0'\)/, 'New numbers should be padded to eight digits');
check(/create trigger support_tickets_auto_number before insert on public\.support_tickets for each row/, 'Assign numbers on insertion');
check(/update public\.support_tickets set ticket_number =/, 'Backfill legacy missing numbers');
check(/where ticket_number is null or btrim\(ticket_number\) = ''/, 'Backfill must not overwrite existing numbers');
check(/alter table public\.support_tickets alter column ticket_number set not null/, 'Prevent NULL ticket numbers');
check(/add constraint support_tickets_ticket_number_nonblank check \(btrim\(ticket_number\) <> ''\)/, 'Prevent blank ticket numbers');

const firstIndex = compact.indexOf('create sequence ');
const triggerIndex = compact.indexOf('create trigger ');
const backfillIndex = compact.indexOf('update public.support_tickets ');
const constraintIndex = compact.indexOf('alter table public.support_tickets alter column ticket_number');
assert.ok(firstIndex>=0 && firstIndex<triggerIndex && triggerIndex<backfillIndex && backfillIndex<constraintIndex,
  'The sequence, trigger, backfill and constraints must run in that order');

const files = fs.readdirSync('supabase/migrations').filter(x=>/^\d+_.*\.sql$/.test(x)).sort();
const numbers = files.map(x=>x.split('_')[0]);
assert.equal(new Set(numbers).size, numbers.length, 'Each migration must have a unique version');
const migrationOrder = [
  '20261013033808_support_ticket_auto_number_and_backfill.sql',
  '20261013035658_fix_internal_ticket_creation_audit_permissions.sql',
  '20261013060746_reject_unverified_internal_ticket_creation.sql'
];
for (const item of migrationOrder) assert.ok(files.includes(item), `Missing migration: ${item}`);
assert.deepEqual(
  files.filter(x=>migrationOrder.includes(x)),
  migrationOrder,
  'Staging migrations must be applied in the correct sequence'
);

const guardFile = fs.readFileSync('supabase/migrations/20261013060746_reject_unverified_internal_ticket_creation.sql','utf8');
assert.match(guardFile, /if coalesce\(v_role,''\) not in \('internal_admin','internal_staff'\) then/i);
assert.match(guardFile, /raise exception using errcode='42501'/i);

console.log('Migration release checks passed: numbering, privileges, backfill, constraints, and order.');