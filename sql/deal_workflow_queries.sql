-- Release 1: read-only deal screens and safe legacy relationship PREVIEW.
-- No existing record is assigned a deal_id by this script.

CREATE OR REPLACE FUNCTION app_private.internal_deals_list_impl()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.updated_at DESC),'[]'::jsonb)
    FROM (
      SELECT d.id,d.customer_id,d.title,d.owner_user_id,d.sales_outcome,d.current_stage,
        d.next_action,d.due_at,d.created_at,d.updated_at,
        c.name AS customer_name,c.customer_code,c.branch_type,c.parent_customer_id,
        pc.name AS parent_customer_name,pc.customer_code AS parent_customer_code,
        q.id AS quote_id,q.quote_number,q.status AS quote_status,q.total_amount,
        o.id AS order_id,o.order_number,o.status AS order_status,
        (o.id IS NOT NULL) AS is_ordered
      FROM public.deals d
      JOIN public.customers c ON c.id=d.customer_id
      LEFT JOIN public.customers pc ON pc.id=c.parent_customer_id
      LEFT JOIN LATERAL (
        SELECT q.id,q.quote_number,q.status,q.total_amount
        FROM public.quotes q WHERE q.deal_id=d.id
        ORDER BY q.updated_at DESC,q.id LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT o.id,o.order_number,o.status
        FROM public.orders o WHERE o.deal_id=d.id
        ORDER BY o.created_at DESC,o.id LIMIT 1
      ) o ON true
    ) row_data
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.internal_deals_list()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $wrapper$ SELECT app_private.internal_deals_list_impl() $wrapper$;

CREATE OR REPLACE FUNCTION app_private.internal_deal_detail_impl(p_deal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE result jsonb;
BEGIN
  IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
  END IF;
  SELECT jsonb_build_object(
    'deal',to_jsonb(d),
    'customer',jsonb_build_object('id',c.id,'customer_code',c.customer_code,'name',c.name,
      'branch_type',c.branch_type,'parent_customer_id',c.parent_customer_id,
      'parent_customer_name',pc.name,'parent_customer_code',pc.customer_code,
      'phone',c.phone,'email',c.email),
    'quotes',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at),'[]'::jsonb)
      FROM public.quotes q WHERE q.deal_id=p_deal_id),
    'financing',(SELECT to_jsonb(f) FROM public.deal_financing f WHERE f.deal_id=p_deal_id),
    'installation_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.scheduled_start_at,j.created_at),'[]'::jsonb)
      FROM public.deal_installation_jobs j WHERE j.deal_id=p_deal_id),
    'orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.created_at),'[]'::jsonb)
      FROM public.orders o WHERE o.deal_id=p_deal_id),
    'purchase_orders',(SELECT coalesce(jsonb_agg(to_jsonb(po) ORDER BY po.created_at),'[]'::jsonb)
      FROM public.purchase_orders po WHERE po.deal_id=p_deal_id),
    'deliveries',(SELECT coalesce(jsonb_agg(to_jsonb(dv) ORDER BY dv.created_at),'[]'::jsonb)
      FROM public.deliveries dv WHERE dv.deal_id=p_deal_id),
    'assets',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at),'[]'::jsonb)
      FROM public.assets a WHERE a.deal_id=p_deal_id),
    'contracts',(SELECT coalesce(jsonb_agg(to_jsonb(ct) ORDER BY ct.created_at),'[]'::jsonb)
      FROM public.contracts ct WHERE ct.deal_id=p_deal_id),
    'support_tickets',(SELECT coalesce(jsonb_agg(to_jsonb(st) ORDER BY st.created_at),'[]'::jsonb)
      FROM public.support_tickets st WHERE st.deal_id=p_deal_id),
    'loss_events',(SELECT coalesce(jsonb_agg(to_jsonb(le) ORDER BY le.created_at),'[]'::jsonb)
      FROM public.deal_loss_events le WHERE le.deal_id=p_deal_id),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(ev) ORDER BY ev.created_at),'[]'::jsonb)
      FROM public.deal_events ev WHERE ev.deal_id=p_deal_id)
  ) INTO result
  FROM public.deals d
  JOIN public.customers c ON c.id=d.customer_id
  LEFT JOIN public.customers pc ON pc.id=c.parent_customer_id
  WHERE d.id=p_deal_id;
  IF result IS NULL THEN
    RAISE EXCEPTION USING errcode='P0002',message='deal not found';
  END IF;
  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.internal_deal_detail(p_deal_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $wrapper$ SELECT app_private.internal_deal_detail_impl(p_deal_id) $wrapper$;

-- A report only: relationship evidence is FK-backed. No customer-only guessing.
CREATE OR REPLACE FUNCTION app_private.internal_deal_link_preview_impl()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
  END IF;
  RETURN (
    WITH orphan_quotes AS (
      SELECT q.id,q.customer_id,q.quote_number
      FROM public.quotes q WHERE q.deal_id IS NULL
    ), linked_orders AS (
      SELECT o.id,o.quote_id,o.customer_id
      FROM public.orders o JOIN orphan_quotes q ON o.quote_id=q.id
      WHERE o.deal_id IS NULL AND o.customer_id=q.customer_id
    ), linked_pos AS (
      SELECT po.id,po.order_id FROM public.purchase_orders po
      JOIN linked_orders o ON po.order_id=o.id
      WHERE po.deal_id IS NULL AND po.customer_id=o.customer_id
    ), linked_deliveries AS (
      SELECT dv.id,dv.order_id,dv.customer_id FROM public.deliveries dv
      JOIN linked_orders o ON dv.order_id=o.id
      WHERE dv.deal_id IS NULL AND dv.customer_id=o.customer_id
    ), linked_assets AS (
      SELECT a.id,a.source_delivery_id FROM public.assets a
      JOIN linked_deliveries dv ON a.source_delivery_id=dv.id
      WHERE a.deal_id IS NULL AND a.customer_id=dv.customer_id
    )
    SELECT jsonb_build_object(
      'unlinked_quotes',(SELECT count(*) FROM orphan_quotes),
      'linked_order_candidates',(SELECT count(*) FROM linked_orders),
      'linked_purchase_order_candidates',(SELECT count(*) FROM linked_pos),
      'linked_delivery_candidates',(SELECT count(*) FROM linked_deliveries),
      'linked_asset_candidates',(SELECT count(*) FROM linked_assets),
      'orders_without_quote_link',(SELECT count(*) FROM public.orders WHERE deal_id IS NULL AND quote_id IS NULL),
      'sample_quote_candidates',(SELECT coalesce(jsonb_agg(to_jsonb(z)),'[]'::jsonb) FROM (
         SELECT q.id,q.customer_id,q.quote_number FROM orphan_quotes q ORDER BY q.id LIMIT 40
       ) z),
      'preview_only',true
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.internal_deal_link_preview()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $wrapper$ SELECT app_private.internal_deal_link_preview_impl() $wrapper$;

REVOKE ALL ON FUNCTION public.internal_deals_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.internal_deals_list() TO authenticated;
REVOKE ALL ON FUNCTION public.internal_deal_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_detail(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.internal_deal_link_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.internal_deal_link_preview() TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deals_list_impl() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deals_list_impl() TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_detail_impl(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_detail_impl(uuid) TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_deal_link_preview_impl() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.internal_deal_link_preview_impl() TO authenticated;
