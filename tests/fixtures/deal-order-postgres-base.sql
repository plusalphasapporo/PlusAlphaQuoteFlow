-- Temporary PostgreSQL-only fixture for real DDL/RPC behavior. Not a Supabase migration.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app_private;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('test.jwt',true), '')::jsonb, '{}'::jsonb) $$;
CREATE FUNCTION app_private.current_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT auth.jwt()->>'role' $$;
CREATE FUNCTION app_private.is_internal() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT (auth.jwt()->>'aal')='aal2' AND (auth.jwt()->>'role') IN ('internal_admin','internal_staff') $$;
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,customer_code text NOT NULL,manual_hold boolean NOT NULL DEFAULT false
);
CREATE FUNCTION app_private.customer_allows_new_transaction(p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT NOT manual_hold FROM public.customers WHERE id=p_customer_id),false) $$;
CREATE SEQUENCE public.test_order_number_seq START 1;
CREATE FUNCTION app_private.next_document_number(p_type text)
RETURNS text LANGUAGE sql AS
$$ SELECT 'O-'||lpad(nextval('public.test_order_number_seq')::text,4,'0') $$;
CREATE FUNCTION app_private.next_legacy_customer_quote_number(p_customer_id uuid,p_date date)
RETURNS text LANGUAGE sql AS
$$ SELECT 'Q-'||customer_code||'-2026-0001' FROM public.customers WHERE id=p_customer_id $$;

CREATE TABLE public.quotes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES public.customers(id),
 quote_number text,quote_date date NOT NULL DEFAULT current_date,
 status text NOT NULL DEFAULT 'draft',valid_until date,project_name text,
 total_amount numeric NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 finalized_at timestamptz,finalized_by uuid
);
CREATE TABLE public.quote_items(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),quote_id uuid NOT NULL REFERENCES public.quotes(id)
);
CREATE TABLE public.orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES public.customers(id),
 quote_id uuid REFERENCES public.quotes(id),
 order_number text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'draft',
 total_amount numeric NOT NULL DEFAULT 0,ordered_at timestamptz,created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES public.customers(id),order_id uuid REFERENCES public.orders(id));
CREATE TABLE public.deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES public.customers(id),order_id uuid REFERENCES public.orders(id));
CREATE TABLE public.assets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES public.customers(id));
CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES public.customers(id));
CREATE TABLE public.support_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES public.customers(id));
CREATE TABLE public.audit_logs(
 actor_user_id uuid,actor_role text,action text,target_type text,target_id text,
 before_data jsonb,after_data jsonb,created_at timestamptz DEFAULT now()
);
SELECT set_config('test.jwt','{"role":"internal_staff","aal":"aal2"}',false);
