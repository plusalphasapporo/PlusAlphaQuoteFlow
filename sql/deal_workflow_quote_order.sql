-- Quote issuance and direct order registration without manager approval.
-- Staging-only migration until full workflow tests have passed.
CREATE OR REPLACE FUNCTION app_private.deal_issue_quote_impl(p_deal_id uuid,p_quote_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_deal public.deals%rowtype; v_quote public.quotes%rowtype;
 v_number text; v_count integer; v_today date:=timezone('Asia/Tokyo',now())::date;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 SELECT d.* INTO v_deal FROM public.deals d WHERE d.id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal not found'; END IF;
 IF v_deal.sales_outcome<>'open' THEN RAISE EXCEPTION USING errcode='42501',message='deal is closed'; END IF;
 SELECT q.* INTO v_quote FROM public.quotes q WHERE q.id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='quote not found'; END IF;
 IF v_quote.customer_id<>v_deal.customer_id OR v_quote.deal_id IS DISTINCT FROM p_deal_id THEN
  RAISE EXCEPTION USING errcode='42501',message='quote and deal customer mismatch';
 END IF;
 IF v_quote.status='finalized' THEN
  RETURN jsonb_build_object('id',p_quote_id,'status','finalized','already_issued',true);
 END IF;
 IF v_quote.status<>'draft' THEN RAISE EXCEPTION USING errcode='42501',message='only draft quote can be issued'; END IF;
 IF NOT (SELECT app_private.customer_allows_new_transaction(v_deal.customer_id)) THEN
  RAISE EXCEPTION USING errcode='42501',message='customer on hold';
 END IF;
 IF v_quote.valid_until IS NOT NULL AND v_quote.valid_until<v_today THEN
  RAISE EXCEPTION USING errcode='22023',message='quote expired';
 END IF;
 SELECT count(*)::integer INTO v_count FROM public.quote_items WHERE quote_id=p_quote_id;
 IF v_count<1 THEN RAISE EXCEPTION USING errcode='22023',message='at least one quote item required'; END IF;
 v_number:=coalesce(nullif(v_quote.quote_number,''),
  app_private.next_legacy_customer_quote_number(v_deal.customer_id,coalesce(v_quote.quote_date,v_today)));
 UPDATE public.quotes SET quote_number=v_number,status='finalized',finalized_at=now(),
  finalized_by=auth.uid(),updated_at=now() WHERE id=p_quote_id;
 UPDATE public.deals SET current_stage='quote',next_action='受注または失注を登録',updated_at=now() WHERE id=p_deal_id;
 INSERT INTO public.deal_events(deal_id,event_type,message,actor_user_id)
 VALUES(p_deal_id,'quote.issued','見積発行',auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'quote.issued','quote',p_quote_id::text,
 jsonb_build_object('deal_id',p_deal_id,'quote_number',v_number),now());
 RETURN jsonb_build_object('id',p_quote_id,'status','finalized','quote_number',v_number,'already_issued',false);
END;$fn$;

-- Existing convert_quote_to_order() must not bypass lost outcome through its old RPC.
CREATE OR REPLACE FUNCTION app_private.guard_deal_order_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_deal public.deals%rowtype;v_deal_id uuid;v_quote_customer_id uuid;v_quote_deal_id uuid;
BEGIN
 IF NEW.quote_id IS NOT NULL THEN
  SELECT q.customer_id,q.deal_id INTO v_quote_customer_id,v_quote_deal_id
  FROM public.quotes q WHERE q.id=NEW.quote_id;
  IF v_quote_customer_id IS NULL OR NEW.customer_id<>v_quote_customer_id THEN
   RAISE EXCEPTION USING errcode='23514',message='order quote customer mismatch';
  END IF;
  IF NEW.deal_id IS NOT NULL AND v_quote_deal_id IS DISTINCT FROM NEW.deal_id THEN
   RAISE EXCEPTION USING errcode='23514',message='order quote deal mismatch';
  END IF;
 END IF;
 v_deal_id:=coalesce(NEW.deal_id,v_quote_deal_id);
 IF v_deal_id IS NULL THEN RETURN NEW; END IF;
 SELECT d.* INTO v_deal FROM public.deals d WHERE d.id=v_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='23503',message='deal missing'; END IF;
 IF v_deal.sales_outcome<>'open' THEN
  RAISE EXCEPTION USING errcode='42501',message='order not allowed for closed or lost deal';
 END IF;
 IF NEW.customer_id<>v_deal.customer_id THEN
  RAISE EXCEPTION USING errcode='23514',message='order customer and deal mismatch';
 END IF;
 NEW.deal_id:=v_deal_id;
 RETURN NEW;
END;$fn$;
DROP TRIGGER IF EXISTS orders_deal_outcome_guard ON public.orders;
CREATE TRIGGER orders_deal_outcome_guard BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION app_private.guard_deal_order_insert();

CREATE OR REPLACE FUNCTION app_private.deal_create_order_from_quote_impl(p_deal_id uuid,p_quote_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_deal public.deals%rowtype;v_quote public.quotes%rowtype;
 v_existing public.orders%rowtype;v_order public.orders%rowtype;
 v_number text;v_today date:=timezone('Asia/Tokyo',now())::date;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 SELECT d.* INTO v_deal FROM public.deals d WHERE d.id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal not found'; END IF;
 SELECT q.* INTO v_quote FROM public.quotes q WHERE q.id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='quote not found'; END IF;
 IF v_quote.customer_id<>v_deal.customer_id OR v_quote.deal_id IS DISTINCT FROM p_deal_id THEN
  RAISE EXCEPTION USING errcode='42501',message='quote and deal customer mismatch';
 END IF;
 SELECT o.* INTO v_existing FROM public.orders o
 WHERE o.deal_id=p_deal_id
 OR o.quote_id IN (SELECT q2.id FROM public.quotes q2 WHERE q2.deal_id=p_deal_id)
 ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE;
 IF FOUND THEN
  IF v_existing.quote_id IS DISTINCT FROM p_quote_id THEN
   RAISE EXCEPTION USING errcode='23505',message='another quote in deal already ordered';
  END IF;
  RETURN jsonb_build_object('id',v_existing.id,'status',v_existing.status,'already_exists',true);
 END IF;
 IF v_deal.sales_outcome<>'open' THEN RAISE EXCEPTION USING errcode='42501',message='deal is not open'; END IF;
 IF v_quote.status NOT IN ('finalized','accepted') OR v_quote.quote_number IS NULL THEN
  RAISE EXCEPTION USING errcode='42501',message='only issued quotes can be ordered';
 END IF;
 IF NOT (SELECT app_private.customer_allows_new_transaction(v_deal.customer_id)) THEN
  RAISE EXCEPTION USING errcode='42501',message='customer on hold';
 END IF;
 IF v_quote.valid_until IS NOT NULL AND v_quote.valid_until<v_today THEN
  RAISE EXCEPTION USING errcode='22023',message='quote expired';
 END IF;
 v_number:=app_private.next_document_number('order');
 INSERT INTO public.orders(deal_id,customer_id,quote_id,order_number,status,total_amount,ordered_at,created_by)
 VALUES(p_deal_id,v_deal.customer_id,p_quote_id,v_number,'draft',v_quote.total_amount,now(),auth.uid())
 RETURNING * INTO v_order;
 UPDATE public.deals SET sales_outcome='won',current_stage='order',
 next_action='支払方法と納期を登録',updated_at=now() WHERE id=p_deal_id;
 INSERT INTO public.deal_events(deal_id,event_type,message,actor_user_id)
 VALUES(p_deal_id,'order.created','受注登録',auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.order_created','order',v_order.id::text,
 jsonb_build_object('deal_id',p_deal_id,'quote_id',p_quote_id,'order_number',v_number),now());
 RETURN jsonb_build_object('id',v_order.id,'status',v_order.status,'order_number',v_number,'already_exists',false);
END;$fn$;

CREATE OR REPLACE FUNCTION public.deal_issue_quote(p_deal_id uuid,p_quote_id uuid)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.deal_issue_quote_impl($1,$2); $fn$;
CREATE OR REPLACE FUNCTION public.deal_create_order_from_quote(p_deal_id uuid,p_quote_id uuid)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.deal_create_order_from_quote_impl($1,$2); $fn$;
REVOKE ALL ON FUNCTION public.deal_issue_quote(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.deal_issue_quote(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.deal_create_order_from_quote(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.deal_create_order_from_quote(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION app_private.deal_issue_quote_impl(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.deal_issue_quote_impl(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION app_private.deal_create_order_from_quote_impl(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.deal_create_order_from_quote_impl(uuid,uuid) TO authenticated;
