-- Release 1 / additive schema, no destructive data changes.
CREATE TABLE IF NOT EXISTS public.deals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
 title text NOT NULL DEFAULT '新規案件',
 owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 sales_outcome text NOT NULL DEFAULT 'open' CHECK (sales_outcome IN ('open','won','lost','cancelled_after_order')),
 current_stage text NOT NULL DEFAULT 'quote' CHECK (current_stage IN ('quote','order','finance','procurement','schedule','installation','acceptance','assets','support','lost','cancelled')),
 next_action text,
 due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT deals_id_customer_unique UNIQUE (id,customer_id)
);
CREATE INDEX IF NOT EXISTS deals_customer_stage_idx ON public.deals(customer_id,current_stage,updated_at DESC);
CREATE INDEX IF NOT EXISTS deals_owner_idx ON public.deals(owner_user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS public.deal_loss_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
 quote_id uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
 event_type text NOT NULL CHECK (event_type IN ('lost','reopened')),
 reason_category text, detail text, lost_date date, competitor text, reproposal_on date,
 actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT deal_loss_events_required_details CHECK (
 (event_type='lost' AND lost_date IS NOT NULL AND nullif(btrim(reason_category),'') IS NOT NULL
  AND (reason_category<>'other' OR nullif(btrim(detail),'') IS NOT NULL))
 OR (event_type='reopened' AND nullif(btrim(detail),'') IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deal_loss_events_deal_time_idx ON public.deal_loss_events(deal_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.deal_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 deal_id uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
 event_type text NOT NULL,
 message text,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deal_events_deal_time_idx ON public.deal_events(deal_id,created_at DESC);

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.deliveries ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS deal_id uuid;

-- Composite FK prevents a deal/customer-branch mismatch.
DO $migration$
DECLARE entity_name text; constraint_name text;
BEGIN
 FOREACH entity_name IN ARRAY ARRAY['quotes','orders','purchase_orders','deliveries','assets','contracts','support_tickets'] LOOP
   constraint_name:=entity_name||'_deal_customer_fkey';
   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.'||entity_name) AND conname=constraint_name) THEN
     EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (deal_id,customer_id) REFERENCES public.deals(id,customer_id) ON DELETE RESTRICT',entity_name,constraint_name);
   END IF;
   EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(deal_id) WHERE deal_id IS NOT NULL',entity_name||'_deal_idx',entity_name);
 END LOOP;
END
$migration$;

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_loss_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deal_loss_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deal_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.deals,public.deal_loss_events,public.deal_events TO authenticated;
DROP POLICY IF EXISTS deals_select_internal_aal2 ON public.deals;
CREATE POLICY deals_select_internal_aal2 ON public.deals FOR SELECT TO authenticated
USING ((auth.jwt()->>'aal')='aal2' AND (SELECT app_private.is_internal()));
DROP POLICY IF EXISTS deal_loss_events_select_internal_aal2 ON public.deal_loss_events;
CREATE POLICY deal_loss_events_select_internal_aal2 ON public.deal_loss_events FOR SELECT TO authenticated
USING ((auth.jwt()->>'aal')='aal2' AND (SELECT app_private.is_internal()));
DROP POLICY IF EXISTS deal_events_select_internal_aal2 ON public.deal_events;
CREATE POLICY deal_events_select_internal_aal2 ON public.deal_events FOR SELECT TO authenticated
USING ((auth.jwt()->>'aal')='aal2' AND (SELECT app_private.is_internal()));
