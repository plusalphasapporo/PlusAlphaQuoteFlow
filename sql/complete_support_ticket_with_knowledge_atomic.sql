-- QuoteFlow Cloud
-- The work report and optional knowledge article/suggestion are committed together.
-- Repeated calls after completion do not add duplicate messages or knowledge.
create or replace function public.complete_support_ticket_with_knowledge(
  p_ticket_id uuid,
  p_report_body text,
  p_create_knowledge boolean,
  p_knowledge_title text,
  p_knowledge_category text,
  p_knowledge_body text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_role text := (select app_private.current_role());
  v_completion jsonb;
  v_knowledge jsonb := null;
  v_make_knowledge boolean := coalesce(p_create_knowledge, false);
begin
  if (select auth.uid()) is null
     or not (select app_private.is_active_user())
     or coalesce(v_role, '') not in ('internal_admin','internal_staff','support_staff') then
    raise exception using errcode='42501',
      message='active support or internal MFA session required';
  end if;

  if p_ticket_id is null or nullif(btrim(coalesce(p_report_body,'')),'') is null then
    raise exception using errcode='22023',
      message='ticket and work report are required';
  end if;

  if v_make_knowledge and (
    nullif(btrim(coalesce(p_knowledge_title,'')),'') is null
    or nullif(btrim(coalesce(p_knowledge_body,'')),'') is null
    or length(p_knowledge_title)>500
    or length(p_knowledge_body)>20000
  ) then
    raise exception using errcode='22023',
      message='knowledge title and content are required';
  end if;

  -- Every call below runs within this same PostgREST RPC transaction.
  -- An error while creating knowledge rolls back the report and ticket closure.
  v_completion := public.complete_support_ticket_with_report(
    p_ticket_id, p_report_body
  );

  if coalesce((v_completion->>'already_closed')::boolean, false) then
    return jsonb_build_object(
      'already_closed',true,
      'ticket',v_completion->'ticket',
      'message_id',null,
      'knowledge_status','not_created',
      'knowledge',null
    );
  end if;

  if v_make_knowledge then
    if v_role in ('internal_admin','internal_staff') then
      v_knowledge := public.save_knowledge_article(
        null,
        p_knowledge_title,
        p_knowledge_category,
        p_knowledge_body,
        'support',
        array['作業報告']::text[],
        true
      );
    else
      -- Support staff cannot post an internal-visibility message.
      -- Use the existing audited suggestion workflow for internal review.
      v_knowledge := public.submit_knowledge_suggestion(
        p_ticket_id, p_knowledge_title, p_knowledge_category, p_knowledge_body
      );
    end if;
  end if;

  return jsonb_build_object(
    'already_closed',false,
    'ticket',v_completion->'ticket',
    'message_id',v_completion->'message_id',
    'knowledge_status',
      case when not v_make_knowledge then 'not_requested'
           when v_role='support_staff' then 'suggestion_submitted'
           else 'article_saved' end,
    'knowledge',v_knowledge
  );
end;
$function$;

revoke all on function public.complete_support_ticket_with_knowledge(uuid,text,boolean,text,text,text) from public, anon;
grant execute on function public.complete_support_ticket_with_knowledge(uuid,text,boolean,text,text,text) to authenticated;
