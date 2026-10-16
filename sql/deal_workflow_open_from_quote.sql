-- Link a chosen existing quote to a newly created deal.
-- No automatic same-customer guessing; preserve existing order identity.
CREATE OR REPLACE FUNCTION app_private.internal_deal_open_from_quote_impl(p_quote_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_quote public.quotes%rowtype;
 v_deal_id uuid;
 v_existing_order public.orders%rowtype;
 v_sales_outcome text:='open';
 v_stage text:='quote';
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 SELECT q.* INTO v_quote FROM public.quotes q WHERE q.id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING errcode='P0002',message='quote not found';
 END IF;
 IF v_quote.deal_id IS NOT NULL THEN
  RETURN jsonb_build_object('id',v_quote.deal_id,'already_exists',true);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id=v_quote.customer_id) THEN
  RAISE EXCEPTION USING errcode='23503',message='quote customer missing';
 END IF;
 SELECT o.* INTO v_existing_order FROM public.orders o WHERE o.quote_id=p_quote_id
 ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE;
 IF FOUND THEN
  v_sales_outcome:='won';
  v_stage:='order';
 END IF;
 INSERT INTO public.deals(customer_id,title,owner_user_id,sales_outcome,current_stage,next_action)
 VALUES(v_quote.customer_id,
   coalesce(nullif(btrim(v_quote.project_name),''),coalesce(v_quote.quote_number,'新規案件')),
   auth.uid(),v_sales_outcome,v_stage,
   CASE WHEN v_sales_outcome='won' THEN '支払方法と納期を登録'
   WHEN v_quote.status='draft' THEN '見積を発行'
   ELSE '商談結果を登録' END)
 RETURNING id INTO v_deal_id;
 UPDATE public.quotes SET deal_id=v_deal_id WHERE id=p_quote_id;
 UPDATE public.orders SET deal_id=v_deal_id WHERE quote_id=p_quote_id;
 INSERT INTO public.deal_events(deal_id,event_type,message,actor_user_id)
 VALUES(v_deal_id,'quote.linked','既存見積を案件に登録',auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.created_from_quote','deal',v_deal_id::text,
  jsonb_build_object('quote_id',p_quote_id,'quote_number',v_quote.quote_number,'customer_id',v_quote.customer_id),now());
 RETURN jsonb_build_object('id',v_deal_id,'already_exists',false,'sales_outcome',v_sales_outcome);
END;$fn$;

CREATE OR REPLACE FUNCTION public.internal_deal_open_from_quote(p_quote_id uuid)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.internal_deal_open_from_quote_impl($1); $fn$;
REVOKE ALL ON FUNCTION public.internal_deal_open_from_quote(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_open_from_quote(uuid) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_open_from_quote_impl(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_open_from_quote_impl(uuid) TO authenticated;
