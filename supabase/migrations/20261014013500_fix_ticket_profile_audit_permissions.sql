-- Reconcile staging-applied audit-privilege fix for ticket profile updates.
-- Staging migration versions: 20261014014048, 20261014014122.
-- Audit logs retain restricted INSERT; no broad table grants.

CREATE OR REPLACE FUNCTION app_private.update_support_ticket_profile_impl(p_ticket_id uuid, p_priority text, p_assigned_internal_user_id uuid, p_asset_id uuid, p_contract_id uuid, p_internal_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
 v_role text := (select app_private.current_role());
 v_company uuid := (select app_private.current_company_id());
 v public.support_tickets%rowtype;
 v_priority text := coalesce(nullif(btrim(p_priority),''),'normal');
BEGIN
 IF coalesce(v_role,'') NOT IN ('internal_admin','internal_staff') OR v_company IS NULL THEN
   RAISE EXCEPTION USING errcode='42501',message='internal role required';
 END IF;
 SELECT st.* INTO v FROM public.support_tickets st
 WHERE st.id=p_ticket_id AND (select app_private.can_access_customer(st.customer_id)) FOR UPDATE OF st;
 IF NOT FOUND THEN RAISE EXCEPTION USING errcode='P0002',message='ticket not found'; END IF;
 IF v_priority NOT IN ('low','normal','high','urgent') THEN
   RAISE EXCEPTION USING errcode='22023',message='invalid priority';
 END IF;
 IF p_assigned_internal_user_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.profiles p WHERE p.user_id=p_assigned_internal_user_id
   AND p.company_id=v_company AND p.is_active=true AND p.role IN ('internal_admin','internal_staff')
 ) THEN RAISE EXCEPTION USING errcode='22023',message='invalid assigned internal user'; END IF;
 IF p_asset_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.assets a WHERE a.id=p_asset_id AND a.customer_id=v.customer_id
 ) THEN RAISE EXCEPTION USING errcode='22023',message='asset must belong to ticket customer'; END IF;
 IF p_contract_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.contracts ct WHERE ct.id=p_contract_id AND ct.customer_id=v.customer_id
 ) THEN RAISE EXCEPTION USING errcode='22023',message='contract must belong to ticket customer'; END IF;

 UPDATE public.support_tickets
 SET priority=v_priority, assigned_internal_user_id=p_assigned_internal_user_id,
     asset_id=p_asset_id, contract_id=p_contract_id,
     internal_note=nullif(btrim(p_internal_note),''),
     status=case when status='open' AND p_assigned_internal_user_id IS NOT NULL THEN 'in_progress' ELSE status END,
     updated_at=now()
 WHERE id=p_ticket_id RETURNING * INTO v;
 INSERT INTO public.audit_logs(actor_user_id,actor_role,action,target_type,target_id,after_data,created_at)
 VALUES(auth.uid(),v_role,'ticket.profile_updated','support_ticket',v.id::text,
   jsonb_build_object('priority',v.priority,'assigned_internal_user_id',v.assigned_internal_user_id,
                      'asset_id',v.asset_id,'contract_id',v.contract_id,'status',v.status),now());
 RETURN jsonb_build_object('id',v.id,'status',v.status,'priority',v.priority,
   'assigned_internal_user_id',v.assigned_internal_user_id,'asset_id',v.asset_id,'contract_id',v.contract_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_support_ticket_profile(p_ticket_id uuid, p_priority text, p_assigned_internal_user_id uuid, p_asset_id uuid, p_contract_id uuid, p_internal_note text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
 SELECT app_private.update_support_ticket_profile_impl($1,$2,$3,$4,$5,$6)
$function$;

REVOKE ALL ON FUNCTION app_private.update_support_ticket_profile_impl(uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION app_private.update_support_ticket_profile_impl(uuid,text,uuid,uuid,uuid,text) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.update_support_ticket_profile(uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_support_ticket_profile(uuid,text,uuid,uuid,uuid,text) TO authenticated,service_role;
