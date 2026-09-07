BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure('public.apply_billing_event(text,text,text,text,timestamp with time zone,text,text,text,timestamp with time zone,jsonb)') IS NULL
    OR pg_catalog.to_regclass('public.billing_event_receipts') IS NULL
    OR pg_catalog.to_regclass('public.entitlements') IS NULL
    OR pg_catalog.to_regclass('public.billing_events') IS NULL THEN
    RAISE EXCEPTION 'Apply the existing billing tables and billing-events.sql before analytics-outbox.sql';
  END IF;
  IF pg_catalog.to_regclass('public.analytics_delivery_config') IS NOT NULL
    OR pg_catalog.to_regclass('public.analytics_outbox') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS schema ON schema.oid = routine.pronamespace
      WHERE schema.nspname = 'public'
        AND routine.proname IN ('_apply_billing_event_without_analytics', 'finish_analytics_delivery')) THEN
    RAISE EXCEPTION 'Analytics objects already exist; use a separately reviewed forward migration, never drop an acknowledgement signature';
  END IF;
END;
$migration$;

LOCK TABLE public.billing_event_receipts, public.entitlements, public.billing_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.analytics_delivery_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  collection_enabled boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT false,
  consent_version text NOT NULL DEFAULT 'billing-analytics-v1'
    CHECK (consent_version ~ '^[a-z0-9-]{1,64}$'),
  enabled_at timestamptz CHECK (pg_catalog.isfinite(enabled_at))
);
INSERT INTO public.analytics_delivery_config DEFAULT VALUES;

CREATE FUNCTION public._analytics_config_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF NEW.collection_enabled AND (NOT OLD.collection_enabled
    OR NEW.consent_version IS DISTINCT FROM OLD.consent_version) THEN
    NEW.enabled_at := pg_catalog.clock_timestamp();
  ELSIF NOT NEW.collection_enabled THEN
    NEW.enabled_at := NULL;
  ELSE
    NEW.enabled_at := OLD.enabled_at;
  END IF;
  IF (OLD.collection_enabled AND NOT NEW.collection_enabled)
    OR (OLD.delivery_enabled AND NOT NEW.delivery_enabled) THEN
    UPDATE public.analytics_outbox SET state = CASE WHEN attempts = 1 THEN 'pending' ELSE 'retry' END,
      attempts = attempts - 1, lease_token = NULL, lease_until = NULL WHERE state = 'leased';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER analytics_config_epoch BEFORE UPDATE ON public.analytics_delivery_config
  FOR EACH ROW EXECUTE FUNCTION public._analytics_config_epoch();

CREATE TABLE public.analytics_billing_sources (
  source_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'razorpay'),
  account_id text NOT NULL CHECK (account_id ~ '^acc_[A-Za-z0-9]{1,128}$'),
  billing_mode text NOT NULL DEFAULT 'unknown' CHECK (billing_mode IN ('unknown', 'test', 'live')),
  verified_at timestamptz CHECK (pg_catalog.isfinite(verified_at)),
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz CHECK (pg_catalog.isfinite(enabled_at)),
  UNIQUE (provider, account_id),
  CHECK (NOT enabled OR (verified_at IS NOT NULL AND billing_mode <> 'unknown'))
);

CREATE FUNCTION public._analytics_source_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    NEW.enabled_at := pg_catalog.clock_timestamp();
  ELSIF NOT NEW.enabled THEN
    NEW.enabled_at := NULL;
  ELSE
    NEW.enabled_at := OLD.enabled_at;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER analytics_source_epoch BEFORE INSERT OR UPDATE ON public.analytics_billing_sources
  FOR EACH ROW EXECUTE FUNCTION public._analytics_source_epoch();

CREATE TABLE public.billing_analytics_consent (
  uid text PRIMARY KEY CHECK (uid ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  granted boolean NOT NULL DEFAULT false,
  version text NOT NULL,
  revision uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    CHECK (pg_catalog.isfinite(captured_at))
);

CREATE TABLE public.analytics_outbox (
  event_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  receipt_provider text NOT NULL,
  receipt_event_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES public.analytics_billing_sources(source_id),
  dedupe_key bytea NOT NULL UNIQUE,
  uid text NOT NULL REFERENCES public.billing_analytics_consent(uid),
  consent_revision uuid NOT NULL,
  consent_version text NOT NULL,
  consent_captured_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(consent_captured_at)),
  event_name text NOT NULL CHECK (event_name IN ('purchase_confirmed', 'refund_confirmed')),
  purchase_event_id uuid REFERENCES public.analytics_outbox(event_id),
  occurred_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(occurred_at)),
  tier text NOT NULL CHECK (tier IN ('pro', 'elite')),
  rail text NOT NULL CHECK (rail IN ('upi', 'card', 'netbanking', 'wallet', 'unknown')),
  currency text NOT NULL CHECK (currency = 'INR'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  price_class text NOT NULL DEFAULT 'other_or_unknown' CHECK (price_class = 'other_or_unknown'),
  billing_mode text NOT NULL CHECK (billing_mode = 'live'),
  charge_kind text NOT NULL DEFAULT 'unknown' CHECK (charge_kind = 'unknown'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'retry', 'leased', 'sending', 'delivered', 'suppressed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  available_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text CHECK (last_error IN ('consent_revoked', 'ineligible', 'timeout', 'network',
    'provider_http', 'provider_rejected', 'invalid_payload', 'attempts_exhausted', 'in_flight_ineligible')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  delivery_authorized_at timestamptz CHECK (pg_catalog.isfinite(delivery_authorized_at)),
  provider_acknowledged_at timestamptz CHECK (pg_catalog.isfinite(provider_acknowledged_at)),
  delivered_at timestamptz,
  UNIQUE (receipt_provider, receipt_event_id),
  FOREIGN KEY (receipt_provider, receipt_event_id)
    REFERENCES public.billing_event_receipts(provider, event_id),
  CHECK ((event_name = 'purchase_confirmed' AND purchase_event_id IS NULL)
    OR (event_name = 'refund_confirmed' AND purchase_event_id IS NOT NULL)),
  CHECK (((state IN ('leased', 'sending') OR (state = 'suppressed' AND last_error = 'in_flight_ineligible'
      AND delivery_authorized_at IS NOT NULL)) AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state NOT IN ('leased', 'sending') AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (provider_acknowledged_at IS NULL OR (delivery_authorized_at IS NOT NULL AND state IN ('delivered', 'suppressed')))
);
CREATE INDEX analytics_outbox_ready ON public.analytics_outbox (available_at, created_at)
  WHERE state IN ('pending', 'retry', 'leased', 'sending');
CREATE INDEX analytics_outbox_owner ON public.analytics_outbox (uid)
  WHERE state IN ('pending', 'retry', 'leased', 'sending');
CREATE INDEX analytics_outbox_purchase ON public.analytics_outbox (purchase_event_id);
CREATE INDEX analytics_prior_captures ON public.billing_events
  ((raw ->> 'account_id'), (raw #>> '{payload,payment,entity,id}'))
  WHERE type IN ('payment.captured', 'order.paid');
CREATE INDEX analytics_prior_refunds ON public.billing_events
  ((raw ->> 'account_id'), (raw #>> '{payload,refund,entity,id}'))
  WHERE type = 'refund.processed';

ALTER TABLE public.analytics_delivery_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_billing_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_analytics_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_delivery_config, public.analytics_billing_sources,
  public.billing_analytics_consent, public.analytics_outbox FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_billing_analytics_consent() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  owner_uid text := auth.uid()::text;
  choice public.billing_analytics_consent%ROWTYPE;
  policy text;
BEGIN
  IF owner_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT consent_version INTO STRICT policy FROM public.analytics_delivery_config WHERE singleton;
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = owner_uid;
  RETURN pg_catalog.jsonb_build_object('granted', COALESCE(choice.granted AND choice.version = policy, false),
    'version', policy, 'choice_version', choice.version,
    'consent_state', CASE WHEN choice.uid IS NULL THEN 'unset'
      WHEN choice.version IS DISTINCT FROM policy THEN 'stale_version'
      WHEN choice.granted THEN 'granted' ELSE 'declined' END,
    'revision', choice.revision, 'captured_at', choice.captured_at);
END;
$function$;

CREATE FUNCTION public.set_billing_analytics_consent(p_granted boolean, p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  owner_uid text := auth.uid()::text;
  policy text;
  choice public.billing_analytics_consent%ROWTYPE;
BEGIN
  IF owner_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT consent_version INTO STRICT policy FROM public.analytics_delivery_config WHERE singleton;
  IF p_granted IS NULL OR (p_granted AND p_version IS DISTINCT FROM policy) THEN
    RAISE EXCEPTION 'Current consent version required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || owner_uid, 0));
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = owner_uid FOR UPDATE;
  IF p_granted AND choice.granted AND choice.version = policy THEN
    RETURN public.get_billing_analytics_consent();
  END IF;
  INSERT INTO public.billing_analytics_consent (uid, granted, version)
    VALUES (owner_uid, p_granted, policy)
    ON CONFLICT (uid) DO UPDATE SET granted = EXCLUDED.granted, version = EXCLUDED.version,
      revision = pg_catalog.gen_random_uuid(), captured_at = pg_catalog.clock_timestamp();
  UPDATE public.analytics_outbox SET state = 'suppressed',
    lease_token = CASE WHEN state = 'sending' THEN lease_token ELSE NULL END,
    lease_until = CASE WHEN state = 'sending' THEN lease_until ELSE NULL END,
    last_error = CASE WHEN state = 'sending' THEN 'in_flight_ineligible' ELSE 'consent_revoked' END
    WHERE uid = owner_uid AND state IN ('pending', 'retry', 'leased', 'sending');
  RETURN public.get_billing_analytics_consent();
END;
$function$;

CREATE FUNCTION public._analytics_integer(input jsonb) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
BEGIN
  IF pg_catalog.jsonb_typeof(input) IS DISTINCT FROM 'number' OR input::text !~ '^[0-9]{1,16}$' THEN
    RETURN NULL;
  END IF;
  IF input::numeric > 9007199254740991 THEN RETURN NULL; END IF;
  RETURN input::text::bigint;
END;
$function$;

ALTER FUNCTION public.apply_billing_event(text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb)
  RENAME TO _apply_billing_event_without_analytics;
REVOKE ALL ON FUNCTION public._apply_billing_event_without_analytics(
  text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_billing_event(
  p_provider text, p_event_id text, p_uid text, p_event_type text,
  p_occurred_at timestamptz, p_reference text, p_tier text, p_status text,
  p_period_end timestamptz, p_raw jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  outcome jsonb;
  known_before boolean := false;
  settings public.analytics_delivery_config%ROWTYPE;
  source public.analytics_billing_sources%ROWTYPE;
  choice public.billing_analytics_consent%ROWTYPE;
  payment jsonb := p_raw #> '{payload,payment,entity}';
  refund jsonb := p_raw #> '{payload,refund,entity}';
  amount bigint;
  entity_created bigint;
  canonical_key bytea;
  purchase_key bytea;
  purchase public.analytics_outbox%ROWTYPE;
  emitted_name text;
  emitted_tier text;
  emitted_rail text;
  analytics_occurred_at timestamptz := pg_catalog.date_trunc('second', p_occurred_at);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.apply_billing_event:' || p_uid, 0));
  IF p_provider = 'razorpay' AND p_event_type IN ('payment.captured', 'order.paid') THEN
    SELECT EXISTS (SELECT 1 FROM public.billing_events AS audit
      WHERE audit.type IN ('payment.captured', 'order.paid')
        AND audit.raw ->> 'account_id' = p_raw ->> 'account_id'
        AND audit.raw #>> '{payload,payment,entity,id}' = payment ->> 'id') INTO known_before;
  ELSIF p_provider = 'razorpay' AND p_event_type = 'refund.processed' THEN
    SELECT EXISTS (SELECT 1 FROM public.billing_events AS audit
      WHERE audit.type = 'refund.processed' AND audit.raw ->> 'account_id' = p_raw ->> 'account_id'
        AND audit.raw #>> '{payload,refund,entity,id}' = refund ->> 'id') INTO known_before;
  END IF;
  outcome := public._apply_billing_event_without_analytics(p_provider, p_event_id, p_uid, p_event_type,
    p_occurred_at, p_reference, p_tier, p_status, p_period_end, p_raw);
  IF outcome ->> 'applied' IS DISTINCT FROM 'true' OR known_before OR p_provider <> 'razorpay' THEN
    RETURN outcome;
  END IF;
  SELECT * INTO STRICT settings FROM public.analytics_delivery_config WHERE singleton;
  IF NOT settings.collection_enabled OR settings.enabled_at IS NULL
    OR settings.enabled_at > analytics_occurred_at OR p_raw ->> 'event' IS DISTINCT FROM p_event_type
    OR public._analytics_integer(p_raw -> 'created_at') IS DISTINCT FROM EXTRACT(EPOCH FROM analytics_occurred_at)
    OR (p_raw ? 'test_mode' AND p_raw -> 'test_mode' IS DISTINCT FROM 'false'::jsonb)
    OR (p_raw ? 'livemode' AND p_raw -> 'livemode' IS DISTINCT FROM 'true'::jsonb) THEN RETURN outcome; END IF;
  SELECT * INTO source FROM public.analytics_billing_sources
    WHERE provider = p_provider AND account_id = p_raw ->> 'account_id';
  IF NOT FOUND OR NOT source.enabled OR source.billing_mode <> 'live' OR source.verified_at IS NULL
    OR source.verified_at > pg_catalog.clock_timestamp() OR source.enabled_at > analytics_occurred_at THEN RETURN outcome; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || p_uid, 0));
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = p_uid;
  IF NOT FOUND OR NOT choice.granted OR choice.version <> settings.consent_version
    OR choice.captured_at > analytics_occurred_at THEN RETURN outcome; END IF;

  IF p_event_type IN ('payment.captured', 'order.paid') AND p_status = 'active' AND p_tier IN ('pro', 'elite') THEN
    amount := public._analytics_integer(payment -> 'amount');
    entity_created := public._analytics_integer(payment -> 'created_at');
    IF payment ->> 'id' IS NULL OR payment ->> 'id' !~ '^pay_[A-Za-z0-9]{1,128}$'
      OR payment ->> 'order_id' IS DISTINCT FROM p_reference OR p_reference !~ '^order_[A-Za-z0-9]{1,128}$'
      OR payment ->> 'status' IS DISTINCT FROM 'captured' OR payment ->> 'currency' IS DISTINCT FROM 'INR'
      OR (payment ? 'captured' AND payment -> 'captured' IS DISTINCT FROM 'true'::jsonb)
      OR public._analytics_integer(payment -> 'amount_refunded') IS DISTINCT FROM 0::bigint
      OR (payment ? 'test_mode' AND payment -> 'test_mode' IS DISTINCT FROM 'false'::jsonb)
      OR amount IS NULL OR amount < 1 OR entity_created IS NULL
      OR entity_created > EXTRACT(EPOCH FROM analytics_occurred_at)
      OR entity_created < EXTRACT(EPOCH FROM GREATEST(choice.captured_at, settings.enabled_at, source.enabled_at)) THEN
      RETURN outcome;
    END IF;
    emitted_name := 'purchase_confirmed';
    emitted_tier := p_tier;
    emitted_rail := CASE WHEN payment ->> 'method' IN ('upi', 'card', 'netbanking', 'wallet')
      THEN payment ->> 'method' ELSE 'unknown' END;
    canonical_key := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(p_provider, source.account_id, 'live', 'payment', payment ->> 'id')::text, 'UTF8'));
  ELSIF p_event_type = 'refund.processed' AND p_status IN ('canceled', 'inactive') THEN
    amount := public._analytics_integer(refund -> 'amount');
    IF refund ->> 'id' IS NULL OR refund ->> 'id' !~ '^rfnd_[A-Za-z0-9]{1,128}$'
      OR refund ->> 'payment_id' IS NULL OR refund ->> 'payment_id' !~ '^pay_[A-Za-z0-9]{1,128}$'
      OR refund ->> 'status' IS DISTINCT FROM 'processed' OR refund ->> 'currency' IS DISTINCT FROM 'INR'
      OR (refund ? 'test_mode' AND refund -> 'test_mode' IS DISTINCT FROM 'false'::jsonb)
      OR amount IS NULL OR amount < 1 THEN RETURN outcome; END IF;
    purchase_key := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(p_provider, source.account_id, 'live', 'payment', refund ->> 'payment_id')::text, 'UTF8'));
    SELECT event.* INTO purchase FROM public.analytics_outbox AS event
      JOIN public.billing_event_receipts AS receipt
        ON receipt.provider = event.receipt_provider AND receipt.event_id = event.receipt_event_id
      WHERE event.dedupe_key = purchase_key AND event.event_name = 'purchase_confirmed'
        AND event.uid = p_uid AND event.source_id = source.source_id AND receipt.reference = p_reference;
    IF NOT FOUND OR purchase.occurred_at > analytics_occurred_at OR amount > purchase.amount_minor
      OR amount + (SELECT COALESCE(pg_catalog.sum(event.amount_minor), 0) FROM public.analytics_outbox AS event
        WHERE event.purchase_event_id = purchase.event_id) > purchase.amount_minor THEN RETURN outcome; END IF;
    emitted_name := 'refund_confirmed';
    emitted_tier := purchase.tier;
      emitted_rail := purchase.rail;
    canonical_key := pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(p_provider, source.account_id, 'live', 'refund', refund ->> 'id')::text, 'UTF8'));
  ELSE
    RETURN outcome;
  END IF;
  INSERT INTO public.analytics_outbox (
    receipt_provider, receipt_event_id, source_id, dedupe_key, uid, consent_revision, consent_version,
    consent_captured_at, event_name, purchase_event_id, occurred_at, tier, rail, currency, amount_minor, billing_mode
  ) VALUES (
    p_provider, p_event_id, source.source_id, canonical_key, p_uid, choice.revision, choice.version,
    choice.captured_at, emitted_name, purchase.event_id, analytics_occurred_at, emitted_tier, emitted_rail, 'INR', amount, 'live'
  ) ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN outcome;
END;
$function$;

REVOKE ALL ON FUNCTION public._analytics_config_epoch(), public._analytics_source_epoch(),
  public._analytics_integer(jsonb), public.get_billing_analytics_consent(),
  public.set_billing_analytics_consent(boolean, text),
  public.apply_billing_event(text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_billing_analytics_consent(),
  public.set_billing_analytics_consent(boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_billing_event(
  text, text, text, text, timestamptz, text, text, text, timestamptz, jsonb
) TO service_role;

CREATE FUNCTION public._analytics_event_eligible(queued public.analytics_outbox) RETURNS boolean
LANGUAGE sql SET search_path = '' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.analytics_delivery_config AS settings
      JOIN public.billing_analytics_consent AS choice ON choice.uid = queued.uid
      JOIN public.analytics_billing_sources AS source ON source.source_id = queued.source_id
      JOIN public.billing_event_receipts AS receipt
        ON receipt.provider = queued.receipt_provider AND receipt.event_id = queued.receipt_event_id
    WHERE settings.singleton
      AND choice.granted AND choice.version = settings.consent_version
      AND choice.version = queued.consent_version AND choice.revision = queued.consent_revision
      AND choice.captured_at = queued.consent_captured_at AND choice.captured_at <= queued.occurred_at
      AND source.enabled AND source.billing_mode = 'live' AND queued.billing_mode = 'live'
      AND source.enabled_at <= queued.created_at AND source.verified_at <= queued.created_at
      AND receipt.applied AND receipt.uid = queued.uid AND receipt.provider = source.provider
  );
$function$;

CREATE FUNCTION public.claim_analytics_events(p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  queued public.analytics_outbox%ROWTYPE;
  token uuid;
  claimed jsonb := '[]'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Analytics batch must contain 1 to 20 events' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.analytics_delivery_config
    WHERE singleton AND collection_enabled AND delivery_enabled) THEN RETURN claimed; END IF;
  FOR queued IN
    SELECT event.* FROM public.analytics_outbox AS event
      WHERE (event.state IN ('pending', 'retry') AND event.available_at <= pg_catalog.clock_timestamp())
        OR (event.state IN ('leased', 'sending') AND event.lease_until <= pg_catalog.clock_timestamp())
      ORDER BY event.available_at, event.created_at, event.event_id
      LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    IF NOT public._analytics_event_eligible(queued) OR queued.attempts >= 6 THEN
      UPDATE public.analytics_outbox SET
        state = CASE WHEN queued.attempts >= 6 THEN 'dead' ELSE 'suppressed' END,
        last_error = CASE WHEN queued.attempts >= 6 THEN 'attempts_exhausted' ELSE 'ineligible' END,
        lease_token = NULL, lease_until = NULL WHERE event_id = queued.event_id;
      CONTINUE;
    END IF;
    token := pg_catalog.gen_random_uuid();
    UPDATE public.analytics_outbox SET state = 'leased', attempts = attempts + 1,
      lease_token = token, lease_until = pg_catalog.clock_timestamp() + interval '60 seconds'
      WHERE event_id = queued.event_id;
    claimed := claimed || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('event_id', queued.event_id, 'lease_token', token));
  END LOOP;
  RETURN claimed;
END;
$function$;

CREATE FUNCTION public.authorize_analytics_delivery(p_event_id uuid, p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  owner_uid text;
  queued public.analytics_outbox%ROWTYPE;
BEGIN
  SELECT uid INTO owner_uid FROM public.analytics_outbox
    WHERE event_id = p_event_id AND lease_token = p_lease_token;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || owner_uid, 0));
  SELECT * INTO queued FROM public.analytics_outbox
    WHERE event_id = p_event_id AND lease_token = p_lease_token FOR UPDATE;
  IF NOT FOUND OR queued.state <> 'leased' OR queued.lease_until <= pg_catalog.clock_timestamp() THEN RETURN NULL; END IF;
  IF NOT public._analytics_event_eligible(queued) THEN
    UPDATE public.analytics_outbox SET state = 'suppressed', last_error = 'ineligible',
      lease_token = NULL, lease_until = NULL WHERE event_id = p_event_id;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.analytics_delivery_config
    WHERE singleton AND collection_enabled AND delivery_enabled) THEN
    UPDATE public.analytics_outbox SET state = CASE WHEN attempts = 1 THEN 'pending' ELSE 'retry' END,
      attempts = attempts - 1, lease_token = NULL, lease_until = NULL WHERE event_id = p_event_id;
    RETURN NULL;
  END IF;
  UPDATE public.analytics_outbox SET state = 'sending', delivery_authorized_at = pg_catalog.clock_timestamp()
    WHERE event_id = p_event_id;
  RETURN pg_catalog.jsonb_build_object('event_id', queued.event_id, 'event_name', queued.event_name,
    'occurred_at', queued.occurred_at, 'properties', pg_catalog.jsonb_build_object(
      'tier', queued.tier, 'rail', queued.rail, 'currency', queued.currency, 'amount_minor', queued.amount_minor,
      'price_class', queued.price_class, 'billing_mode', queued.billing_mode, 'charge_kind', queued.charge_kind));
END;
$function$;

CREATE FUNCTION public.finish_analytics_delivery(
  p_event_id uuid, p_lease_token uuid, p_outcome text, p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  owner_uid text;
  queued public.analytics_outbox%ROWTYPE;
  next_state text;
  error_code text := p_error;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('delivered', 'retry', 'dead')
    OR (p_outcome = 'delivered' AND p_error IS NOT NULL)
    OR (p_outcome <> 'delivered' AND (p_error IS NULL
      OR p_error NOT IN ('timeout', 'network', 'provider_http', 'provider_rejected', 'invalid_payload'))) THEN
    RAISE EXCEPTION 'Invalid analytics outcome' USING ERRCODE = '22023';
  END IF;
  SELECT uid INTO owner_uid FROM public.analytics_outbox
    WHERE event_id = p_event_id AND lease_token = p_lease_token;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('accepted', false); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || owner_uid, 0));
  SELECT * INTO queued FROM public.analytics_outbox
    WHERE event_id = p_event_id AND lease_token = p_lease_token FOR UPDATE;
  IF NOT FOUND OR queued.state NOT IN ('sending', 'suppressed')
    OR (queued.state = 'sending' AND queued.lease_until <= pg_catalog.clock_timestamp()) THEN
    RETURN pg_catalog.jsonb_build_object('accepted', false);
  END IF;
  IF queued.state = 'suppressed' OR NOT public._analytics_event_eligible(queued) THEN
    next_state := 'suppressed'; error_code := 'in_flight_ineligible';
  ELSIF p_outcome = 'retry' AND queued.attempts >= 6 THEN
    next_state := 'dead';
  ELSE
    next_state := p_outcome;
  END IF;
  UPDATE public.analytics_outbox SET state = next_state, last_error = error_code,
    lease_token = NULL, lease_until = NULL,
    available_at = CASE WHEN next_state = 'retry' THEN pg_catalog.clock_timestamp()
      + pg_catalog.make_interval(secs => LEAST(3600, 30 * (1 << (queued.attempts - 1)))) ELSE available_at END,
    provider_acknowledged_at = CASE WHEN p_outcome = 'delivered' THEN pg_catalog.clock_timestamp()
      ELSE provider_acknowledged_at END,
    delivered_at = CASE WHEN next_state = 'delivered' THEN pg_catalog.clock_timestamp() ELSE NULL END
    WHERE event_id = p_event_id;
  RETURN pg_catalog.jsonb_build_object('accepted', true, 'state', next_state);
END;
$function$;

REVOKE ALL ON FUNCTION public._analytics_event_eligible(public.analytics_outbox),
  public.claim_analytics_events(integer), public.authorize_analytics_delivery(uuid, uuid),
  public.finish_analytics_delivery(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analytics_events(integer),
  public.authorize_analytics_delivery(uuid, uuid), public.finish_analytics_delivery(uuid, uuid, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;