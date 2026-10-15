-- Reserve quote numbers referenced by historical orders even when the
-- corresponding legacy estimate is missing from the imported export.
-- Without this, Q-PA-0025-2026-0003 would be reused incorrectly.
CREATE TABLE IF NOT EXISTS app_private.legacy_quote_number_reservations (
  quote_number text PRIMARY KEY,
  source text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON app_private.legacy_quote_number_reservations FROM PUBLIC, anon, authenticated;

INSERT INTO app_private.legacy_quote_number_reservations(quote_number,source)
SELECT DISTINCT
  btrim(split_part(split_part(o.internal_note,'旧見積番号: ',2),E'\n',1)),
  coalesce(o.legacy_source,'legacy-import')
FROM public.orders o
WHERE o.legacy_source LIKE 'quoteflow-data.json:%'
  AND o.internal_note LIKE '%旧見積番号: %'
  AND btrim(split_part(split_part(o.internal_note,'旧見積番号: ',2),E'\n',1)) ~ '^Q-[A-Za-z0-9_-]+-[0-9]{4}-[0-9]+$'
ON CONFLICT(quote_number) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.next_legacy_customer_quote_number(
  p_customer_id uuid,
  p_for_date date DEFAULT (now() AT TIME ZONE 'Asia/Tokyo')::date
)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO ''
AS $$
DECLARE
  v_code text;
  v_prefix text;
  v_next bigint;
BEGIN
  SELECT nullif(btrim(c.customer_code),'') INTO v_code
  FROM public.customers c WHERE c.id=p_customer_id;
  IF v_code IS NULL THEN
    RAISE EXCEPTION USING errcode='22023', message='customer number is missing';
  END IF;
  IF v_code !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION USING errcode='22023', message='customer number contains invalid characters';
  END IF;

  v_prefix:='Q-'||v_code||'-'||to_char(coalesce(p_for_date,current_date),'YYYY')||'-';
  PERFORM pg_advisory_xact_lock(hashtext('quoteflow_quote_'||v_prefix));

  SELECT coalesce(max(s.seq),0)+1 INTO v_next
  FROM (
    SELECT substring(q.quote_number FROM length(v_prefix)+1)::bigint AS seq
    FROM public.quotes q
    WHERE starts_with(q.quote_number,v_prefix)
      AND substring(q.quote_number FROM length(v_prefix)+1) ~ '^[0-9]+$'
    UNION ALL
    SELECT substring(r.quote_number FROM length(v_prefix)+1)::bigint AS seq
    FROM app_private.legacy_quote_number_reservations r
    WHERE starts_with(r.quote_number,v_prefix)
      AND substring(r.quote_number FROM length(v_prefix)+1) ~ '^[0-9]+$'
  ) s;

  RETURN v_prefix||CASE WHEN length(v_next::text)>=4 THEN v_next::text ELSE lpad(v_next::text,4,'0') END;
END $$;
REVOKE ALL ON FUNCTION app_private.next_legacy_customer_quote_number(uuid,date) FROM PUBLIC, anon, authenticated;
