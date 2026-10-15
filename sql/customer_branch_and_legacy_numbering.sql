-- Legacy QuoteFlow numbering and visible customer branch relationships.
-- Staging only; does not delete any customers, documents, or integration settings.
-- Historical source covers PA-0001 through PA-0098. Reserve PA-0099 as first
-- new customer number even before the legacy data import is completed.
CREATE OR REPLACE FUNCTION app_private.next_customer_code_impl()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v_next bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('quoteflow_customer_code'));
  SELECT greatest(coalesce(max((regexp_match(customer_code,'^PA-([0-9]+)$'))[1]::bigint),0),98)+1
    INTO v_next
  FROM public.customers WHERE customer_code ~ '^PA-[0-9]+$';
  RETURN 'PA-' || CASE WHEN length(v_next::text)>=4 THEN v_next::text ELSE lpad(v_next::text,4,'0') END;
END $$;

CREATE OR REPLACE FUNCTION app_private.next_legacy_customer_quote_number(
 p_customer_id uuid,p_for_date date DEFAULT (now() AT TIME ZONE 'Asia/Tokyo')::date
)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path TO ''
AS $$
DECLARE v_code text; v_prefix text; v_next bigint;
BEGIN
  SELECT nullif(btrim(customer_code),'') INTO v_code
  FROM public.customers WHERE id=p_customer_id;
  IF v_code IS NULL THEN RAISE EXCEPTION USING errcode='22023',message='customer number is missing'; END IF;
  IF v_code !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION USING errcode='22023',message='customer number contains invalid characters'; END IF;
  v_prefix:='Q-'||v_code||'-'||to_char(coalesce(p_for_date,current_date),'YYYY')||'-';
  PERFORM pg_advisory_xact_lock(hashtext('quoteflow_quote_'||v_prefix));
  SELECT coalesce(max(substring(quote_number from length(v_prefix)+1)::bigint),0)+1
    INTO v_next
  FROM public.quotes
  WHERE starts_with(quote_number,v_prefix)
    AND substring(quote_number from length(v_prefix)+1) ~ '^[0-9]+$';
  RETURN v_prefix || CASE WHEN length(v_next::text)>=4 THEN v_next::text ELSE lpad(v_next::text,4,'0') END;
END $$;
REVOKE ALL ON FUNCTION app_private.next_legacy_customer_quote_number(uuid,date) FROM PUBLIC,anon,authenticated;

-- Prevent branch-to-branch cycles and orphan branches in new or edited records.
CREATE OR REPLACE FUNCTION app_private.validate_customer_branch_hierarchy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v_parent_branch text;
BEGIN
  IF NEW.branch_type='branch' THEN
    IF NEW.parent_customer_id IS NULL OR NEW.parent_customer_id=NEW.id THEN
      RAISE EXCEPTION USING errcode='22023',message='branch requires a different head office customer';
    END IF;
    SELECT c.branch_type INTO v_parent_branch
    FROM public.customers c WHERE c.id=NEW.parent_customer_id;
    IF v_parent_branch IS DISTINCT FROM 'head_office' THEN
      RAISE EXCEPTION USING errcode='22023',message='parent customer must be a head office';
    END IF;
  ELSIF NEW.parent_customer_id IS NOT NULL THEN
    RAISE EXCEPTION USING errcode='22023',message='head office cannot have parent customer';
  END IF;
  IF TG_OP='UPDATE' AND OLD.branch_type='head_office' AND NEW.branch_type='branch'
     AND EXISTS(SELECT 1 FROM public.customers c WHERE c.parent_customer_id=NEW.id) THEN
    RAISE EXCEPTION USING errcode='22023',message='head office with branches cannot be changed to branch';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_quote_customer_branch_hierarchy ON public.customers;
CREATE TRIGGER trg_quote_customer_branch_hierarchy
BEFORE INSERT OR UPDATE OF branch_type,parent_customer_id ON public.customers
FOR EACH ROW EXECUTE FUNCTION app_private.validate_customer_branch_hierarchy();
REVOKE ALL ON FUNCTION app_private.validate_customer_branch_hierarchy() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.finalize_quote_impl(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes%rowtype;
  v_number text;
  v_item_count integer;
  v_today date := timezone('Asia/Tokyo',now())::date;
begin
  if not (select app_private.is_internal()) then
    raise exception using errcode='42501', message='internal role required';
  end if;

  select q.* into v_quote
  from public.quotes q
  where q.id=p_quote_id
  for update;

  if not found then
    raise exception using errcode='P0002', message='quote not found';
  end if;

  if v_quote.status='finalized' then
    return jsonb_build_object(
      'id',v_quote.id,
      'status',v_quote.status,
      'quote_number',v_quote.quote_number,
      'total_amount',v_quote.total_amount,
      'finalized_at',v_quote.finalized_at
    );
  end if;

  if v_quote.status<>'draft' then
    raise exception using errcode='42501', message='only draft quote can be submitted for approval';
  end if;

  if v_quote.valid_until is not null and v_quote.valid_until<v_today then
    raise exception using errcode='22023', message='quote valid_until is in the past';
  end if;

  if not (select app_private.customer_allows_new_transaction(v_quote.customer_id)) then
    raise exception using errcode='42501', message='customer is on manual hold';
  end if;

  select count(*)::integer into v_item_count
  from public.quote_items qi
  where qi.quote_id=p_quote_id;

  if v_item_count<1 then
    raise exception using errcode='22023', message='at least one quote item is required';
  end if;

  v_number := coalesce(nullif(v_quote.quote_number,''),app_private.next_legacy_customer_quote_number(v_quote.customer_id,coalesce(v_quote.quote_date,v_today)));

  update public.quotes
  set quote_number=v_number,
      status='finalized',
      finalized_at=now(),
      finalized_by=auth.uid(),
      approval_return_reason=null,
      approval_returned_at=null,
      approval_returned_by=null,
      updated_at=now()
  where id=p_quote_id
  returning * into v_quote;

  insert into public.audit_logs(
    actor_user_id,actor_role,action,target_type,target_id,after_data,created_at
  )
  values(
    auth.uid(),
    (select app_private.current_role()),
    'quote.submitted_for_approval',
    'quote',
    v_quote.id::text,
    jsonb_build_object(
      'quote_number',v_quote.quote_number,
      'customer_id',v_quote.customer_id,
      'total_amount',v_quote.total_amount,
      'valid_until',v_quote.valid_until
    ),
    now()
  );

  return jsonb_build_object(
    'id',v_quote.id,
    'status',v_quote.status,
    'quote_number',v_quote.quote_number,
    'total_amount',v_quote.total_amount,
    'finalized_at',v_quote.finalized_at
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION app_private.internal_customers_list_impl()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
  if not (select app_private.is_internal()) then raise exception using errcode='42501', message='internal role required'; end if;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',c.id,'customer_code',c.customer_code,'name',c.name,'trade_name',c.trade_name,
      'customer_type',c.customer_type,'name_kana',c.name_kana,'industry',c.industry,
      'representative_name',c.representative_name,'sales_owner_user_id',c.sales_owner_user_id,
      'sales_owner_name',p.display_name,'relationship_started_on',c.relationship_started_on,
      'lead_source',c.lead_source,'branch_type',c.branch_type,'parent_customer_id',c.parent_customer_id,'phone',c.phone,'mobile',c.mobile,
      'email',c.email,'postal_code',c.postal_code,'address1',c.address1,'address2',c.address2,
      'status',c.status,'manual_hold',c.manual_hold,'updated_at',c.updated_at
    ) order by c.name,c.id
  ),'[]'::jsonb) into result
  from public.customers c left join public.profiles p on p.user_id=c.sales_owner_user_id;
  return result;
end;
$function$
;
