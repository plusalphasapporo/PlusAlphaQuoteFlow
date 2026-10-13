-- QuoteFlow Cloud: fail closed when an internal ticket user's MFA/role cannot be verified.
-- The earlier audit permissions migration has already been applied to staging.
-- Keep the public SECURITY INVOKER RPC and all existing grants unchanged.
-- An AAL1, missing, inactive, or unauthorized user receives 42501 instead of reaching inserts.

CREATE OR REPLACE FUNCTION app_private.internal_create_support_ticket_impl(p_customer_id uuid, p_asset_id uuid, p_contract_id uuid, p_subject text, p_description text, p_priority text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text:=(select app_private.current_role());
  v_id uuid;
  v_number text;
  v_priority text:=coalesce(nullif(btrim(p_priority),''),'normal');
  v_description text;
begin
  if coalesce(v_role,'') not in ('internal_admin','internal_staff') then
    raise exception using errcode='42501',message='internal role required';
  end if;

  if not exists(select 1 from public.customers where id=p_customer_id) then
    raise exception using errcode='P0002',message='customer not found';
  end if;

  if nullif(btrim(coalesce(p_subject,'')),'') is null then
    raise exception using errcode='22023',message='subject required';
  end if;

  if v_priority not in ('low','normal','high','urgent') then
    raise exception using errcode='22023',message='invalid priority';
  end if;

  if p_asset_id is not null and not exists(
    select 1 from public.assets a where a.id=p_asset_id and a.customer_id=p_customer_id
  ) then
    raise exception using errcode='22023',message='asset must belong to customer';
  end if;

  if p_contract_id is not null and not exists(
    select 1 from public.contracts ct where ct.id=p_contract_id and ct.customer_id=p_customer_id
  ) then
    raise exception using errcode='22023',message='contract must belong to customer';
  end if;

  v_description :=
    '【受付経路】自社からチャット' ||
    case
      when nullif(btrim(coalesce(p_description,'')),'') is null then ''
      else E'\n\n' || btrim(p_description)
    end;

  insert into public.support_tickets(
    customer_id,asset_id,contract_id,subject,description,status,priority,created_by
  )
  values(
    p_customer_id,p_asset_id,p_contract_id,btrim(p_subject),
    v_description,'open',v_priority,(select auth.uid())
  )
  returning id,ticket_number into v_id,v_number;

  insert into public.audit_logs(
    actor_user_id,actor_role,action,target_type,target_id,after_data,created_at
  )
  values(
    (select auth.uid()),v_role,'ticket.created','support_ticket',v_id::text,
    jsonb_build_object(
      'ticket_number',v_number,'customer_id',p_customer_id,'asset_id',p_asset_id,
      'contract_id',p_contract_id,'priority',v_priority,'subject',btrim(p_subject),
      'source','internal_chat'
    ),now()
  );

  return jsonb_build_object('id',v_id,'ticket_number',v_number,'status','open');
end;
$function$
;
