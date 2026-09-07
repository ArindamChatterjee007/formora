-- Local-only staged migration; not applied to a hosted database.
-- Requires the existing billing tables, Supabase roles, and a trusted owner.
-- All billing writers must adopt this RPC before its ordering guarantees hold.

BEGIN;

CREATE TABLE public.billing_event_receipts (
  provider text NOT NULL CHECK (provider IN ('razorpay', 'lemonsqueezy')),
  event_id text NOT NULL,
  uid text NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(occurred_at)),
  reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'trialing', 'canceled', 'inactive')),
  input_digest bytea NOT NULL,
  paid_cursor_at timestamptz CHECK (pg_catalog.isfinite(paid_cursor_at)),
  applied boolean NOT NULL DEFAULT false,
  reason text,
  received_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX billing_event_receipts_uid_cursor
  ON public.billing_event_receipts (uid, occurred_at DESC) WHERE applied;
CREATE INDEX billing_event_receipts_reference_cursor
  ON public.billing_event_receipts (uid, provider, reference, occurred_at DESC);

ALTER TABLE public.billing_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_event_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.billing_event_receipts TO service_role;

CREATE FUNCTION public.apply_billing_event(
  p_provider text,
  p_event_id text,
  p_uid text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_reference text,
  p_tier text,
  p_status text,
  p_period_end timestamptz,
  p_raw jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  event_digest bytea;
  receipt_inserted boolean;
  previous_receipt public.billing_event_receipts%ROWTYPE;
  current_entitlement public.entitlements%ROWTYPE;
  has_entitlement boolean;
  last_paid_at timestamptz;
  last_applied_at timestamptz;
  is_paid boolean;
  skip_reason text;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('razorpay', 'lemonsqueezy') THEN
    RAISE EXCEPTION 'Invalid billing provider' USING ERRCODE = '22023';
  END IF;
  IF p_event_id IS NULL OR pg_catalog.length(p_event_id) NOT BETWEEN 1 AND 512
    OR p_event_id ~ '[[:space:][:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid billing event identifier' USING ERRCODE = '22023';
  END IF;
  IF p_uid IS NULL OR pg_catalog.length(p_uid) NOT BETWEEN 1 AND 255
    OR p_uid ~ '[[:space:][:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid billing uid' USING ERRCODE = '22023';
  END IF;
  IF p_event_type IS NULL OR pg_catalog.length(p_event_type) NOT BETWEEN 1 AND 128
    OR p_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' THEN
    RAISE EXCEPTION 'Invalid billing event type' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at IS NULL OR NOT pg_catalog.isfinite(p_occurred_at)
    OR p_occurred_at > pg_catalog.clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid billing event timestamp' USING ERRCODE = '22023';
  END IF;
  IF p_reference IS NULL OR pg_catalog.length(p_reference) NOT BETWEEN 1 AND 512
    OR p_reference ~ '[[:space:][:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid billing reference' USING ERRCODE = '22023';
  END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'pro', 'elite') THEN
    RAISE EXCEPTION 'Invalid billing tier' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'trialing', 'canceled', 'inactive') THEN
    RAISE EXCEPTION 'Invalid billing status' USING ERRCODE = '22023';
  END IF;
  is_paid := p_status IN ('active', 'trialing');
  IF is_paid AND p_tier NOT IN ('pro', 'elite') THEN
    RAISE EXCEPTION 'Active billing events require a paid tier' USING ERRCODE = '22023';
  END IF;
  IF p_period_end IS NOT NULL AND NOT pg_catalog.isfinite(p_period_end) THEN
    RAISE EXCEPTION 'Invalid billing period end' USING ERRCODE = '22023';
  END IF;
  IF p_raw IS NULL OR pg_catalog.jsonb_typeof(p_raw) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Billing raw payload must be a JSON object' USING ERRCODE = '22023';
  END IF;

  event_digest := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      p_uid, p_event_type, EXTRACT(EPOCH FROM p_occurred_at), p_reference,
      p_tier, p_status, EXTRACT(EPOCH FROM p_period_end), p_raw
    )::text, 'UTF8'
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.apply_billing_event:' || p_uid, 0)
  );

  INSERT INTO public.billing_event_receipts (
    provider, event_id, uid, occurred_at, reference, status, input_digest
  ) VALUES (
    p_provider, p_event_id, p_uid, p_occurred_at, p_reference, p_status, event_digest
  ) ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING true INTO receipt_inserted;

  IF receipt_inserted IS DISTINCT FROM true THEN
    SELECT receipt.* INTO STRICT previous_receipt
      FROM public.billing_event_receipts AS receipt
      WHERE receipt.provider = p_provider AND receipt.event_id = p_event_id;
    IF previous_receipt.input_digest IS DISTINCT FROM event_digest THEN
      RAISE EXCEPTION 'Billing event identifier already binds a different input'
        USING ERRCODE = '22023';
    END IF;
    RETURN pg_catalog.jsonb_build_object('applied', false, 'duplicate', true);
  END IF;

  SELECT entitlement.* INTO current_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.uid = p_uid FOR UPDATE;
  has_entitlement := FOUND;

  SELECT pg_catalog.max(receipt.paid_cursor_at) INTO last_paid_at
    FROM public.billing_event_receipts AS receipt
    WHERE receipt.uid = p_uid;
  IF has_entitlement AND current_entitlement.status IN ('active', 'trialing') THEN
    last_paid_at := GREATEST(last_paid_at, current_entitlement.updated_at);
  END IF;
  last_applied_at := last_paid_at;
  IF has_entitlement AND current_entitlement.provider = p_provider
    AND current_entitlement.subscription_id = p_reference THEN
    last_applied_at := GREATEST(last_applied_at, current_entitlement.updated_at);
  END IF;

  IF NOT is_paid AND has_entitlement AND (
    current_entitlement.provider IS DISTINCT FROM p_provider
    OR current_entitlement.subscription_id IS DISTINCT FROM p_reference
  ) THEN
    skip_reason := 'reference_mismatch';
  ELSIF p_occurred_at < last_applied_at OR EXISTS (
    SELECT 1 FROM public.billing_event_receipts AS receipt
    WHERE receipt.uid = p_uid AND receipt.provider = p_provider
      AND receipt.reference = p_reference AND receipt.occurred_at > p_occurred_at
  ) THEN
    skip_reason := 'out_of_order';
  ELSIF is_paid AND (
    (has_entitlement AND current_entitlement.provider = p_provider
      AND current_entitlement.subscription_id = p_reference
      AND current_entitlement.updated_at = p_occurred_at
      AND current_entitlement.status IN ('canceled', 'inactive'))
    OR EXISTS (
      SELECT 1 FROM public.billing_event_receipts AS receipt
      WHERE receipt.uid = p_uid AND receipt.provider = p_provider
        AND receipt.reference = p_reference AND receipt.occurred_at = p_occurred_at
        AND receipt.status IN ('canceled', 'inactive')
    )
  ) THEN
    skip_reason := 'cancellation_wins';
  END IF;

  IF skip_reason IS NULL THEN
    INSERT INTO public.entitlements (
      uid, tier, status, provider, subscription_id, current_period_end, updated_at
    ) VALUES (
      p_uid, CASE WHEN is_paid THEN p_tier ELSE 'free' END, p_status,
      p_provider, p_reference, p_period_end, p_occurred_at
    ) ON CONFLICT (uid) DO UPDATE SET
      tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      provider = EXCLUDED.provider,
      subscription_id = EXCLUDED.subscription_id,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = EXCLUDED.updated_at;
  END IF;

  INSERT INTO public.billing_events (uid, type, raw)
    VALUES (p_uid, p_event_type, p_raw);

  UPDATE public.billing_event_receipts SET applied = (skip_reason IS NULL), reason = skip_reason,
    paid_cursor_at = GREATEST(last_paid_at,
      CASE WHEN skip_reason IS NULL AND is_paid THEN p_occurred_at ELSE NULL END)
    WHERE provider = p_provider AND event_id = p_event_id;

  RETURN pg_catalog.jsonb_build_object('applied', skip_reason IS NULL, 'duplicate', false)
    || CASE WHEN skip_reason IS NULL THEN '{}'::jsonb
      ELSE pg_catalog.jsonb_build_object('reason', skip_reason) END;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_billing_event(
  text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_billing_event(
  text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb
) TO service_role;

COMMIT;