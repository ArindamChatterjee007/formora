BEGIN;

CREATE FUNCTION public._push_key(p_value text, p_length integer) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
DECLARE
  decoded bytea;
BEGIN
  IF p_value IS NULL OR pg_catalog.length(p_value) NOT BETWEEN 20 AND 90
    OR p_value !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'Invalid push key' USING ERRCODE = '22023';
  END IF;
  BEGIN
    decoded := pg_catalog.decode(pg_catalog.translate(p_value, '-_', '+/')
      || pg_catalog.repeat('=', (4 - pg_catalog.length(p_value) % 4) % 4), 'base64');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid push key' USING ERRCODE = '22023';
  END;
  IF pg_catalog.octet_length(decoded) <> p_length
    OR (p_length = 65 AND pg_catalog.get_byte(decoded, 0) <> 4)
    OR pg_catalog.translate(pg_catalog.rtrim(pg_catalog.replace(pg_catalog.encode(decoded, 'base64'), E'\n', ''), '='), '+/', '-_') <> p_value THEN
    RAISE EXCEPTION 'Noncanonical push key' USING ERRCODE = '22023';
  END IF;
  RETURN decoded;
END;
$function$;

CREATE FUNCTION public._push_endpoint(p_endpoint text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT p_endpoint IS NOT NULL AND pg_catalog.octet_length(p_endpoint) BETWEEN 40 AND 2048
    AND pg_catalog.length(pg_catalog.regexp_replace(p_endpoint, '^.*/', '')) <= 1800
    AND p_endpoint ~ '^https://(fcm\.googleapis\.com/(fcm/send|wp)/[A-Za-z0-9_:-]{16,}|updates\.push\.services\.mozilla\.com/wpush/v2/[A-Za-z0-9_-]{16,}|web\.push\.apple\.com/[A-Za-z0-9_-]{16,})$'
$function$;

CREATE TABLE public.push_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  registration_enabled boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT false,
  vapid_public_key text,
  consent_version text NOT NULL DEFAULT 'push-generic-v1' CHECK (consent_version = 'push-generic-v1'),
  lease_days integer NOT NULL DEFAULT 30 CHECK (lease_days BETWEEN 1 AND 30),
  dedupe_retention_days integer NOT NULL DEFAULT 30 CHECK (dedupe_retention_days BETWEEN 1 AND 30),
  CHECK (NOT registration_enabled OR vapid_public_key IS NOT NULL),
  CHECK (NOT delivery_enabled OR registration_enabled)
);
INSERT INTO public.push_settings DEFAULT VALUES;

CREATE TABLE public.push_owners (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  window_started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  registrations_in_window integer NOT NULL DEFAULT 0 CHECK (registrations_in_window BETWEEN 0 AND 20)
);

CREATE TABLE public.push_subscriptions (
  device_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.push_owners(owner_id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (public._push_endpoint(endpoint)),
  p256dh bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(p256dh) = 65 AND pg_catalog.get_byte(p256dh, 0) = 4),
  auth_secret bytea NOT NULL UNIQUE CHECK (pg_catalog.octet_length(auth_secret) = 16),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  vapid_public_key text NOT NULL,
  binding_id uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  consent_version text NOT NULL CHECK (consent_version = 'push-generic-v1'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (pg_catalog.isfinite(expires_at) AND expires_at > created_at)
);
CREATE INDEX push_subscriptions_owner ON public.push_subscriptions(owner_id);
CREATE INDEX push_subscriptions_expiry ON public.push_subscriptions(expires_at);

CREATE TABLE public.push_requests (
  owner_id uuid NOT NULL REFERENCES public.push_owners(owner_id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint bytea NOT NULL,
  revision integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (owner_id, request_id)
);
CREATE INDEX push_requests_recent ON public.push_requests(owner_id, revision DESC);

CREATE TABLE public.push_dispatches (
  dispatch_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.push_owners(owner_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.push_subscriptions(device_id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('workout_reminder', 'account_notice')),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z0-9][a-z0-9:_-]{0,79}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  leased_until timestamptz,
  not_before timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_error text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (device_id, category, dedupe_key),
  CHECK (pg_catalog.isfinite(expires_at) AND expires_at > created_at),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND leased_until IS NOT NULL))
);
CREATE INDEX push_dispatches_queue ON public.push_dispatches(state, not_before);
CREATE INDEX push_dispatches_owner ON public.push_dispatches(owner_id, created_at DESC);

-- Dedupe and daily budget survive dispatch pruning, job expiry and 404/410 subscription deletion.
-- Compact by design: no endpoint, key material, payload or prose, and bounded by the retention window.
CREATE TABLE public.push_dispatch_receipts (
  owner_id uuid NOT NULL REFERENCES public.push_owners(owner_id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('workout_reminder', 'account_notice')),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z0-9][a-z0-9:_-]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (owner_id, device_id, category, dedupe_key)
);
CREATE INDEX push_dispatch_receipts_age ON public.push_dispatch_receipts(created_at);
CREATE INDEX push_dispatch_receipts_window ON public.push_dispatch_receipts(owner_id, created_at DESC);

ALTER TABLE public.push_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_dispatch_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_settings, public.push_owners, public.push_subscriptions,
  public.push_requests, public.push_dispatches, public.push_dispatch_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._push_owner() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $function$
DECLARE
  owner_id uuid := auth.uid();
BEGIN
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'authenticated' OR owner_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated member required' USING ERRCODE = '42501';
  END IF;
  RETURN owner_id;
END;
$function$;

CREATE FUNCTION public.configure_push_subscriptions(p_enabled boolean, p_vapid_public_key text, p_lease_days integer DEFAULT 30,
  p_delivery_enabled boolean DEFAULT false, p_dedupe_retention_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.push_settings%ROWTYPE;
  delivery boolean;
BEGIN
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR p_lease_days IS NULL OR p_lease_days NOT BETWEEN 1 AND 30
    OR p_dedupe_retention_days IS NULL OR p_dedupe_retention_days NOT BETWEEN 1 AND 30
    OR p_delivery_enabled IS NULL OR (p_enabled AND p_vapid_public_key IS NULL)
    OR (p_delivery_enabled AND NOT p_enabled) THEN
    RAISE EXCEPTION 'Invalid push configuration' USING ERRCODE = '22023';
  END IF;
  IF p_vapid_public_key IS NOT NULL THEN PERFORM public._push_key(p_vapid_public_key, 65); END IF;
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR UPDATE;
  IF settings.vapid_public_key IS DISTINCT FROM p_vapid_public_key AND EXISTS (SELECT 1 FROM public.push_subscriptions) THEN
    RAISE EXCEPTION 'Revoke existing devices before VAPID rotation' USING ERRCODE = 'PT409';
  END IF;
  delivery := p_enabled AND p_delivery_enabled;
  UPDATE public.push_settings SET registration_enabled = p_enabled, delivery_enabled = delivery,
    vapid_public_key = p_vapid_public_key, lease_days = p_lease_days,
    dedupe_retention_days = p_dedupe_retention_days WHERE singleton;
  RETURN pg_catalog.jsonb_build_object('registration_enabled', p_enabled, 'delivery_implemented', true,
    'delivery_enabled', delivery, 'consent_version', settings.consent_version, 'lease_days', p_lease_days,
    'dedupe_retention_days', p_dedupe_retention_days);
END;
$function$;

CREATE FUNCTION public.get_push_subscription_state(p_device_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public._push_owner();
  owner_revision integer;
  settings public.push_settings%ROWTYPE;
  device public.push_subscriptions%ROWTYPE;
  device_count integer;
BEGIN
  IF p_device_id IS NULL THEN RAISE EXCEPTION 'Device required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('formora.push:' || caller::text, 0));
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton;
  SELECT revision INTO owner_revision FROM public.push_owners WHERE owner_id = caller;
  SELECT * INTO device FROM public.push_subscriptions WHERE device_id = p_device_id AND owner_id = caller
    AND expires_at > pg_catalog.clock_timestamp() AND vapid_public_key = settings.vapid_public_key;
  SELECT count(*)::integer INTO device_count FROM public.push_subscriptions WHERE owner_id = caller
    AND expires_at > pg_catalog.clock_timestamp() AND vapid_public_key = settings.vapid_public_key;
  RETURN pg_catalog.jsonb_build_object('owner_id', caller, 'revision', COALESCE(owner_revision, 0),
    'registration_enabled', settings.registration_enabled, 'delivery_implemented', true,
    'delivery_enabled', settings.delivery_enabled,
    'vapid_public_key', settings.vapid_public_key, 'consent_version', settings.consent_version,
    'device_registered', device.device_id IS NOT NULL, 'binding_id', device.binding_id,
    'fingerprint', device.fingerprint, 'expires_at', device.expires_at, 'registered_devices', device_count);
END;
$function$;

CREATE FUNCTION public._push_replay(p_owner uuid, p_request uuid, p_fingerprint bytea, p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE
  receipt public.push_requests%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM public.push_requests WHERE owner_id = p_owner AND request_id = p_request;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF receipt.fingerprint <> p_fingerprint OR receipt.revision <> p_revision THEN
    RAISE EXCEPTION 'Request changed or superseded; refresh state' USING ERRCODE = 'PT409';
  END IF;
  RETURN receipt.result;
END;
$function$;

CREATE FUNCTION public._push_receipt(p_owner uuid, p_request uuid, p_fingerprint bytea, p_revision integer, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  UPDATE public.push_owners SET revision = p_revision WHERE owner_id = p_owner;
  INSERT INTO public.push_requests(owner_id, request_id, fingerprint, revision, result)
    VALUES (p_owner, p_request, p_fingerprint, p_revision, p_result);
  DELETE FROM public.push_requests WHERE owner_id = p_owner AND revision <= p_revision - 64;
  RETURN p_result;
END;
$function$;

CREATE FUNCTION public.register_push_subscription(
  p_request_id uuid, p_device_id uuid, p_expected_revision integer, p_endpoint text,
  p_p256dh text, p_auth text, p_vapid_public_key text, p_consent_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public._push_owner();
  settings public.push_settings%ROWTYPE;
  owner_state public.push_owners%ROWTYPE;
  device public.push_subscriptions%ROWTYPE;
  public_key bytea;
  auth_key bytea;
  request_fingerprint bytea;
  subscription_fingerprint text;
  replay jsonb;
  result jsonb;
BEGIN
  IF p_request_id IS NULL OR p_device_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR NOT public._push_endpoint(p_endpoint) THEN
    RAISE EXCEPTION 'Invalid push registration' USING ERRCODE = '22023';
  END IF;
  public_key := public._push_key(p_p256dh, 65);
  auth_key := public._push_key(p_auth, 16);
  PERFORM public._push_key(p_vapid_public_key, 65);
  request_fingerprint := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    'register', p_device_id, p_expected_revision, p_endpoint, p_p256dh, p_auth, p_vapid_public_key, p_consent_version)::text, 'UTF8'));
  subscription_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_endpoint || E'\n' || p_p256dh || E'\n' || p_auth, 'UTF8')), 'hex');
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('formora.push:' || caller::text, 0));
  INSERT INTO public.push_owners(owner_id) VALUES (caller) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT owner_state FROM public.push_owners WHERE owner_id = caller FOR UPDATE;
  replay := public._push_replay(caller, p_request_id, request_fingerprint, owner_state.revision);
  IF replay IS NOT NULL THEN
    IF NOT settings.registration_enabled OR NOT EXISTS (SELECT 1 FROM public.push_subscriptions
      WHERE owner_id = caller AND device_id = p_device_id AND binding_id::text = replay ->> 'binding_id'
        AND expires_at > pg_catalog.clock_timestamp() AND vapid_public_key = settings.vapid_public_key) THEN
      RAISE EXCEPTION 'Registration no longer active' USING ERRCODE = 'PT409';
    END IF;
    RETURN replay;
  END IF;
  IF NOT settings.registration_enabled THEN RAISE EXCEPTION 'Push registration disabled' USING ERRCODE = 'PT403'; END IF;
  IF p_vapid_public_key IS DISTINCT FROM settings.vapid_public_key OR p_consent_version IS DISTINCT FROM settings.consent_version THEN
    RAISE EXCEPTION 'Current push configuration and consent required' USING ERRCODE = 'PT409';
  END IF;
  IF p_expected_revision <> owner_state.revision THEN
    RAISE EXCEPTION 'Stale registration; refresh state' USING ERRCODE = 'PT409';
  END IF;
  DELETE FROM public.push_subscriptions WHERE owner_id = caller AND expires_at <= pg_catalog.clock_timestamp();
  IF EXISTS (SELECT 1 FROM public.push_subscriptions WHERE
    (device_id = p_device_id OR endpoint = p_endpoint OR p256dh = public_key OR auth_secret = auth_key)
    AND (owner_id <> caller OR device_id <> p_device_id)) THEN
    RAISE EXCEPTION 'Subscription already bound; revoke it first' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO device FROM public.push_subscriptions WHERE device_id = p_device_id AND owner_id = caller;
  IF device.device_id IS NOT NULL AND device.fingerprint <> subscription_fingerprint THEN
    RAISE EXCEPTION 'Revoke this device before replacing its subscription' USING ERRCODE = 'PT409';
  END IF;
  IF device.device_id IS NULL AND (SELECT count(*) FROM public.push_subscriptions WHERE owner_id = caller) >= 5 THEN
    RAISE EXCEPTION 'Push device quota reached' USING ERRCODE = 'PT429';
  END IF;
  IF owner_state.window_started_at <= pg_catalog.clock_timestamp() - interval '10 minutes' THEN
    UPDATE public.push_owners SET window_started_at = pg_catalog.clock_timestamp(), registrations_in_window = 0 WHERE owner_id = caller;
    owner_state.registrations_in_window := 0;
  END IF;
  IF owner_state.registrations_in_window >= 20 THEN RAISE EXCEPTION 'Push registration rate limit' USING ERRCODE = 'PT429'; END IF;
  UPDATE public.push_owners SET registrations_in_window = registrations_in_window + 1 WHERE owner_id = caller;
  BEGIN
    INSERT INTO public.push_subscriptions(device_id, owner_id, endpoint, p256dh, auth_secret, fingerprint, vapid_public_key, consent_version, expires_at)
      VALUES (p_device_id, caller, p_endpoint, public_key, auth_key, subscription_fingerprint, p_vapid_public_key,
        settings.consent_version, pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => settings.lease_days))
      ON CONFLICT (device_id) DO UPDATE SET expires_at = EXCLUDED.expires_at,
        binding_id = pg_catalog.gen_random_uuid()
      WHERE push_subscriptions.owner_id = caller AND push_subscriptions.fingerprint = subscription_fingerprint
      RETURNING * INTO device;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Subscription already bound; revoke it first' USING ERRCODE = 'PT409';
  END;
  IF device.device_id IS NULL THEN RAISE EXCEPTION 'Subscription already bound' USING ERRCODE = 'PT409'; END IF;
  result := pg_catalog.jsonb_build_object('ok', true, 'operation', 'register', 'request_id', p_request_id,
    'owner_id', caller, 'device_id', p_device_id, 'revision', owner_state.revision + 1,
    'binding_id', device.binding_id, 'fingerprint', device.fingerprint, 'expires_at', device.expires_at,
    'delivery_implemented', true);
  RETURN public._push_receipt(caller, p_request_id, request_fingerprint, owner_state.revision + 1, result);
END;
$function$;

CREATE FUNCTION public.revoke_push_subscriptions(p_request_id uuid, p_device_id uuid, p_expected_revision integer, p_all boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public._push_owner();
  owner_revision integer;
  request_fingerprint bytea;
  replay jsonb;
  removed integer;
  result jsonb;
BEGIN
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_all IS NULL
    OR (NOT p_all AND p_device_id IS NULL) OR (p_all AND p_device_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Explicit device or all-device revocation required' USING ERRCODE = '22023';
  END IF;
  request_fingerprint := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    'revoke', p_device_id, p_expected_revision, p_all)::text, 'UTF8'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('formora.push:' || caller::text, 0));
  INSERT INTO public.push_owners(owner_id) VALUES (caller) ON CONFLICT DO NOTHING;
  SELECT revision INTO STRICT owner_revision FROM public.push_owners WHERE owner_id = caller FOR UPDATE;
  replay := public._push_replay(caller, p_request_id, request_fingerprint, owner_revision);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF p_expected_revision <> owner_revision THEN RAISE EXCEPTION 'Stale revocation; refresh state' USING ERRCODE = 'PT409'; END IF;
  DELETE FROM public.push_subscriptions WHERE owner_id = caller AND (p_all OR device_id = p_device_id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  result := pg_catalog.jsonb_build_object('ok', true, 'operation', CASE WHEN p_all THEN 'revoke_all' ELSE 'revoke_device' END,
    'request_id', p_request_id, 'owner_id', caller, 'device_id', p_device_id,
    'revision', owner_revision + 1, 'revoked_count', removed);
  RETURN public._push_receipt(caller, p_request_id, request_fingerprint, owner_revision + 1, result);
END;
$function$;

CREATE FUNCTION public.prune_expired_push_subscriptions(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.push_settings%ROWTYPE;
  removed integer;
BEGIN
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid batch size' USING ERRCODE = '22023'; END IF;
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR SHARE;
  PERFORM public._push_prune_dedupe(NULL, p_limit, settings.dedupe_retention_days);
  DELETE FROM public.push_subscriptions WHERE device_id IN (SELECT device_id FROM public.push_subscriptions
    WHERE expires_at <= pg_catalog.clock_timestamp() ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

CREATE FUNCTION public._push_service() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $function$
BEGIN
  IF pg_catalog.current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public._push_base64url(p_value bytea) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT pg_catalog.translate(pg_catalog.rtrim(pg_catalog.replace(
    pg_catalog.encode(p_value, 'base64'), E'\n', ''), '='), '+/', '-_')
$function$;

CREATE FUNCTION public._push_prune_dispatches(p_limit integer) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.push_dispatches WHERE dispatch_id IN (
    SELECT dispatch_id FROM public.push_dispatches
    WHERE expires_at <= pg_catalog.clock_timestamp()
      OR (state IN ('sent', 'failed') AND created_at <= pg_catalog.clock_timestamp() - interval '1 day')
    ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

CREATE FUNCTION public._push_prune_dedupe(p_owner uuid, p_limit integer, p_days integer) RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.push_dispatch_receipts WHERE (owner_id, device_id, category, dedupe_key) IN (
    SELECT owner_id, device_id, category, dedupe_key FROM public.push_dispatch_receipts
      WHERE (p_owner IS NULL OR owner_id = p_owner)
        AND created_at <= pg_catalog.clock_timestamp() - pg_catalog.make_interval(days => p_days)
      ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

CREATE FUNCTION public.enqueue_push_dispatch(p_owner_id uuid, p_category text, p_dedupe_key text, p_ttl_minutes integer DEFAULT 360)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.push_settings%ROWTYPE;
  recent integer;
  devices integer;
  fanout integer;
  queued integer;
BEGIN
  PERFORM public._push_service();
  IF p_owner_id IS NULL OR p_dedupe_key IS NULL OR p_ttl_minutes IS NULL
    OR p_ttl_minutes NOT BETWEEN 5 AND 1440
    OR p_category IS NULL OR p_category <> ALL (ARRAY['workout_reminder', 'account_notice'])
    OR p_dedupe_key !~ '^[a-z0-9][a-z0-9:_-]{0,79}$' THEN
    RAISE EXCEPTION 'Approved transactional category and dedupe key required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR SHARE;
  IF NOT settings.delivery_enabled THEN RAISE EXCEPTION 'Push delivery disabled' USING ERRCODE = 'PT403'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('formora.push:' || p_owner_id::text, 0));
  PERFORM public._push_prune_dedupe(p_owner_id, 1000, settings.dedupe_retention_days);
  SELECT count(*)::integer INTO devices FROM public.push_subscriptions WHERE owner_id = p_owner_id
    AND expires_at > pg_catalog.clock_timestamp() AND vapid_public_key = settings.vapid_public_key;
  -- The whole future fanout is counted against the owner budget before anything is inserted, under the same
  -- owner lock. Devices already holding a dedupe receipt are excluded, so a repeat trigger costs no budget.
  SELECT count(*)::integer INTO fanout FROM public.push_subscriptions AS device
    WHERE device.owner_id = p_owner_id AND device.expires_at > pg_catalog.clock_timestamp()
      AND device.vapid_public_key = settings.vapid_public_key
      AND NOT EXISTS (SELECT 1 FROM public.push_dispatch_receipts AS receipt
        WHERE receipt.owner_id = p_owner_id AND receipt.device_id = device.device_id
          AND receipt.category = p_category AND receipt.dedupe_key = p_dedupe_key);
  SELECT count(*)::integer INTO recent FROM public.push_dispatch_receipts
    WHERE owner_id = p_owner_id AND created_at > pg_catalog.clock_timestamp() - interval '1 day';
  IF recent + fanout > 10 THEN RAISE EXCEPTION 'Push dispatch budget reached' USING ERRCODE = 'PT429'; END IF;
  WITH eligible AS (
    SELECT device.owner_id, device.device_id, device.binding_id FROM public.push_subscriptions AS device
      WHERE device.owner_id = p_owner_id AND device.expires_at > pg_catalog.clock_timestamp()
        AND device.vapid_public_key = settings.vapid_public_key
        AND NOT EXISTS (SELECT 1 FROM public.push_dispatch_receipts AS receipt
          WHERE receipt.owner_id = p_owner_id AND receipt.device_id = device.device_id
            AND receipt.category = p_category AND receipt.dedupe_key = p_dedupe_key)
  ), receipted AS (
    INSERT INTO public.push_dispatch_receipts(owner_id, device_id, category, dedupe_key)
      SELECT owner_id, device_id, p_category, p_dedupe_key FROM eligible
      ON CONFLICT DO NOTHING RETURNING device_id
  ), jobs AS (
    INSERT INTO public.push_dispatches(owner_id, device_id, binding_id, category, dedupe_key, expires_at)
      SELECT owner_id, device_id, binding_id, p_category, p_dedupe_key,
        pg_catalog.clock_timestamp() + pg_catalog.make_interval(mins => p_ttl_minutes) FROM eligible
      ON CONFLICT (device_id, category, dedupe_key) DO NOTHING RETURNING dispatch_id
  )
  SELECT count(*)::integer INTO queued FROM jobs;
  RETURN pg_catalog.jsonb_build_object('queued', queued, 'eligible_devices', devices,
    'category', p_category, 'dedupe_key', p_dedupe_key,
    'daily_budget_remaining', greatest(0, 10 - (recent + queued)));
END;
$function$;

CREATE FUNCTION public.claim_push_dispatches(p_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.push_settings%ROWTYPE;
  claimed jsonb;
BEGIN
  PERFORM public._push_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'Invalid batch size' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR SHARE;
  PERFORM public._push_prune_dispatches(100);
  PERFORM public._push_prune_dedupe(NULL, 100, settings.dedupe_retention_days);
  IF NOT settings.delivery_enabled THEN RETURN '[]'::jsonb; END IF;
  WITH due AS (
    SELECT dispatch_id FROM public.push_dispatches
      WHERE (state = 'pending' OR (state = 'leased' AND leased_until <= pg_catalog.clock_timestamp()))
        AND attempts < 3 AND not_before <= pg_catalog.clock_timestamp()
        AND expires_at > pg_catalog.clock_timestamp()
      ORDER BY not_before LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE public.push_dispatches AS dispatch SET state = 'leased', attempts = dispatch.attempts + 1,
      lease_token = pg_catalog.gen_random_uuid(),
      leased_until = pg_catalog.clock_timestamp() + interval '2 minutes'
      FROM due WHERE dispatch.dispatch_id = due.dispatch_id
      RETURNING dispatch.dispatch_id, dispatch.lease_token
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'dispatch_id', dispatch_id, 'lease_token', lease_token)), '[]'::jsonb) INTO claimed FROM leased;
  RETURN claimed;
END;
$function$;

CREATE FUNCTION public.authorize_push_dispatch(p_dispatch_id uuid, p_lease_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.push_settings%ROWTYPE;
  job public.push_dispatches%ROWTYPE;
  device public.push_subscriptions%ROWTYPE;
BEGIN
  PERFORM public._push_service();
  IF p_dispatch_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'Leased dispatch required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT settings FROM public.push_settings WHERE singleton FOR SHARE;
  IF NOT settings.delivery_enabled THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.push_dispatches WHERE dispatch_id = p_dispatch_id
    AND lease_token = p_lease_token AND state = 'leased'
    AND leased_until > pg_catalog.clock_timestamp() AND expires_at > pg_catalog.clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO device FROM public.push_subscriptions WHERE device_id = job.device_id
    AND owner_id = job.owner_id AND binding_id = job.binding_id
    AND expires_at > pg_catalog.clock_timestamp() AND vapid_public_key = settings.vapid_public_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object('dispatch_id', job.dispatch_id, 'category', job.category,
    'binding_id', device.binding_id, 'endpoint', device.endpoint,
    'p256dh', public._push_base64url(device.p256dh), 'auth', public._push_base64url(device.auth_secret),
    'vapid_public_key', device.vapid_public_key, 'ttl_seconds', 3600);
END;
$function$;

CREATE FUNCTION public.finish_push_dispatch(p_dispatch_id uuid, p_lease_token uuid, p_outcome text, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  job public.push_dispatches%ROWTYPE;
  final text;
  removed boolean := false;
BEGIN
  PERFORM public._push_service();
  IF p_dispatch_id IS NULL OR p_lease_token IS NULL
    OR p_outcome IS NULL OR p_outcome <> ALL (ARRAY['sent', 'retry', 'failed', 'gone'])
    OR (p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,40}$') THEN
    RAISE EXCEPTION 'Invalid dispatch outcome' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO job FROM public.push_dispatches WHERE dispatch_id = p_dispatch_id
    AND lease_token = p_lease_token AND state = 'leased'
    AND leased_until > pg_catalog.clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('accepted', false, 'state', NULL, 'removed_subscription', false);
  END IF;
  final := CASE WHEN p_outcome = 'sent' THEN 'sent'
    WHEN p_outcome = 'retry' AND job.attempts < 3 THEN 'pending' ELSE 'failed' END;
  UPDATE public.push_dispatches SET state = final, lease_token = NULL, leased_until = NULL, last_error = p_error,
    not_before = CASE WHEN final = 'pending' THEN pg_catalog.clock_timestamp()
      + pg_catalog.make_interval(secs => least(3600, 30 * 4 ^ job.attempts)) ELSE not_before END
    WHERE dispatch_id = job.dispatch_id;
  IF p_outcome = 'gone' THEN
    DELETE FROM public.push_subscriptions WHERE device_id = job.device_id
      AND owner_id = job.owner_id AND binding_id = job.binding_id;
    removed := FOUND;
  END IF;
  RETURN pg_catalog.jsonb_build_object('accepted', true, 'state', final, 'removed_subscription', removed);
END;
$function$;

REVOKE ALL ON FUNCTION public._push_key(text, integer), public._push_endpoint(text), public._push_owner(),
  public._push_replay(uuid, uuid, bytea, integer), public._push_receipt(uuid, uuid, bytea, integer, jsonb),
  public._push_service(), public._push_base64url(bytea), public._push_prune_dispatches(integer),
  public._push_prune_dedupe(uuid, integer, integer),
  public.configure_push_subscriptions(boolean, text, integer, boolean, integer), public.get_push_subscription_state(uuid),
  public.register_push_subscription(uuid, uuid, integer, text, text, text, text, text),
  public.revoke_push_subscriptions(uuid, uuid, integer, boolean), public.prune_expired_push_subscriptions(integer),
  public.enqueue_push_dispatch(uuid, text, text, integer), public.claim_push_dispatches(integer),
  public.authorize_push_dispatch(uuid, uuid), public.finish_push_dispatch(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_push_subscription_state(uuid),
  public.register_push_subscription(uuid, uuid, integer, text, text, text, text, text),
  public.revoke_push_subscriptions(uuid, uuid, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.configure_push_subscriptions(boolean, text, integer, boolean, integer),
  public.prune_expired_push_subscriptions(integer), public.enqueue_push_dispatch(uuid, text, text, integer),
  public.claim_push_dispatches(integer), public.authorize_push_dispatch(uuid, uuid),
  public.finish_push_dispatch(uuid, uuid, text, text) TO service_role;

COMMIT;