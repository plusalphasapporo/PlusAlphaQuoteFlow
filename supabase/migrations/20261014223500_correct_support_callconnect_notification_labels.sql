-- Correct support-facing CallConnect intake labels without widening support access.
-- Matches the internal-team suppression classification and handles internal-originated calls.
CREATE OR REPLACE FUNCTION app_private.support_unread_notifications_impl()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role text := (select app_private.current_role());
  v_company uuid := (select app_private.current_company_id());
  v_user uuid := (select auth.uid());
  result jsonb;
begin
  if v_role <> 'support_staff' then
    raise exception using errcode='42501',message='support role required';
  end if;

  select jsonb_build_object(
    'count',count(*),
    'items',coalesce(jsonb_agg(x.item order by x.activity_at desc,x.id desc),'[]'::jsonb)
  )
  into result
  from (
    select
      t.id,
      greatest(
        t.created_at,
        coalesce((
          select max(m.created_at)
          from public.support_messages m
          left join public.profiles mp on mp.user_id=m.author_user_id
          where m.ticket_id=t.id
            and coalesce(mp.role,'') <> 'support_staff'
            and m.visibility in ('customer','support')
        ),t.created_at)
      ) as activity_at,
      jsonb_build_object(
        'id',t.id,
        'ticket_number',t.ticket_number,
        'request_type',t.request_type,
        'subject',t.subject,
        'priority',t.priority,
        'support_stage',t.support_stage,
        'customer_id',c.id,
        'customer_name',c.name,
        'created_at',t.created_at,
        'source_role',creator.role,
        'source_label',case
          -- Check the persisted call record before the creator role. A
          -- CallConnect ticket can be created by an internal staff member.
          when coalesce(lower(t.request_details->>'source'),'') like '%callconnect%'
            or nullif(t.request_details->>'callconnect_call_id','') is not null
            or coalesce(t.description,'') ilike '【受付経路】CallConnect%'
            or coalesce(lower(t.legacy_source),'') like '%callconnect%'
            or exists (
              select 1 from public.callconnect_calls cc
              where cc.support_ticket_id=t.id
            )
          then 'CallConnect'
          when creator.role='customer_user' then '顧客チャット'
          when creator.role in ('internal_admin','internal_staff') then '自社チャット'
          when creator.role='support_staff' then 'サポート会社'
          else '新規問い合わせ'
        end,
        'attachment_count',(
          select count(*) from public.support_attachments a where a.ticket_id=t.id
        ),
        'latest_message_at',(
          select max(m.created_at)
          from public.support_messages m
          left join public.profiles mp on mp.user_id=m.author_user_id
          where m.ticket_id=t.id
            and coalesce(mp.role,'') <> 'support_staff'
            and m.visibility in ('customer','support')
        )
      ) as item
    from public.support_tickets t
    join public.customers c on c.id=t.customer_id
    join public.support_assignments sa
      on sa.customer_id=t.customer_id
     and sa.support_company_id=v_company
     and sa.is_active=true
    left join public.profiles creator
      on creator.user_id=t.created_by
    left join public.support_ticket_reads r
      on r.ticket_id=t.id
     and r.user_id=v_user
    where t.status<>'closed'
      and (
        r.ticket_id is null
        or t.created_at > r.read_at
        or exists(
          select 1
          from public.support_messages m
          left join public.profiles mp on mp.user_id=m.author_user_id
          where m.ticket_id=t.id
            and m.created_at > r.read_at
            and coalesce(mp.role,'') <> 'support_staff'
            and m.visibility in ('customer','support')
        )
      )
    order by activity_at desc,t.id desc
    limit 100
  ) x;

  return coalesce(result,jsonb_build_object('count',0,'items','[]'::jsonb));
end;
$function$

