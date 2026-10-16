-- Apply after deal_workflow_queries.sql, deal_financing.sql and deal_installation.sql.
-- Explicit relationship scopes; customer equality never links unrelated customer records.
CREATE OR REPLACE FUNCTION app_private.internal_deal_detail_impl(p_deal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $fn$
DECLARE v_detail jsonb;
BEGIN
 IF NOT (SELECT app_private.is_internal()) OR coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
  RAISE EXCEPTION USING errcode='42501',message='internal MFA required';
 END IF;
 WITH
 scope_deal AS (SELECT d.* FROM public.deals d WHERE d.id=p_deal_id),
 scope_quotes AS (SELECT q.* FROM public.quotes q JOIN scope_deal d ON q.deal_id=d.id AND q.customer_id=d.customer_id),
 scope_orders AS (
  SELECT DISTINCT ON(o.id) o.*,CASE WHEN o.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.orders o JOIN scope_deal d ON o.customer_id=d.customer_id
  WHERE o.deal_id=p_deal_id OR (o.deal_id IS NULL AND o.quote_id IN(SELECT id FROM scope_quotes))
 ),
 scope_pos AS (
  SELECT DISTINCT ON(po.id) po.*,CASE WHEN po.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.purchase_orders po JOIN scope_deal d ON po.customer_id=d.customer_id
  WHERE po.deal_id=p_deal_id OR (po.deal_id IS NULL AND po.order_id IN(SELECT id FROM scope_orders))
 ),
 scope_receiving AS (
  SELECT i.* FROM public.purchase_order_items i WHERE i.purchase_order_id IN(SELECT id FROM scope_pos)
 ),
 scope_deliveries AS (
  SELECT DISTINCT ON(dv.id) dv.*,CASE WHEN dv.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.deliveries dv JOIN scope_deal d ON dv.customer_id=d.customer_id
  WHERE dv.deal_id=p_deal_id OR (dv.deal_id IS NULL AND dv.order_id IN(SELECT id FROM scope_orders))
 ),
 scope_assets AS (
  SELECT DISTINCT ON(a.id) a.*,CASE WHEN a.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.assets a JOIN scope_deal d ON a.customer_id=d.customer_id
  WHERE a.deal_id=p_deal_id OR (a.deal_id IS NULL AND (
    a.source_delivery_id IN(SELECT id FROM scope_deliveries)
    OR a.source_purchase_serial_id IN(
      SELECT ps.id FROM public.purchase_serials ps
      WHERE ps.purchase_order_item_id IN(SELECT id FROM scope_receiving)
    )
  ))
 ),
 scope_contracts AS (
  SELECT DISTINCT ON(ct.id) ct.*,CASE WHEN ct.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.contracts ct JOIN scope_deal d ON ct.customer_id=d.customer_id
  WHERE ct.deal_id=p_deal_id OR (ct.deal_id IS NULL AND ct.id IN (SELECT a.contract_id FROM scope_assets a WHERE a.contract_id IS NOT NULL))
 ),
 scope_tickets AS (
  SELECT DISTINCT ON(t.id) t.*,CASE WHEN t.deal_id=p_deal_id THEN 'direct_deal' ELSE 'confirmed_fk' END AS link_source
  FROM public.support_tickets t JOIN scope_deal d ON t.customer_id=d.customer_id
  WHERE t.deal_id=p_deal_id OR (t.deal_id IS NULL AND (
     t.asset_id IN(SELECT id FROM scope_assets) OR t.contract_id IN(SELECT id FROM scope_contracts)
  ))
 )
 SELECT jsonb_build_object(
 'deal',to_jsonb(d),
 'customer',jsonb_build_object('id',c.id,'name',c.name,'customer_code',c.customer_code,
    'branch_type',c.branch_type,'parent_customer_id',c.parent_customer_id,
    'parent_customer_name',pc.name,'parent_customer_code',pc.customer_code),
 'quotes',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at),'[]'::jsonb) FROM scope_quotes q),
 'orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.created_at),'[]'::jsonb) FROM scope_orders o),
 'financing',(SELECT to_jsonb(f) FROM public.deal_financing f WHERE f.deal_id=p_deal_id),
 'purchase_orders',(SELECT coalesce(jsonb_agg(to_jsonb(po) ORDER BY po.created_at),'[]'::jsonb) FROM scope_pos po),
 'receiving_items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.created_at),'[]'::jsonb) FROM scope_receiving i),
 'deliveries',(SELECT coalesce(jsonb_agg(to_jsonb(dv) ORDER BY dv.created_at),'[]'::jsonb) FROM scope_deliveries dv),
 'installation_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.scheduled_start_at),'[]'::jsonb)
     FROM public.deal_installation_jobs j WHERE j.deal_id=p_deal_id),
 'assets',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.created_at),'[]'::jsonb) FROM scope_assets a),
 'contracts',(SELECT coalesce(jsonb_agg(to_jsonb(ct) ORDER BY ct.created_at),'[]'::jsonb) FROM scope_contracts ct),
 'support_tickets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at),'[]'::jsonb) FROM scope_tickets t),
 'loss_events',(SELECT coalesce(jsonb_agg(to_jsonb(le) ORDER BY le.created_at),'[]'::jsonb) FROM public.deal_loss_events le WHERE le.deal_id=p_deal_id),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(ev) ORDER BY ev.created_at),'[]'::jsonb) FROM public.deal_events ev WHERE ev.deal_id=p_deal_id)
 ) INTO v_detail FROM scope_deal d JOIN public.customers c ON c.id=d.customer_id
 LEFT JOIN public.customers pc ON pc.id=c.parent_customer_id;
 IF v_detail IS NULL THEN RAISE EXCEPTION USING errcode='P0002',message='deal not found';END IF;
 RETURN v_detail;
END;$fn$;
