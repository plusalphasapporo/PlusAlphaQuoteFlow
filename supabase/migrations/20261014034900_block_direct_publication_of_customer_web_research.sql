CREATE OR REPLACE FUNCTION app_private.save_knowledge_article_impl(p_id uuid, p_title text, p_category text, p_body text, p_audience text, p_tags text[], p_is_active boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v public.knowledge_articles%rowtype; scoped boolean:=false;
begin
 if not (select app_private.is_internal()) then raise exception using errcode='42501',message='internal role required'; end if;
 if nullif(btrim(coalesce(p_title,'')),'') is null or nullif(btrim(coalesce(p_body,'')),'') is null then raise exception using errcode='22023',message='title and body are required'; end if;
 if p_audience not in ('internal','support','customer','all') then raise exception using errcode='22023',message='invalid audience'; end if;
 if p_id is not null then
   select (category='Web詳細調査' or exists(select 1 from unnest(tags) as x where x ~* '^(customer:|web-cache:)'))
   into scoped from public.knowledge_articles where id=p_id;
 end if;
 if coalesce(p_category,'')='Web詳細調査' or exists(select 1 from unnest(coalesce(p_tags,'{}'::text[])) as x where x ~* '^(customer:|web-cache:)') then scoped:=true; end if;
 if scoped and coalesce(p_is_active,true) then raise exception using errcode='42501',message='customer-scoped web research cannot be published directly; create a generalized new article'; end if;
 if p_id is null then
   insert into public.knowledge_articles(title,category,body,audience,tags,is_active,created_by,updated_by)
   values(btrim(p_title),nullif(btrim(p_category),''),btrim(p_body),p_audience,coalesce(p_tags,'{}'::text[]),coalesce(p_is_active,true),auth.uid(),auth.uid()) returning * into v;
 else
   update public.knowledge_articles set title=btrim(p_title),category=nullif(btrim(p_category),''),body=btrim(p_body),
   audience=p_audience,tags=coalesce(p_tags,'{}'::text[]),is_active=coalesce(p_is_active,true),updated_by=auth.uid(),updated_at=now()
   where id=p_id returning * into v;
   if not found then raise exception using errcode='P0002',message='knowledge article not found'; end if;
 end if;
 insert into public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 values(auth.uid(),(select app_private.current_role()),case when p_id is null then 'knowledge.created' else 'knowledge.updated' end,
 'knowledge_article',v.id::text,jsonb_build_object('title',v.title,'audience',v.audience,'is_active',v.is_active),now());
 return jsonb_build_object('id',v.id,'title',v.title);
end $function$
