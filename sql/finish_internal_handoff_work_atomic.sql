-- QuoteFlow Cloud: save an internal handoff report and finish it atomically.
-- The exposed wrapper remains SECURITY INVOKER. No customer, ticket, or message data is deleted.
create or replace function app_private.finish_internal_handoff_work_impl(
  p_handoff_id uuid,
  p_result text,
  p_support_note text,
  p_close_ticket boolean
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_handoff public.support_handoffs%rowtype;
  v_status text;
  v_result_text text := btrim(coalesce(p_result,''));
  v_note text := nullif(btrim(coalesce(p_support_note,'')),'');
  v_message_text text;
  v_report_text text;
  v_message jsonb;
  v_handoff_result jsonb;
  v_completion jsonb := null;
begin
  if (select auth.uid()) is null
     or not (select app_private.is_active_user())
     or not (select app_private.is_internal()) then
    raise exception using errcode='42501', message='active internal MFA session required';
  end if;

  if p_handoff_id is null or p_close_ticket is null
     or v_result_text = '' or length(v_result_text) > 10000
     or length(coalesce(v_note,'')) > 5000 then
    raise exception using errcode='22023', message='valid handoff, action and work result are required';
  end if;

  select * into v_handoff
  from public.support_handoffs
  where id=p_handoff_id
  for update;

  if v_handoff.id is null then
    raise exception using errcode='P0002', message='handoff not found';
  end if;

  if not (select app_private.can_access_ticket(v_handoff.ticket_id)) then
    raise exception using errcode='42501', message='ticket not accessible';
  end if;

  select status into v_status
  from public.support_tickets
  where id=v_handoff.ticket_id
  for update;

  if v_status is null then
    raise exception using errcode='P0002', message='ticket not found';
  end if;

  -- Return an explicit no-op when the original request was already committed.
  -- This also makes an ambiguous network failure safe to inspect/retry.
  if v_handoff.state='completed' then
    return jsonb_build_object(
      'ticket_id',v_handoff.ticket_id,
      'handoff_id',v_handoff.id,
      'already_completed',true,
      'ticket_status',v_status
    );
  end if;

  if v_handoff.state<>'accepted' or v_status='closed' then
    raise exception using errcode='22023',
      message='handoff must be accepted and ticket must be open';
  end if;

  v_message_text := concat_ws(E'\n',
    '【自社対応結果】',
    '実施内容・確認結果: ' || v_result_text,
    case when v_note is not null then 'サポート会社への共有: ' || v_note else null end
  );

  -- These three calls share a single PostgreSQL RPC transaction.
  -- Any error rolls back the message, handoff completion and ticket closure.
  v_message := public.post_ticket_message(
    v_handoff.ticket_id,'support',v_message_text
  );

  v_handoff_result := app_private.complete_ticket_handoff_impl(
    v_handoff.id
  );

  if p_close_ticket then
    v_report_text := concat_ws(E'\n',
      '【作業報告】',
      '結果: 解決',
      '対応内容: ' || v_result_text,
      case when v_note is not null then '共有事項: ' || v_note else null end
    );
    v_completion := app_private.complete_support_ticket_with_report_impl(
      v_handoff.ticket_id,v_report_text
    );
  end if;

  return jsonb_build_object(
    'ticket_id',v_handoff.ticket_id,
    'handoff_id',v_handoff.id,
    'message_id',v_message->>'id',
    'already_completed',false,
    'closed',p_close_ticket,
    'handoff',v_handoff_result,
    'completion',v_completion
  );
end;
$function$;

revoke all on function app_private.finish_internal_handoff_work_impl(uuid,text,text,boolean) from public, anon;
grant execute on function app_private.finish_internal_handoff_work_impl(uuid,text,text,boolean) to authenticated;

create or replace function public.finish_internal_handoff_work(
  p_handoff_id uuid,
  p_result text,
  p_support_note text,
  p_close_ticket boolean
)
returns jsonb
language sql
security invoker
set search_path to ''
as $function$
  select app_private.finish_internal_handoff_work_impl($1,$2,$3,$4);
$function$;

revoke all on function public.finish_internal_handoff_work(uuid,text,text,boolean) from public, anon;
grant execute on function public.finish_internal_handoff_work(uuid,text,text,boolean) to authenticated;
