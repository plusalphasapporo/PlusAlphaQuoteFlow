-- Loss and reopen preserve original quote; serialize against direct order conversion.
CREATE OR REPLACE FUNCTION app_private.internal_deal_mark_lost_impl(
 p_deal_id uuid,p_quote_id uuid,p_lost_date date,p_reason_category text,
 p_detail text,p_competitor text,p_reproposal_on date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE d public.deals%rowtype;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 IF p_lost_date IS NULL OR coalesce(btrim(p_reason_category),'') NOT IN
  ('price','competitor','budget','postponed','customer','specification','unreachable','other') THEN
  RAISE EXCEPTION USING errcode='22023',message='lost date and valid reason required';
 END IF;
 IF p_reason_category='other' AND nullif(btrim(coalesce(p_detail,'')),'') IS NULL THEN
  RAISE EXCEPTION USING errcode='22023',message='details required for other';
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal not found'; END IF;
 IF d.sales_outcome IN ('won','cancelled_after_order') THEN
  RAISE EXCEPTION USING errcode='42501',message='ordered deal cannot be lost';
 END IF;
 IF d.sales_outcome='lost' THEN
  RAISE EXCEPTION USING errcode='23505',message='deal already lost';
 END IF;
 IF p_quote_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.quotes q WHERE q.id=p_quote_id AND q.deal_id=p_deal_id AND q.customer_id=d.customer_id
 ) THEN
  RAISE EXCEPTION USING errcode='42501',message='quote is not linked to deal';
 END IF;
 IF EXISTS(SELECT 1 FROM public.orders o WHERE o.deal_id=p_deal_id OR o.quote_id=p_quote_id
   OR o.quote_id IN (SELECT q.id FROM public.quotes q WHERE q.deal_id=p_deal_id)) THEN
  RAISE EXCEPTION USING errcode='42501',message='order already exists';
 END IF;
 UPDATE public.deals SET sales_outcome='lost',current_stage='lost',next_action=NULL,updated_at=now()
 WHERE id=p_deal_id;
 INSERT INTO public.deal_loss_events(deal_id,quote_id,event_type,reason_category,detail,lost_date,competitor,reproposal_on,actor_user_id)
 VALUES(p_deal_id,p_quote_id,'lost',p_reason_category,nullif(btrim(p_detail),''),p_lost_date,
 nullif(btrim(p_competitor),''),p_reproposal_on,auth.uid());
 INSERT INTO public.deal_events(deal_id,event_type,message,actor_user_id)
 VALUES(p_deal_id,'lost',p_reason_category,auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.lost','deal',p_deal_id::text,
 jsonb_build_object('quote_id',p_quote_id,'lost_date',p_lost_date,'reason',p_reason_category),now());
 RETURN jsonb_build_object('id',p_deal_id,'sales_outcome','lost');
END;$fn$;

CREATE OR REPLACE FUNCTION app_private.internal_deal_reopen_impl(p_deal_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE d public.deals%rowtype;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 IF nullif(btrim(coalesce(p_reason,'')),'') IS NULL THEN
  RAISE EXCEPTION USING errcode='22023',message='reopen reason required';
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal not found'; END IF;
 IF d.sales_outcome<>'lost' THEN
  RAISE EXCEPTION USING errcode='42501',message='only lost deal can reopen';
 END IF;
 IF EXISTS(SELECT 1 FROM public.orders o WHERE o.deal_id=p_deal_id
   OR o.quote_id IN (SELECT q.id FROM public.quotes q WHERE q.deal_id=p_deal_id)) THEN
  RAISE EXCEPTION USING errcode='42501',message='ordered deal cannot reopen as quote';
 END IF;
 UPDATE public.deals SET sales_outcome='open',current_stage='quote',next_action='再提案の見積を作成',updated_at=now() WHERE id=p_deal_id;
 INSERT INTO public.deal_loss_events(deal_id,event_type,detail,actor_user_id)
 VALUES(p_deal_id,'reopened',btrim(p_reason),auth.uid());
 INSERT INTO public.deal_events(deal_id,event_type,message,actor_user_id)
 VALUES(p_deal_id,'reopened',btrim(p_reason),auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.reopened','deal',p_deal_id::text,
 jsonb_build_object('reason',p_reason),now());
 RETURN jsonb_build_object('id',p_deal_id,'sales_outcome','open');
END;$fn$;

CREATE OR REPLACE FUNCTION public.internal_deal_mark_lost(
 p_deal_id uuid,p_quote_id uuid,p_lost_date date,p_reason_category text,
 p_detail text,p_competitor text,p_reproposal_on date)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.internal_deal_mark_lost_impl($1,$2,$3,$4,$5,$6,$7);
$fn$;
CREATE OR REPLACE FUNCTION public.internal_deal_reopen(p_deal_id uuid,p_reason text)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.internal_deal_reopen_impl($1,$2);
$fn$;
REVOKE ALL ON FUNCTION public.internal_deal_mark_lost(uuid,uuid,date,text,text,text,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_mark_lost(uuid,uuid,date,text,text,text,date) TO authenticated;
REVOKE ALL ON FUNCTION public.internal_deal_reopen(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_reopen(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_mark_lost_impl(uuid,uuid,date,text,text,text,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_mark_lost_impl(uuid,uuid,date,text,text,text,date) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_reopen_impl(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_reopen_impl(uuid,text) TO authenticated;
