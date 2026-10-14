-- Guard shared knowledge-feed projection against leaking internal customer and cache tags.
-- The original tags remain stored for administrator audit and ticket-scoped caches.
create or replace function app_private.role_knowledge_articles_impl()
returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare v_role text; result jsonb;
begin
  if not (select app_private.is_active_user()) then
    raise exception using errcode='42501',message='active user required';
  end if;
  v_role := (select app_private.current_role());
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',k.id,'title',k.title,'category',k.category,'body',k.body,
    'audience',k.audience,
    'tags',array(
      select tag from unnest(k.tags) as u(tag)
      where tag !~* '^(customer:|web-cache:)'
    ),
    'updated_at',k.updated_at
  ) order by k.category,k.title),'[]'::jsonb)
  into result from public.knowledge_articles k
  where k.is_active=true
    and (v_role in ('internal_admin','internal_staff')
      or (v_role='support_staff' and k.audience in ('support','all'))
      or (v_role='customer_user' and k.audience in ('customer','all')));
  return result;
end $function$;