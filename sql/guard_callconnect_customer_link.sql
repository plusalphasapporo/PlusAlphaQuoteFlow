-- Scope: public data remains unchanged; this only replaces the existing RPC implementation.
CREATE OR REPLACE FUNCTION app_private.link_callconnect_customer_impl(p_call_id uuid, p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text := (select app_private.current_role());
  v_company uuid := (select app_private.current_company_id());
  v_call public.callconnect_calls%rowtype;
begin
  if v_role not in ('internal_admin','internal_staff','support_staff') then
    raise exception using errcode='42501',message='support or internal role required';
  end if;

  if not exists(select 1 from public.customers c where c.id=p_customer_id) then
    raise exception using errcode='P0002',message='customer not found';
  end if;

  if v_role='support_staff' and not exists(
    select 1 from public.support_assignments sa
    where sa.customer_id=p_customer_id
      and sa.support_company_id=v_company
      and sa.is_active=true
  ) then
    raise exception using errcode='42501',message='customer not assigned to this support company';
  end if;

  select * into v_call
  from public.callconnect_calls
  where id=p_call_id
  for update;

  if v_call.id is null then
    raise exception using errcode='P0002',message='CallConnect call not found';
  end if;

  -- Only callers who could see this call are allowed to rematch it.
  if v_role='support_staff' and not (
    exists(
      select 1 from public.callconnect_config cfg
      where cfg.id='default' and cfg.support_company_id=v_company
    )
    or exists(
      select 1 from public.support_assignments sa
      where sa.customer_id=v_call.matched_customer_id
        and sa.support_company_id=v_company
        and sa.is_active=true
    )
  ) then
    raise exception using errcode='42501', message='call not assigned to this support company';
  end if;

  -- A linked call must never be moved to a customer different from its ticket owner.
  if v_call.support_ticket_id is not null and not exists(
    select 1 from public.support_tickets ticket
    where ticket.id=v_call.support_ticket_id
      and ticket.customer_id=p_customer_id
  ) then
    raise exception using errcode='22023', message='linked call and ticket customer mismatch';
  end if;

  update public.callconnect_calls
  set matched_customer_id=p_customer_id,
      match_state='matched_manual',
      updated_at=now()
  where id=p_call_id;

  insert into public.audit_logs(
    actor_user_id,actor_role,action,target_type,target_id,after_data,created_at
  )
  values(
    (select auth.uid()),v_role,'integration.callconnect_customer_linked',
    'callconnect_call',p_call_id::text,
    jsonb_build_object(
      'customer_id',p_customer_id,
      'record_id',v_call.record_id,
      'existing_ticket_id',v_call.support_ticket_id
    ),
    now()
  );

  return jsonb_build_object(
    'call_id',p_call_id,
    'customer_id',p_customer_id,
    'ticket_id',v_call.support_ticket_id,
    'requires_intake',v_call.support_ticket_id is null
  );
end;
$function$
;
