-- Read-only preview for all demo-linked business records. Does not remove data.
CREATE OR REPLACE FUNCTION app_private.internal_demo_cleanup_preview_impl()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $preview$
BEGIN
 IF NOT (SELECT app_private.is_internal_admin_aal2()) THEN
   RAISE EXCEPTION USING errcode='42501',message='internal admin MFA required';
 END IF;
 RETURN (
 WITH demo_customers AS (
   SELECT id,customer_code FROM public.customers
   WHERE customer_code IN ('DEMO-CUSTOMER','DEMO-HOKKAIDO','DEMO-MIRAI')
      OR legacy_source='QF_DEMO_20260925_V1'
 ), demo_tickets AS (
   SELECT t.id FROM public.support_tickets t JOIN demo_customers c ON c.id=t.customer_id
 ), demo_quotes AS (
   SELECT q.id FROM public.quotes q JOIN demo_customers c ON c.id=q.customer_id
 ), demo_orders AS (
   SELECT o.id FROM public.orders o JOIN demo_customers c ON c.id=o.customer_id
 ), demo_products AS (
   SELECT id FROM public.products WHERE demo_seed_key='QF_DEMO_20260925_V1'
      OR product_code IN ('PRD-DEMO-001','PRD-DEMO-002','PRD-DEMO-003')
 )
 SELECT jsonb_build_object(
   'demo_customers',(SELECT count(*) FROM demo_customers),
   'demo_companies',(SELECT count(*) FROM public.companies WHERE id IN (SELECT c.company_id FROM public.customers c JOIN demo_customers d ON d.id=c.id)),
   'demo_products',(SELECT count(*) FROM demo_products),
   'demo_quotes',(SELECT count(*) FROM demo_quotes),
   'demo_quote_items',(SELECT count(*) FROM public.quote_items WHERE quote_id IN (SELECT id FROM demo_quotes)),
   'demo_orders',(SELECT count(*) FROM demo_orders),
   'demo_support_tickets',(SELECT count(*) FROM demo_tickets),
   'demo_support_messages',(SELECT count(*) FROM public.support_messages WHERE ticket_id IN (SELECT id FROM demo_tickets)),
   'demo_contacts',(SELECT count(*) FROM public.contacts WHERE customer_id IN (SELECT id FROM demo_customers)),
   'demo_assets',(SELECT count(*) FROM public.assets WHERE customer_id IN (SELECT id FROM demo_customers)),
   'demo_contracts',(SELECT count(*) FROM public.contracts WHERE customer_id IN (SELECT id FROM demo_customers)),
   'demo_purchase_orders',(SELECT count(*) FROM public.purchase_orders WHERE customer_id IN (SELECT id FROM demo_customers)),
   'demo_deliveries',(SELECT count(*) FROM public.deliveries WHERE customer_id IN (SELECT id FROM demo_customers)),
   'demo_knowledge_articles',(SELECT count(*) FROM public.knowledge_articles WHERE demo_seed_key='QF_DEMO_20260925_V1'),
   'demo_customer_users',(SELECT count(*) FROM public.profiles WHERE company_id IN (SELECT c.company_id FROM public.customers c JOIN demo_customers d ON d.id=c.id)),
   'callconnect_calls_preserve',(SELECT count(*) FROM public.callconnect_calls WHERE matched_customer_id IN (SELECT id FROM demo_customers)),
   'callconnect_notifications_preserve',(SELECT count(*) FROM public.callconnect_notifications WHERE matched_customer_id IN (SELECT id FROM demo_customers)),
   'imported_customers',(SELECT count(*) FROM public.customers WHERE legacy_source='quoteflow-data.json:2026-10-06'),
   'imported_products',(SELECT count(*) FROM public.products WHERE product_code IN (SELECT item->>'code' FROM app_private.quote_import_sections s CROSS JOIN LATERAL jsonb_array_elements(s.raw_payload::jsonb) item WHERE s.section_key='quoteflow.products.v1' AND s.run_id='09de7e7e-8a4f-42fd-8418-0faa022ce9f5'::uuid)),
   'imported_quotes',(SELECT count(*) FROM public.quotes WHERE legacy_source='quoteflow-data.json:2026-10-06'),
   'imported_orders',(SELECT count(*) FROM public.orders WHERE legacy_source='quoteflow-data.json:2026-10-06'),
   'legacy_seed_exists',(SELECT exists(SELECT 1 FROM app_private.demo_seed_runs WHERE seed_key='QF_DEMO_20260925_V1'))
 )
 );
END;
$preview$;

CREATE OR REPLACE FUNCTION public.internal_demo_cleanup_preview()
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $wrapper$ SELECT app_private.internal_demo_cleanup_preview_impl() $wrapper$;

REVOKE ALL ON FUNCTION public.internal_demo_cleanup_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.internal_demo_cleanup_preview() TO authenticated;
REVOKE ALL ON FUNCTION app_private.internal_demo_cleanup_preview_impl() FROM PUBLIC, anon, authenticated;
