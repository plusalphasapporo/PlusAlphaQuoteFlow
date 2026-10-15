-- Role-filtered CallConnect contact link metadata.
CREATE OR REPLACE FUNCTION app_private.callconnect_dashboard_impl()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text := (select app_private.current_role());
  v_company uuid := (select app_private.current_company_id());
  v_cfg public.callconnect_config%rowtype;
  v_result jsonb;
begin
  if v_role not in ('internal_admin','internal_staff','support_staff') then
    raise exception using errcode='42501',message='support or internal role required';
  end if;

  select * into v_cfg from public.callconnect_config where id='default';

  if v_role='support_staff'
     and v_cfg.support_company_id is not null
     and v_cfg.support_company_id<>v_company then
    raise exception using errcode='42501',message='CallConnect integration not assigned to this support company';
  end if;

  select jsonb_build_object(
    'integration_state',coalesce((select s.state from public.integration_status s where s.integration_name='callconnect'),'disabled'),
    'last_webhook_at',v_cfg.last_webhook_at,
    'last_record_id',v_cfg.last_record_id,
    'last_error',v_cfg.last_error,
    'auto_create_tickets',v_cfg.auto_create_tickets,
    'api_key_configured',v_cfg.api_secret_id is not null,
    'api_key_configured_at',v_cfg.api_key_configured_at,
    'contacts_api_url_configured',v_cfg.contacts_api_url is not null,
    'contacts_create_api_url_configured',v_cfg.contacts_create_api_url is not null,
    'records_api_url_configured',v_cfg.records_api_url is not null,
    'last_api_check_at',v_cfg.last_api_check_at,
    'last_api_check_status',v_cfg.last_api_check_status,
    'last_api_error',v_cfg.last_api_error,
    'last_contacts_sync_at',v_cfg.last_contacts_sync_at,
    'last_records_sync_at',v_cfg.last_records_sync_at,
    'total_calls',(select count(*) from public.callconnect_calls),
    'unmatched_calls',(select count(*) from public.callconnect_calls where match_state in ('unmatched','ambiguous')),
    'linked_tickets',(select count(*) from public.callconnect_calls where support_ticket_id is not null),
    'calls',coalesce((
      select jsonb_agg(x.item order by x.received_at desc,x.id desc)
      from (
        select cc.id,cc.received_at,
          jsonb_build_object(
            'id',cc.id,
            'record_id',cc.record_id,
            'contact_id',CASE WHEN cc.contact_id ~ '^[1-9][0-9]{0,17}$' THEN cc.contact_id ELSE NULL END,
            'record_status',cc.record_status,
            'direction',cc.direction,
            'contact_number',cc.contact_number,
            'contact_name',cc.contact_name,
            'contact_company',cc.contact_company,
            'duration_seconds',cc.duration_seconds,
            'memo',cc.memo,
            'tags_text',cc.tags_text,
            'voice_url',cc.voice_url,
            'has_transcript',nullif(btrim(cc.transcript_text),'') is not null,
            'has_recording',nullif(btrim(cc.voice_url),'') is not null,
            'transcript_synced_at',cc.transcript_synced_at,
            'call_ended_at',cc.call_ended_at,
            'received_at',cc.received_at,
            'match_state',cc.match_state,
            'matched_customer_id',cc.matched_customer_id,
            'matched_customer_name',cu.name,
            'support_ticket_id',cc.support_ticket_id,
            'ticket_number',st.ticket_number,
            'ticket_subject',st.subject,
            'callconnect_user_name',cc.callconnect_user_name,
            'used_friendly_name',cc.used_friendly_name
          ) as item
        from public.callconnect_calls cc
        left join public.customers cu on cu.id=cc.matched_customer_id
        left join public.support_tickets st on st.id=cc.support_ticket_id
        where
          v_role in ('internal_admin','internal_staff')
          or v_cfg.support_company_id=v_company
          or exists(
            select 1 from public.support_assignments sa
            where sa.customer_id=cc.matched_customer_id
              and sa.support_company_id=v_company
              and sa.is_active=true
          )
        order by cc.received_at desc,cc.id desc
        limit 100
      ) x
    ),'[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;
