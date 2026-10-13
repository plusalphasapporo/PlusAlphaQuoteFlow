-- QuoteFlow Cloud: defend CallConnect->existing-ticket link against reassignment.
-- Safe to re-run. This replaces one existing function body; it does not change rows.
CREATE OR REPLACE FUNCTION app_private.attach_callconnect_ticket_impl(
  p_call_id uuid, p_customer_id uuid, p_ticket_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_role text := (select app_private.current_role());
  v_company uuid := (select app_private.current_company_id());
  v_call public.callconnect_calls%rowtype;
  v_ticket public.support_tickets%rowtype;
begin
  if coalesce(v_role, '') not in ('internal_admin','internal_staff','support_staff') then
    raise exception using errcode='42501', message='support or internal role required';
  end if;

  select * into v_call
  from public.callconnect_calls
  where id=p_call_id
  for update;

  if v_call.id is null then
    raise exception using errcode='P0002', message='CallConnect call not found';
  end if;

  -- A call may only be attached once. Never overwrite a previous link.
  if v_call.support_ticket_id is not null then
    raise exception using errcode='23505', message='CallConnect call already linked to a ticket';
  end if;

  -- Customer identity must have been confirmed independently, before attaching.
  if p_customer_id is null
     or v_call.matched_customer_id is distinct from p_customer_id
     or coalesce(v_call.match_state,'') not in ('matched','matched_manual') then
    raise exception using errcode='22023', message='call customer mismatch; confirm customer match first';
  end if;

  select * into v_ticket
  from public.support_tickets
  where id=p_ticket_id;

  if v_ticket.id is null then
    raise exception using errcode='P0002', message='support ticket not found';
  end if;

  if v_ticket.customer_id is distinct from p_customer_id then
    raise exception using errcode='22023', message='ticket customer mismatch';
  end if;

  if v_role='support_staff' and not exists(
    select 1 from public.support_assignments sa
    where sa.customer_id=p_customer_id
      and sa.support_company_id=v_company
      and sa.is_active=true
  ) then
    raise exception using errcode='42501', message='customer not assigned to this support company';
  end if;

  update public.callconnect_calls
  set support_ticket_id=p_ticket_id,
      updated_at=now()
  where id=p_call_id;

  insert into public.audit_logs(
    actor_user_id,actor_role,action,target_type,target_id,after_data,created_at
  )
  values(
    (select auth.uid()),v_role,'integration.callconnect_ticket_linked',
    'callconnect_call',p_call_id::text,
    jsonb_build_object(
      'customer_id',p_customer_id,
      'ticket_id',p_ticket_id,
      'record_id',v_call.record_id
    ),
    now()
  );

  return jsonb_build_object(
    'call_id',p_call_id,
    'customer_id',p_customer_id,
    'ticket_id',p_ticket_id
  );
end;
$function$;