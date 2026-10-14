-- QuoteFlow Cloud | migration 20261013033808
-- Exact SQL recorded by Supabase staging for support_ticket_auto_number_and_backfill.
-- Preserve sequencing before later internal ticket creation migrations.

create sequence app_private.support_ticket_app_number_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no cycle;

revoke all on sequence app_private.support_ticket_app_number_seq from public;
grant usage on sequence app_private.support_ticket_app_number_seq to authenticated, service_role;

create function app_private.assign_support_ticket_app_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_counter bigint;
begin
  if new.ticket_number is null or btrim(new.ticket_number) = '' then
    v_counter := nextval('app_private.support_ticket_app_number_seq'::regclass);
    new.ticket_number := 'TKT-APP-' ||
      case
        when length(v_counter::text) < 8 then lpad(v_counter::text, 8, '0')
        else v_counter::text
      end;
  end if;
  return new;
end;
$fn$;

revoke all on function app_private.assign_support_ticket_app_number() from public;

create trigger support_tickets_auto_number
before insert on public.support_tickets
for each row
execute function app_private.assign_support_ticket_app_number();

update public.support_tickets
set ticket_number = 'TKT-APP-' ||
  lpad(nextval('app_private.support_ticket_app_number_seq'::regclass)::text, 8, '0')
where ticket_number is null or btrim(ticket_number) = '';

alter table public.support_tickets
  alter column ticket_number set not null;

alter table public.support_tickets
  add constraint support_tickets_ticket_number_nonblank
  check (btrim(ticket_number) <> '');
