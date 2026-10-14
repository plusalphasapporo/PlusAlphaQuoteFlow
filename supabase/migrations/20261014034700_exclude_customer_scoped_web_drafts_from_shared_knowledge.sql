CREATE OR REPLACE FUNCTION app_private.role_knowledge_articles_impl()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_role text; result jsonb;
begin
  if not (select app_private.is_active_user()) then raise exception using errcode='42501',message='active user required'; end if;
  v_role := (select app_private.current_role());
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',k.id,'title',k.title,'category',k.category,'body',k.body,'audience',k.audience,
    'tags',array(select tag from unnest(k.tags) as u(tag) where tag !~* '^(customer:|web-cache:)'),
    'updated_at',k.updated_at
  ) order by k.category,k.title),'[]'::jsonb) into result
  from public.knowledge_articles k
  where k.is_active=true
    and not (k.category='Web詳細調査' or exists (
      select 1 from unnest(k.tags) as u(tag) where tag ~* '^(customer:|web-cache:)'
    ))
    and (v_role in ('internal_admin','internal_staff')
      or (v_role='support_staff' and k.audience in ('support','all'))
      or (v_role='customer_user' and k.audience in ('customer','all')));
  return result;
end $function$
