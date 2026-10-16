-- Independent site visits: never rewrite delivery dates, asset records or inspection history.
CREATE TABLE IF NOT EXISTS public.deal_installation_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
 delivery_id uuid REFERENCES public.deliveries(id) ON DELETE SET NULL,
 scheduled_start_at timestamptz,scheduled_end_at timestamptz,
 site_address text,assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 state text NOT NULL DEFAULT 'tentative' CHECK (state IN ('tentative','confirmed','postponed','in_progress','completed','revisit_required','cancelled')),
 work_note text,completed_at timestamptz,
 acceptance_state text NOT NULL DEFAULT 'pending' CHECK (acceptance_state IN ('pending','accepted','rejected','not_required')),
 accepted_by text,
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT installation_time_range CHECK (scheduled_start_at IS NULL OR scheduled_end_at IS NULL OR scheduled_end_at>scheduled_start_at),
 CONSTRAINT installation_completion_time CHECK (state<>'completed' OR completed_at IS NOT NULL),
 CONSTRAINT installation_acceptance_check CHECK (acceptance_state<>'accepted' OR (state='completed' AND nullif(btrim(accepted_by),'') IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deal_installation_jobs_deal_idx ON public.deal_installation_jobs(deal_id,created_at DESC);
ALTER TABLE public.deal_installation_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deal_installation_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.deal_installation_jobs TO authenticated;
DROP POLICY IF EXISTS installation_internal_aal2 ON public.deal_installation_jobs;
CREATE POLICY installation_internal_aal2 ON public.deal_installation_jobs FOR SELECT TO authenticated
USING ((auth.jwt()->>'aal')='aal2' AND (SELECT app_private.is_internal()));

CREATE OR REPLACE FUNCTION app_private.internal_deal_save_installation_impl(p_deal_id uuid,p_job jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_deal public.deals%rowtype;v_before public.deal_installation_jobs%rowtype;v_saved public.deal_installation_jobs%rowtype;
 v_job_id uuid;v_state text;v_acceptance text;v_start timestamptz;v_end timestamptz;
 v_completed timestamptz;v_delivery uuid;v_assignee uuid;v_site text;v_note text;v_accepted_by text;
 v_existing boolean;v_changed boolean;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','')<>'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 SELECT d.* INTO v_deal FROM public.deals d WHERE d.id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='deal missing';END IF;
 IF v_deal.sales_outcome<>'won' OR NOT EXISTS(SELECT 1 FROM public.orders WHERE deal_id=p_deal_id) THEN
  RAISE EXCEPTION USING errcode='42501',message='order required for installation';
 END IF;
 v_job_id:=nullif(p_job->>'id','')::uuid;
 v_state:=coalesce(nullif(btrim(p_job->>'state'),''),'tentative');
 v_acceptance:=coalesce(nullif(btrim(p_job->>'acceptance_state'),''),'pending');
 v_start:=nullif(p_job->>'scheduled_start_at','')::timestamptz;
 v_end:=nullif(p_job->>'scheduled_end_at','')::timestamptz;
 v_completed:=nullif(p_job->>'completed_at','')::timestamptz;
 v_delivery:=nullif(p_job->>'delivery_id','')::uuid;
 v_assignee:=nullif(p_job->>'assigned_user_id','')::uuid;
 v_site:=nullif(btrim(p_job->>'site_address'),'');
 v_note:=nullif(btrim(p_job->>'work_note'),'');
 v_accepted_by:=nullif(btrim(p_job->>'accepted_by'),'');
 IF v_state NOT IN ('tentative','confirmed','postponed','in_progress','completed','revisit_required','cancelled')
   OR v_acceptance NOT IN ('pending','accepted','rejected','not_required') THEN
  RAISE EXCEPTION USING errcode='22023',message='invalid installation status';
 END IF;
 IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_end<=v_start THEN
  RAISE EXCEPTION USING errcode='22023',message='scheduled_end_at must be later than start';
 END IF;
 IF v_state='postponed' AND v_note IS NULL THEN
  RAISE EXCEPTION USING errcode='22023',message='延期理由が必要です';
 END IF;
 IF v_state='completed' AND v_completed IS NULL THEN
  RAISE EXCEPTION USING errcode='22023',message='completion time required';
 END IF;
 IF v_acceptance='accepted' AND (v_state<>'completed' OR v_accepted_by IS NULL) THEN
  RAISE EXCEPTION USING errcode='22023',message='acceptance requires completed job and signer';
 END IF;
 IF v_delivery IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.deliveries d JOIN public.orders o ON o.id=d.order_id
  WHERE d.id=v_delivery AND d.customer_id=v_deal.customer_id AND o.deal_id=p_deal_id
 ) THEN
  RAISE EXCEPTION USING errcode='42501',message='delivery is not linked to the deal';
 END IF;
 IF v_job_id IS NOT NULL THEN
  SELECT j.* INTO v_before FROM public.deal_installation_jobs j WHERE j.id=v_job_id AND j.deal_id=p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='installation visit missing';END IF;
  v_existing:=true;
 ELSE
  v_existing:=false;
 END IF;
 v_changed:=NOT v_existing OR (v_before.delivery_id,v_before.scheduled_start_at,v_before.scheduled_end_at,v_before.site_address,
   v_before.assigned_user_id,v_before.state,v_before.work_note,v_before.completed_at,v_before.acceptance_state,v_before.accepted_by)
 IS DISTINCT FROM (v_delivery,v_start,v_end,v_site,v_assignee,v_state,v_note,v_completed,v_acceptance,v_accepted_by);
 IF NOT v_changed THEN RETURN to_jsonb(v_before);END IF;
 IF v_existing THEN
  UPDATE public.deal_installation_jobs SET delivery_id=v_delivery,scheduled_start_at=v_start,scheduled_end_at=v_end,
   site_address=v_site,assigned_user_id=v_assignee,state=v_state,work_note=v_note,completed_at=v_completed,
   acceptance_state=v_acceptance,accepted_by=v_accepted_by,updated_by=auth.uid(),updated_at=now()
  WHERE id=v_job_id RETURNING * INTO v_saved;
 ELSE
  INSERT INTO public.deal_installation_jobs(deal_id,delivery_id,scheduled_start_at,scheduled_end_at,site_address,
    assigned_user_id,state,work_note,completed_at,acceptance_state,accepted_by,updated_by)
  VALUES(p_deal_id,v_delivery,v_start,v_end,v_site,v_assignee,v_state,v_note,v_completed,v_acceptance,v_accepted_by,auth.uid())
  RETURNING * INTO v_saved;
 END IF;
 INSERT INTO public.deal_events(deal_id,event_type,message,payload,actor_user_id)
 VALUES(p_deal_id,'installation.updated','工事日程・施工を更新',
  jsonb_build_object('before',to_jsonb(v_before),'after',to_jsonb(v_saved)),auth.uid());
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,before_data,after_data,created_at)
 VALUES(auth.uid(),(SELECT app_private.current_role()),'deal.installation_updated','installation',
   v_saved.id::text,to_jsonb(v_before),to_jsonb(v_saved),now());
 RETURN to_jsonb(v_saved);
END;$fn$;

CREATE OR REPLACE FUNCTION public.internal_deal_save_installation(p_deal_id uuid,p_job jsonb)
RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $fn$
 SELECT app_private.internal_deal_save_installation_impl($1,$2);$fn$;
REVOKE ALL ON FUNCTION public.internal_deal_save_installation(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_save_installation(uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_save_installation_impl(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_save_installation_impl(uuid,jsonb) TO authenticated;
