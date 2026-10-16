-- Additive, NOT applied to production automatically.
CREATE TABLE IF NOT EXISTS public.deal_financing (
 deal_id uuid PRIMARY KEY REFERENCES public.deals(id) ON DELETE RESTRICT,
 method text NOT NULL CHECK (method IN ('lease','bank_transfer','cash','installment','invoice','other')),
 lease_company text,
 credit_status text NOT NULL DEFAULT 'not_required' CHECK (credit_status IN ('not_required','pending','conditional','approved','denied')),
 lease_months integer CHECK (lease_months IS NULL OR lease_months>0),
 monthly_amount numeric CHECK (monthly_amount IS NULL OR monthly_amount>=0),
 payment_state text NOT NULL DEFAULT 'not_started' CHECK (payment_state IN ('not_started','invoiced','partially_paid','paid','overdue')),
 note text,
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT finance_nonlease_lease_fields CHECK (method='lease' OR (lease_company IS NULL AND credit_status='not_required' AND lease_months IS NULL AND monthly_amount IS NULL))
);
ALTER TABLE public.deal_financing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deal_financing FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.deal_financing TO authenticated;
DROP POLICY IF EXISTS finance_internal_aal2 ON public.deal_financing;
CREATE POLICY finance_internal_aal2 ON public.deal_financing FOR SELECT TO authenticated
USING ((auth.jwt()->>'aal')='aal2' AND (SELECT app_private.is_internal()));

CREATE OR REPLACE FUNCTION app_private.internal_deal_set_financing_impl(p_deal_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_deal public.deals%rowtype;v_before public.deal_financing%rowtype;
 v_saved public.deal_financing%rowtype;v_method text;v_credit_status text;
 v_payment_state text;v_company text;v_months integer;v_amount numeric;v_note text;
 v_changed boolean;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 SELECT d.* INTO v_deal FROM public.deals d WHERE d.id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal missing';END IF;
 IF v_deal.sales_outcome<>'won' OR NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.deal_id=p_deal_id) THEN
  RAISE EXCEPTION USING errcode='42501',message='order required before financing';
 END IF;
 IF NOT (SELECT app_private.customer_allows_new_transaction(v_deal.customer_id)) THEN
  RAISE EXCEPTION USING errcode='42501',message='customer on hold';
 END IF;
 v_method:=nullif(btrim(p_payload->>'method'),'');
 v_payment_state:=coalesce(nullif(btrim(p_payload->>'payment_state'),''),'not_started');
 IF v_method NOT IN ('lease','bank_transfer','cash','installment','invoice','other') OR v_method IS NULL THEN
  RAISE EXCEPTION USING errcode='22023',message='invalid payment method';
 END IF;
 IF v_payment_state NOT IN ('not_started','invoiced','partially_paid','paid','overdue') THEN
  RAISE EXCEPTION USING errcode='22023',message='invalid payment state';
 END IF;
 v_credit_status:=coalesce(nullif(btrim(p_payload->>'credit_status'),''),'pending');
 v_company:=nullif(btrim(p_payload->>'lease_company'),'');
 v_months:=nullif(p_payload->>'lease_months','')::integer;
 v_amount:=nullif(p_payload->>'monthly_amount','')::numeric;
 v_note:=nullif(btrim(p_payload->>'note'),'');
 IF v_method<>'lease' THEN
   v_credit_status:='not_required';v_company:=NULL;v_months:=NULL;v_amount:=NULL;
 ELSIF v_credit_status NOT IN ('pending','conditional','approved','denied') THEN
   RAISE EXCEPTION USING errcode='22023',message='invalid lease credit status';
 END IF;
 IF v_method='lease' AND (v_months IS NOT NULL AND v_months<=0 OR v_amount IS NOT NULL AND v_amount<0) THEN
  RAISE EXCEPTION USING errcode='22023',message='invalid lease terms';
 END IF;
 SELECT * INTO v_before FROM public.deal_financing WHERE deal_id=p_deal_id FOR UPDATE;
 v_changed:=NOT FOUND OR (v_before.method,v_before.lease_company,v_before.credit_status,v_before.lease_months,v_before.monthly_amount,v_before.payment_state,v_before.note)
   IS DISTINCT FROM (v_method,v_company,v_credit_status,v_months,v_amount,v_payment_state,v_note);
 IF NOT v_changed THEN RETURN to_jsonb(v_before);END IF;
 INSERT INTO public.deal_financing(deal_id,method,lease_company,credit_status,lease_months,monthly_amount,payment_state,note,updated_by)
 VALUES(p_deal_id,v_method,v_company,v_credit_status,v_months,v_amount,v_payment_state,v_note,auth.uid())
 ON CONFLICT (deal_id) DO UPDATE SET method=EXCLUDED.method,lease_company=EXCLUDED.lease_company,
 credit_status=EXCLUDED.credit_status,lease_months=EXCLUDED.lease_months,monthly_amount=EXCLUDED.monthly_amount,
 payment_state=EXCLUDED.payment_state,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now()
 RETURNING * INTO v_saved;
 INSERT INTO public.deal_events(deal_id,event_type,message,payload,actor_user_id)
 VALUES(p_deal_id,'financing.updated','支払条件を変更',jsonb_build_object('before',to_jsonb(v_before),'after',to_jsonb(v_saved)),auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,before_data,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.financing_updated','deal',p_deal_id::text,to_jsonb(v_before),to_jsonb(v_saved),now());
 RETURN to_jsonb(v_saved);
END;$fn$;
CREATE OR REPLACE FUNCTION public.internal_deal_set_financing(p_deal_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.internal_deal_set_financing_impl($1,$2);$fn$;
REVOKE ALL ON FUNCTION public.internal_deal_set_financing(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_set_financing(uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_set_financing_impl(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_set_financing_impl(uuid,jsonb) TO authenticated;
