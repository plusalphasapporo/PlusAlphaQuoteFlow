-- Extend existing internal unread handoff RPC with cross-device unread
-- ticket notifications, preserving existing access control and payload keys.
-- Run only after reviewing source and permission assumptions.
CREATE OR REPLACE FUNCTION app_private.internal_unread_handoff_notifications_impl()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := (select auth.uid());
  result jsonb;
  v_ticket_count bigint := 0;
  v_ticket_items jsonb := '[]'::jsonb;
begin
  if not (select app_private.is_internal()) then
    raise exception using errcode='42501',message='internal role required';
  end if;

  select jsonb_build_object(
    'count',count(*),
    'items',coalesce(jsonb_agg(x.item order by
      case x.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 when 'low' then 4 else 5 end,
      x.created_at asc,x.id asc
    ),'[]'::jsonb)
  )
  into result
  from (
    select
      h.id,
      h.created_at,
      t.priority,
      jsonb_build_object(
        'id',h.id,
        'handoff_id',h.id,
        'ticket_id',h.ticket_id,
        'ticket_number',t.ticket_number,
        'request_type',t.request_type,
        'subject',t.subject,
        'priority',t.priority,
        'support_stage',t.support_stage,
        'customer_id',c.id,
        'customer_name',c.name,
        'reason',h.reason,
        'next_action',h.next_action,
        'requested_by',h.requested_by,
        'requested_by_role',h.requested_by_role,
        'created_at',h.created_at
      ) as item
    from public.support_handoffs h
    join public.support_tickets t on t.id=h.ticket_id
    join public.customers c on c.id=t.customer_id
    left join public.internal_handoff_reads r
      on r.handoff_id=h.id
     and r.user_id=v_user
    where h.state='pending'
      and h.requested_by_role='support_staff'
      and r.handoff_id is null
  ) x;


  -- Add unread customer/internal/support-originated tickets to the existing
  -- internal notification RPC without changing its handoff count semantics.
  -- A CallConnect-originated case remains visible in case management but must
  -- NOT produce any notification to internal admins/staff.
  with unread_tickets as (
    select
      t.id,t.ticket_number,t.request_type,t.subject,t.priority,t.created_at,
      t.customer_id,c.name as customer_name,t.status,
      case
        when origin.role='customer_user' then '顧客'
        when origin.role='support_staff' then 'サポート会社'
        else '新規案件'
      end as source_label,
      greatest(
        t.created_at,
        coalesce((
          select max(m.created_at)
          from public.support_messages m
          join public.profiles actor on actor.user_id=m.author_user_id
          where m.ticket_id=t.id
            and actor.role in ('customer_user','support_staff')
            and m.visibility in ('customer','support')
        ),t.created_at)
      ) as activity_at
    from public.support_tickets t
    join public.customers c on c.id=t.customer_id
    left join public.profiles origin on origin.user_id=t.created_by
    left join public.support_ticket_reads r
      on r.ticket_id=t.id and r.user_id=v_user
    where t.status <> 'closed'
      and not (
        coalesce(lower(t.request_details->>'source'),'') like '%callconnect%'
        or nullif(t.request_details->>'callconnect_call_id','') is not null
        or coalesce(t.description,'') ilike '【受付経路】CallConnect%'
        or coalesce(lower(t.legacy_source),'') like '%callconnect%'
        or exists(
          select 1 from public.callconnect_calls cc
          where cc.support_ticket_id=t.id
        )
      )
      and (
        (t.created_by is distinct from v_user
          and (r.ticket_id is null or t.created_at>r.read_at))
        or exists (
          select 1
          from public.support_messages m
          join public.profiles actor on actor.user_id=m.author_user_id
          where m.ticket_id=t.id
            and actor.role in ('customer_user','support_staff')
            and m.visibility in ('customer','support')
            and m.created_at>coalesce(r.read_at,t.created_at)
        )
      )
  )
  select
    (select count(*) from unread_tickets),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',q.id,
          'ticket_id',q.id,
          'ticket_number',q.ticket_number,
          'request_type',q.request_type,
          'subject',q.subject,
          'priority',q.priority,
          'customer_id',q.customer_id,
          'customer_name',q.customer_name,
          'status',q.status,
          'source_label',q.source_label,
          'created_at',q.created_at,
          'activity_at',q.activity_at
        ) order by q.activity_at desc,q.id desc
      )
      from (
        select * from unread_tickets
        order by activity_at desc,id desc
        limit 50
      ) q
    ),'[]'::jsonb)
  into v_ticket_count,v_ticket_items;

  result := coalesce(result,jsonb_build_object('count',0,'items','[]'::jsonb))
    || jsonb_build_object(
      'ticket_count',coalesce(v_ticket_count,0),
      'ticket_items',coalesce(v_ticket_items,'[]'::jsonb)
    );

  return result;
end;
$function$

