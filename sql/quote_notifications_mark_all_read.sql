-- QuoteFlow Cloud: mark all currently visible unread notification events as read.
-- Run only against the intended STAGING database until approved for production.
-- Existing deadline/queue alerts are not considered unread messages; acknowledging
-- a notification must never resolve an active ticket or stop an overdue alert.
create or replace function public.mark_all_quote_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_role text := (select app_private.current_role());
  v_items jsonb;
  v_payload jsonb;
  v_round integer;
  v_tickets integer := 0;
  v_handoffs integer := 0;
  v_calls integer := 0;
  v_count integer;
begin
  if v_user is null or v_role not in ('support_staff','internal_admin','internal_staff') then
    raise exception using errcode='42501', message='staff login required';
  end if;

  -- Re-query until every page has been acknowledged: the ticket and call RPCs
  -- deliberately paginate for their UI consumers.
  for v_round in 1..100 loop
    if v_role='support_staff' then
      v_payload := app_private.support_unread_notifications_impl();
      v_items := coalesce(v_payload->'items','[]'::jsonb);
    else
      v_payload := app_private.internal_unread_handoff_notifications_impl();
      v_items := coalesce(v_payload->'ticket_items','[]'::jsonb);
    end if;

    exit when jsonb_array_length(v_items)=0;

    insert into public.support_ticket_reads(ticket_id,user_id,read_at)
    select (i.item->>'id')::uuid,v_user,clock_timestamp()
    from jsonb_array_elements(v_items) as i(item)
    on conflict (ticket_id,user_id) do update set read_at=excluded.read_at;
    get diagnostics v_count = row_count;
    v_tickets := v_tickets + v_count;
  end loop;

  if v_role='support_staff' then
    v_payload := app_private.support_unread_handoff_updates_impl();
    v_items := coalesce(v_payload->'items','[]'::jsonb);
    insert into public.support_handoff_reads(handoff_id,user_id,read_at)
    select distinct (i.item->>'handoff_id')::uuid,v_user,clock_timestamp()
    from jsonb_array_elements(v_items) as i(item)
    on conflict (handoff_id,user_id) do update set read_at=excluded.read_at;
  else
    v_payload := app_private.internal_unread_handoff_notifications_impl();
    v_items := coalesce(v_payload->'items','[]'::jsonb);
    insert into public.internal_handoff_reads(handoff_id,user_id,read_at)
    select distinct (i.item->>'handoff_id')::uuid,v_user,clock_timestamp()
    from jsonb_array_elements(v_items) as i(item)
    on conflict (handoff_id,user_id) do update set read_at=excluded.read_at;
  end if;
  get diagnostics v_handoffs = row_count;

  -- The existing callconnect mark-all RPC is broader than the scoped unread
  -- list. Consume ONLY the events returned to this authenticated operator.
  for v_round in 1..100 loop
    v_payload := app_private.callconnect_unread_notifications_impl();
    v_items := coalesce(v_payload->'items','[]'::jsonb);
    exit when jsonb_array_length(v_items)=0;

    insert into public.callconnect_notification_reads(notification_id,user_id,read_at)
    select (i.item->>'id')::uuid,v_user,clock_timestamp()
    from jsonb_array_elements(v_items) as i(item)
    on conflict (notification_id,user_id) do update set read_at=excluded.read_at;
    get diagnostics v_count = row_count;
    v_calls := v_calls + v_count;
  end loop;

  return jsonb_build_object('tickets',v_tickets,'handoffs',v_handoffs,'calls',v_calls);
end;
$$;

revoke all on function public.mark_all_quote_notifications_read() from public, anon;
grant execute on function public.mark_all_quote_notifications_read() to authenticated;
