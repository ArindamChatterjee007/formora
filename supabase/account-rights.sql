BEGIN;

CREATE TABLE public.account_rights_requests (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'erasure')),
  payload jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(payload) = 'object' AND pg_catalog.octet_length(payload::text) <= 2048),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'under_review', 'authorized', 'held', 'cancelled', 'superseded', 'export_ready', 'export_released')),
  snapshot_status text NOT NULL DEFAULT 'not_prepared' CHECK (snapshot_status IN ('not_prepared', 'available', 'released')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (kind = 'export' OR snapshot_status = 'not_prepared'),
  CHECK (status <> 'export_ready' OR (kind = 'export' AND snapshot_status = 'available')),
  CHECK (status <> 'export_released' OR (kind = 'export' AND snapshot_status = 'released')),
  UNIQUE (owner_id, request_id)
);
CREATE INDEX account_rights_owner_date ON public.account_rights_requests(owner_id, created_at DESC, id DESC);

CREATE TABLE public.account_rights_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE,
  request_ref uuid NOT NULL REFERENCES public.account_rights_requests(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('authenticated', 'service_role')),
  actor_id uuid,
  action text NOT NULL,
  previous_version integer NOT NULL CHECK (previous_version >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(payload) = 'object' AND pg_catalog.octet_length(payload::text) <= 2048),
  from_status text,
  to_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((actor_role = 'authenticated') = (actor_id IS NOT NULL)),
  UNIQUE (request_ref, previous_version)
);

ALTER TABLE public.account_rights_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_rights_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_rights_requests, public.account_rights_actions FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.account_rights_exports (
  request_ref uuid PRIMARY KEY REFERENCES public.account_rights_requests(id) ON DELETE RESTRICT,
  archive_text text NOT NULL,
  total_bytes integer NOT NULL CHECK (total_bytes BETWEEN 1 AND 8388608 AND total_bytes = pg_catalog.octet_length(archive_text)),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz NOT NULL
);
ALTER TABLE public.account_rights_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_rights_exports FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.account_rights_holds (
  request_ref uuid NOT NULL REFERENCES public.account_rights_requests(id) ON DELETE RESTRICT,
  hold_ref uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (request_ref, hold_ref)
);
CREATE TABLE public.account_rights_previews (
  operation_id uuid PRIMARY KEY,
  request_ref uuid NOT NULL REFERENCES public.account_rights_requests(id) ON DELETE RESTRICT,
  actor_role text NOT NULL DEFAULT 'service_role' CHECK (actor_role = 'service_role'),
  preview jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(preview) = 'object' AND pg_catalog.octet_length(preview::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.account_rights_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_rights_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_rights_holds, public.account_rights_previews FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.account_rights_owner()
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
BEGIN
  IF NOT (pg_catalog.current_setting('role', true) = 'authenticated'
    OR (pg_catalog.current_setting('role', true) = 'none' AND session_user = 'authenticated')) THEN
    RAISE EXCEPTION 'Authenticated role required' USING ERRCODE = '42501';
  END IF;
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = caller) THEN
    RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401';
  END IF;
  RETURN caller;
END;
$function$;

CREATE FUNCTION public.account_rights_recent_auth()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  methods jsonb := auth.jwt()->'amr';
  method jsonb;
  now_epoch numeric := extract(epoch FROM pg_catalog.clock_timestamp());
BEGIN
  IF pg_catalog.jsonb_typeof(methods) = 'array' AND pg_catalog.octet_length(methods::text) <= 2048 THEN
    FOR method IN SELECT value FROM pg_catalog.jsonb_array_elements(methods) LOOP
      IF method->>'method' IN ('password', 'oauth', 'otp', 'totp')
        AND pg_catalog.jsonb_typeof(method->'timestamp') = 'number' THEN
        IF (method->>'timestamp')::numeric BETWEEN now_epoch - 300 AND now_epoch + 30 THEN RETURN; END IF;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'Fresh authentication required for a new erasure request' USING ERRCODE = 'PT401';
END;
$function$;

CREATE FUNCTION public.account_rights_hold_state(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  request_holds integer;
  report_holds integer;
  hold_version bigint;
BEGIN
  SELECT count(*)::integer INTO request_holds FROM public.account_rights_holds AS held
    JOIN public.account_rights_requests AS request ON request.id = held.request_ref WHERE request.owner_id = p_owner_id;
  SELECT count(*) INTO hold_version FROM public.account_rights_actions AS action
    JOIN public.account_rights_requests AS request ON request.id = action.request_ref
    WHERE request.owner_id = p_owner_id AND action.action IN ('hold', 'release_hold');
  report_holds := public.account_rights_report_holds(p_owner_id);
  RETURN pg_catalog.jsonb_build_object('hold_status', CASE WHEN request_holds > 0 OR report_holds > 0 THEN 'held'
    WHEN report_holds IS NULL THEN 'unknown' ELSE 'clear' END, 'hold_version', hold_version);
END;
$function$;

CREATE FUNCTION public.account_rights_require_clear_holds(p_owner_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF pg_catalog.to_regclass('public.report_cases') IS NOT NULL AND pg_catalog.to_regclass('public.report_evidence_holds') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.report_cases, public.report_evidence_holds IN SHARE MODE';
  END IF;
  IF public.account_rights_hold_state(p_owner_id)->>'hold_status' <> 'clear' THEN
    RAISE EXCEPTION 'Active or unknown evidence holds prevent this action; operator verification required' USING ERRCODE = 'PT409';
  END IF;
END;
$function$;

CREATE FUNCTION public.account_rights_receipt(p_request public.account_rights_requests)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  holds jsonb := public.account_rights_hold_state(p_request.owner_id);
BEGIN
  RETURN pg_catalog.jsonb_build_object('id', p_request.id, 'request_id', p_request.request_id,
    'requester', p_request.owner_id, 'kind', p_request.kind, 'scope', p_request.payload->>'scope',
    'status', p_request.status, 'version', p_request.version, 'created_at', p_request.created_at,
    'updated_at', p_request.updated_at, 'cancel_allowed', p_request.status NOT IN ('cancelled', 'superseded', 'export_released')
      AND holds->>'hold_status' = 'clear', 'snapshot_status', p_request.snapshot_status,
    'release_allowed', p_request.kind = 'export' AND p_request.snapshot_status = 'available' AND holds->>'hold_status' = 'clear',
    'account_deleted', false, 'execution_allowed', false,
    'hold_status', holds->'hold_status', 'hold_version', holds->'hold_version');
END;
$function$;

CREATE FUNCTION public.submit_account_rights_request(p_request_id uuid, p_kind text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  receipt public.account_rights_requests%ROWTYPE;
  expected jsonb;
BEGIN
  IF p_kind = 'export' THEN
    expected := CASE WHEN p_payload->>'scope' = 'account_server_personal_v2'
      THEN '{"schema_version":2,"scope":"account_server_personal_v2"}'::jsonb
      ELSE '{"schema_version":1,"scope":"account_profile_logs_v1"}'::jsonb END;
  ELSIF p_kind = 'erasure' THEN
    expected := '{"schema_version":1,"scope":"account_erasure_review_v1","confirmed":true}'::jsonb;
  END IF;
  IF p_request_id IS NULL OR expected IS NULL OR p_payload IS NULL
    OR pg_catalog.octet_length(p_payload::text) > 2048 OR p_payload IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Invalid account-rights request or missing confirmation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || caller::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE owner_id = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF receipt.kind <> p_kind OR receipt.payload <> p_payload THEN
      RAISE EXCEPTION 'Request identifier conflict' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    IF p_kind = 'erasure' THEN PERFORM public.account_rights_recent_auth(); END IF;
    IF p_kind = 'export' AND (SELECT count(*) FROM public.account_rights_requests WHERE owner_id = caller
      AND kind = 'export' AND snapshot_status = 'not_prepared' AND status NOT IN ('cancelled', 'superseded')) >= 8 THEN
      RAISE EXCEPTION 'Pending export request capacity reached; finish or cancel an existing request' USING ERRCODE = 'PT429';
    END IF;
    IF (SELECT count(*) FROM public.account_rights_requests
      WHERE owner_id = caller AND created_at > pg_catalog.clock_timestamp() - interval '1 day') >= 20 THEN
      RAISE EXCEPTION 'Request limit reached; retry later' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.account_rights_requests(owner_id, request_id, kind, payload)
      VALUES (caller, p_request_id, p_kind, p_payload) RETURNING * INTO receipt;
    INSERT INTO public.account_rights_actions(operation_id, request_ref, actor_role, actor_id, action, previous_version, to_status)
      VALUES (pg_catalog.gen_random_uuid(), receipt.id, 'authenticated', caller, 'received', 0, 'received');
  END IF;
  RETURN public.account_rights_receipt(receipt);
END;
$function$;

CREATE FUNCTION public.my_account_rights_request(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  receipt public.account_rights_requests%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  RETURN public.account_rights_receipt(receipt);
END;
$function$;

CREATE FUNCTION public.my_account_rights_requests(p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  items jsonb;
  has_more boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_before IS NULL) <> (p_before_id IS NULL)
    OR (p_before IS NOT NULL AND NOT pg_catalog.isfinite(p_before)) THEN
    RAISE EXCEPTION 'Invalid request cursor or limit' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(public.account_rights_receipt(receipt) ORDER BY receipt.created_at DESC, receipt.id DESC), '[]'::jsonb)
    INTO items FROM (SELECT * FROM public.account_rights_requests WHERE owner_id = caller
      AND (p_before IS NULL OR (created_at, id) < (p_before, p_before_id))
      ORDER BY created_at DESC, id DESC LIMIT p_limit + 1) AS receipt;
  has_more := pg_catalog.jsonb_array_length(items) > p_limit;
  IF has_more THEN items := items - p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object('requester', caller, 'items', items, 'has_more', has_more,
    'next_cursor', CASE WHEN has_more THEN pg_catalog.jsonb_build_object('created_at', items->-1->>'created_at', 'id', items->-1->>'id') ELSE NULL END);
END;
$function$;

CREATE FUNCTION public.cancel_account_rights_request(p_id uuid, p_version integer, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  receipt public.account_rights_requests%ROWTYPE;
  prior public.account_rights_actions%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_version IS NULL OR p_version < 1 OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Request, version and operation identifier required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || caller::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = caller FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  SELECT * INTO prior FROM public.account_rights_actions WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.request_ref <> p_id OR prior.actor_id IS DISTINCT FROM caller OR prior.actor_role <> 'authenticated'
      OR prior.action <> 'cancelled' OR prior.previous_version <> p_version THEN
      RAISE EXCEPTION 'Operation identifier conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN public.account_rights_receipt(receipt);
  END IF;
  IF receipt.version <> p_version OR receipt.status IN ('cancelled', 'superseded', 'export_released') THEN
    RAISE EXCEPTION 'Request changed; refresh before cancelling' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public.account_rights_require_clear_holds(caller);
  DELETE FROM public.account_rights_exports WHERE request_ref = p_id;
  INSERT INTO public.account_rights_actions(operation_id, request_ref, actor_role, actor_id, action, previous_version, from_status, to_status)
    VALUES (p_operation_id, p_id, 'authenticated', caller, 'cancelled', p_version, receipt.status, 'cancelled');
  UPDATE public.account_rights_requests SET status = 'cancelled', version = version + 1,
    snapshot_status = CASE WHEN snapshot_status = 'available' THEN 'released' ELSE snapshot_status END,
    updated_at = pg_catalog.clock_timestamp() WHERE id = p_id RETURNING * INTO receipt;
  RETURN public.account_rights_receipt(receipt);
END;
$function$;

CREATE FUNCTION public.my_account_rights_history(p_id uuid, p_before_version integer DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  items jsonb;
  has_more boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_before_version < 1 THEN
    RAISE EXCEPTION 'Invalid history cursor or limit' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_rights_requests WHERE id = p_id AND owner_id = caller) THEN
    RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', action.id, 'action', action.action,
    'version', action.previous_version + 1, 'from_status', action.from_status, 'to_status', action.to_status,
    'created_at', action.created_at) ORDER BY action.previous_version DESC), '[]'::jsonb) INTO items
    FROM (SELECT * FROM public.account_rights_actions WHERE request_ref = p_id
      AND (p_before_version IS NULL OR previous_version + 1 < p_before_version)
      ORDER BY previous_version DESC LIMIT p_limit + 1) AS action;
  has_more := pg_catalog.jsonb_array_length(items) > p_limit;
  IF has_more THEN items := items - p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object('requester', caller, 'request_ref', p_id, 'items', items, 'has_more', has_more,
    'next_before_version', CASE WHEN has_more THEN (items->-1->>'version')::integer ELSE NULL END);
END;
$function$;

CREATE FUNCTION public.account_rights_project(p_value jsonb, p_shape jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  result jsonb;
  field record;
BEGIN
  IF p_shape = '"scalar"'::jsonb THEN
    IF pg_catalog.jsonb_typeof(p_value) IN ('object', 'array') THEN
      RAISE EXCEPTION 'Stored account data needs a reviewed export' USING ERRCODE = 'PT422';
    END IF;
    RETURN p_value;
  ELSIF pg_catalog.jsonb_typeof(p_shape) = 'array' THEN
    IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Stored log is not an array; no archive produced' USING ERRCODE = 'PT422';
    END IF;
    SELECT coalesce(pg_catalog.jsonb_agg(public.account_rights_project(value, p_shape->0) ORDER BY position), '[]'::jsonb)
      INTO result FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS elements(value, position);
    RETURN result;
  END IF;
  IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Stored account object is malformed; no archive produced' USING ERRCODE = 'PT422';
  END IF;
  result := '{}'::jsonb;
  FOR field IN SELECT key, value FROM pg_catalog.jsonb_each(p_shape) LOOP
    IF p_value ? field.key THEN
      result := result || pg_catalog.jsonb_build_object(field.key, public.account_rights_project(p_value->field.key, field.value));
    END IF;
  END LOOP;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.account_rights_project_v2(p_value jsonb, p_shape jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  result jsonb := '{}'::jsonb;
  field record;
  expected text := p_shape #>> '{}';
  actual text := pg_catalog.jsonb_typeof(p_value);
BEGIN
  IF pg_catalog.jsonb_typeof(p_shape) = 'object' AND p_shape ? '$nullable' THEN
    IF actual = 'null' THEN RETURN p_value; END IF;
    RETURN public.account_rights_project_v2(p_value, p_shape->'$nullable');
  END IF;
  IF pg_catalog.jsonb_typeof(p_shape) = 'string' THEN
    IF actual = 'null' THEN RETURN p_value; END IF;
    IF (expected IN ('string', 'uuid', 'timestamp', 'url') AND actual <> 'string')
      OR (expected IN ('number', 'integer') AND actual <> 'number')
      OR (expected = 'draft_number' AND (actual NOT IN ('number', 'string') OR (actual = 'string'
        AND (p_value #>> '{}') !~ '^$|^[0-9]+([.][0-9]*)?([eE][+-]?[0-9]+)?$|^[.][0-9]+([eE][+-]?[0-9]+)?$')))
      OR (expected = 'boolean' AND actual <> 'boolean') OR actual IS NULL THEN
      RAISE EXCEPTION 'Stored personal field has an unverified type; no archive produced' USING ERRCODE = 'PT422';
    END IF;
    IF expected IN ('number', 'draft_number') AND (p_value #>> '{}') <> '' THEN
      BEGIN
        PERFORM (p_value #>> '{}')::double precision;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Stored number is not safely representable; no archive produced' USING ERRCODE = 'PT422';
      END;
    END IF;
    IF expected = 'uuid' AND (p_value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Stored owner reference is malformed' USING ERRCODE = 'PT422';
    ELSIF expected = 'integer' AND ((p_value #>> '{}')::numeric <> pg_catalog.trunc((p_value #>> '{}')::numeric)
      OR pg_catalog.abs((p_value #>> '{}')::numeric) > 9007199254740991) THEN
      RAISE EXCEPTION 'Stored integer is not safely representable' USING ERRCODE = 'PT422';
    ELSIF expected = 'timestamp' THEN
      BEGIN
        IF (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T' OR NOT pg_catalog.isfinite((p_value #>> '{}')::timestamptz) THEN
          RAISE EXCEPTION 'Stored timestamp is malformed' USING ERRCODE = 'PT422';
        END IF;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Stored timestamp is malformed' USING ERRCODE = 'PT422';
      END;
    ELSIF expected = 'url' AND (p_value #>> '{}') !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^?#[:space:]]*)?$' THEN
      RETURN 'null'::jsonb;
    END IF;
    IF expected NOT IN ('string', 'uuid', 'timestamp', 'url', 'number', 'integer', 'boolean', 'draft_number') THEN
      RAISE EXCEPTION 'Unknown export projection type' USING ERRCODE = 'PT422';
    END IF;
    RETURN p_value;
  ELSIF pg_catalog.jsonb_typeof(p_shape) = 'array' THEN
    IF actual IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Stored personal collection is malformed' USING ERRCODE = 'PT422';
    END IF;
    IF pg_catalog.jsonb_array_length(p_value) > 10000 THEN
      RAISE EXCEPTION 'Stored collection exceeds export capacity; no partial archive produced' USING ERRCODE = 'PT413';
    END IF;
    SELECT coalesce(pg_catalog.jsonb_agg(public.account_rights_project_v2(value, p_shape->0) ORDER BY position), '[]'::jsonb)
      INTO result FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY AS elements(value, position);
    RETURN result;
  END IF;
  IF actual IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Stored personal object is malformed' USING ERRCODE = 'PT422';
  END IF;
  FOR field IN SELECT key, value FROM pg_catalog.jsonb_each(p_shape) LOOP
    IF p_value ? field.key THEN
      result := result || pg_catalog.jsonb_build_object(field.key, public.account_rights_project_v2(p_value->field.key, field.value));
    END IF;
  END LOOP;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.account_rights_export_sources_v2()
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  profile_shape jsonb := '{"name":"string","email":"string","phone":"string","gender":"string","dob":"string","age":"number","heightCm":"number","startWeightKg":"number","weightKg":"number","targetWeightKg":"number","goal":"string","physique":"string","physiqueChosen":"boolean","diet":"string","activityFactor":"number","bio":"string","username":"string","privacy":"string","verified":"boolean","unit":"string","experience":"string","onboarded":"boolean","socials":{"instagram":"string","linkedin":"string","facebook":"string"},"avatar":"url","cover":"url","coverUrl":"url"}'::jsonb;
  state_shape jsonb;
BEGIN
  profile_shape := profile_shape || '{"bodyFat":"number","bmi":"number","tier":"string","following":["string"],"autoFollowed":["string"],"referredBy":"string","score":"number","streak":"number","workouts":"number","seen":"number"}'::jsonb;
  state_shape := pg_catalog.jsonb_build_object('profile', profile_shape) || '{"updatedAt":"number","weightLog":[{"date":"string","kg":"number"}],"workoutLog":[{"date":"string","split":"string","volume":"number","finalizationRequestId":"string","exercises":[{"id":"string","name":"string","muscle":"string","equip":"string","photo":"url","images":["url"],"sets":[{"reps":"number","weight":"number"}]}]}],"foodLog":[{"date":"string","items":[{"id":"string","text":"string","kcal":"number","protein":"number","carbs":"number","fat":"number","qty":"number","unit":"string"}]}],"restDays":["string"],"draftSession":{"$nullable":{"date":"string","session":{"split":"string","editing":"boolean","origDate":"string","items":[{"selected":"string","options":["string"],"ex":{"$nullable":{"id":"string","name":"string","muscle":"string","equip":"string","photo":"url","images":["url"]}},"sets":[{"reps":"draft_number","weight":"draft_number"}]}]}}}}'::jsonb;
  RETURN pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('id', 'identity', 'version', 1, 'source', 'auth.users', 'owner_filter', 'id = auth.uid()',
      'columns', '{"auth.users":{"id":"uuid","email":["text","varchar"],"created_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","email":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT member.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', member.id, ''email'', member.email, ''created_at'', member.created_at) AS value FROM auth.users AS member WHERE member.id = $1'),
    pg_catalog.jsonb_build_object('id', 'account', 'version', 1, 'source', 'public.accounts', 'owner_filter', 'uid = auth.uid()::text',
      'columns', '{"public.accounts":{"uid":"text","data":"jsonb","updated_at":"timestamptz"}}'::jsonb,
      'shape', pg_catalog.jsonb_build_object('uid', 'uuid', 'source_updated_at', 'timestamp', 'state', state_shape),
      'query', 'SELECT account.uid AS sort_key, pg_catalog.jsonb_build_object(''uid'', account.uid, ''source_updated_at'', account.updated_at, ''state'', account.data) AS value FROM public.accounts AS account WHERE account.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'profile', 'version', 1, 'source', 'public.profiles', 'owner_filter', 'uid = auth.uid()::text',
      'columns', '{"public.profiles":{"uid":"text","data":"jsonb"}}'::jsonb,
      'shape', pg_catalog.jsonb_build_object('uid', 'uuid', 'data', profile_shape),
      'query', 'SELECT profile.uid AS sort_key, pg_catalog.jsonb_build_object(''uid'', profile.uid, ''data'', profile.data) AS value FROM public.profiles AS profile WHERE profile.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'rights_requests', 'version', 1, 'source', 'public.account_rights_requests', 'owner_filter', 'owner_id = auth.uid()',
      'columns', '{"public.account_rights_requests":{"id":"uuid","owner_id":"uuid","request_id":"uuid","payload":"jsonb","kind":"text","status":"text","snapshot_status":"text","version":"int4","created_at":"timestamptz","updated_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","request_id":"uuid","requester":"uuid","kind":"string","scope":"string","status":"string","version":"integer","created_at":"timestamp","updated_at":"timestamp","cancel_allowed":"boolean","account_deleted":"boolean","execution_allowed":"boolean","snapshot_status":"string","release_allowed":"boolean","hold_status":"string","hold_version":"integer"}'::jsonb,
      'query', 'SELECT request.id::text AS sort_key, public.account_rights_receipt(request) AS value FROM public.account_rights_requests AS request WHERE request.owner_id = $1'),
    pg_catalog.jsonb_build_object('id', 'rights_actions', 'version', 1, 'source', 'public.account_rights_actions', 'owner_filter', 'request_ref joins a request with owner_id = auth.uid()',
      'columns', '{"public.account_rights_requests":{"id":"uuid","owner_id":"uuid"},"public.account_rights_actions":{"id":"uuid","request_ref":"uuid","action":"text","previous_version":"int4","from_status":"text","to_status":"text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"request_ref":"uuid","action":"string","version":"integer","from_status":"string","to_status":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT action.id::text AS sort_key, pg_catalog.jsonb_build_object(''request_ref'', action.request_ref, ''action'', action.action, ''version'', action.previous_version + 1, ''from_status'', action.from_status, ''to_status'', action.to_status, ''created_at'', action.created_at) AS value FROM public.account_rights_actions AS action JOIN public.account_rights_requests AS request ON request.id = action.request_ref WHERE request.owner_id = $1'),
    pg_catalog.jsonb_build_object('id', 'posts', 'version', 1, 'source', 'public.posts', 'owner_filter', 'author = auth.uid()::text',
      'columns', '{"public.posts":{"id":"text","author":"text","data":"jsonb","likes":"jsonb","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","author":"uuid","ts":"timestamp","liked_by_requester":"boolean","data":{"text":"string","body":"string","photo":"url","photos":{"$nullable":["url"]},"video":"url","gradient":{"$nullable":["string"]},"tag":"string","reshareOf":"string","resharedFrom":"string","music":{"$nullable":{"id":"string","title":"string","artist":"string","src":"url","cover":"url","genre":"string","source":"string"}}}}'::jsonb,
      'query', 'SELECT post.id AS sort_key, pg_catalog.jsonb_build_object(''id'', post.id, ''author'', post.author, ''ts'', post.ts, ''data'', post.data, ''liked_by_requester'', coalesce(post.likes->$1::text = ''true''::jsonb,false)) AS value FROM public.posts AS post WHERE post.author = $1::text'),
    pg_catalog.jsonb_build_object('id', 'comments', 'version', 1, 'source', 'public.comments', 'owner_filter', 'author = auth.uid()::text',
      'columns', '{"public.comments":{"id":"text","post_id":"text","author":"text","body":"text","parent_id":"text","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","post_id":"string","author":"uuid","body":"string","parent_id":"string","ts":"timestamp"}'::jsonb,
      'query', 'SELECT comment.id AS sort_key, pg_catalog.jsonb_build_object(''id'', comment.id, ''post_id'', comment.post_id, ''author'', comment.author, ''body'', comment.body, ''parent_id'', comment.parent_id, ''ts'', comment.ts) AS value FROM public.comments AS comment WHERE comment.author = $1::text'),
    pg_catalog.jsonb_build_object('id', 'messages', 'version', 1, 'source', 'public.messages', 'owner_filter', 'from_uid = auth.uid()::text OR to_uid = auth.uid()::text; existing participant read contract',
      'columns', '{"public.messages":{"id":"text","from_uid":"text","to_uid":"text","body":"text","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","from_uid":"string","to_uid":"string","body":"string","ts":"timestamp"}'::jsonb,
      'query', 'SELECT message.id AS sort_key, pg_catalog.jsonb_build_object(''id'', message.id, ''from_uid'', message.from_uid, ''to_uid'', message.to_uid, ''body'', message.body, ''ts'', message.ts) AS value FROM public.messages AS message WHERE message.from_uid = $1::text OR message.to_uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'connections', 'version', 1, 'source', 'public.requests', 'owner_filter', 'from_uid = auth.uid()::text OR to_uid = auth.uid()::text',
      'columns', '{"public.requests":{"id":"text","from_uid":"text","to_uid":"text","status":"text","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","from_uid":"string","to_uid":"string","status":"string","ts":"timestamp"}'::jsonb,
      'query', 'SELECT connection.id AS sort_key, pg_catalog.jsonb_build_object(''id'', connection.id, ''from_uid'', connection.from_uid, ''to_uid'', connection.to_uid, ''status'', connection.status, ''ts'', connection.ts) AS value FROM public.requests AS connection WHERE connection.from_uid = $1::text OR connection.to_uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'notifications', 'version', 1, 'source', 'public.notifications', 'owner_filter', 'uid = auth.uid()::text; references only, no body or actor',
      'columns', '{"public.notifications":{"id":"text","uid":"text","type":"text","post_id":"text","read":"bool","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","uid":"uuid","type":"string","post_id":"string","read":"boolean","ts":"timestamp"}'::jsonb,
      'query', 'SELECT notification.id AS sort_key, pg_catalog.jsonb_build_object(''id'', notification.id, ''uid'', notification.uid, ''type'', notification.type, ''post_id'', notification.post_id, ''read'', notification.read, ''ts'', notification.ts) AS value FROM public.notifications AS notification WHERE notification.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'legacy_stories', 'version', 1, 'source', 'public.stories', 'owner_filter', 'author = auth.uid()::text; includes retained expired own rows',
      'columns', '{"public.stories":{"id":"text","author":"text","photo":"text","kind":"text","ts":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","author":"uuid","photo":"url","kind":"string","ts":"timestamp"}'::jsonb,
      'query', 'SELECT story.id AS sort_key, pg_catalog.jsonb_build_object(''id'', story.id, ''author'', story.author, ''photo'', story.photo, ''kind'', story.kind, ''ts'', story.ts) AS value FROM public.stories AS story WHERE story.author = $1::text'),
    pg_catalog.jsonb_build_object('id', 'stories', 'version', 1, 'source', 'public.stories_v2', 'owner_filter', 'owner = auth.uid(); includes retained expired/deleted own rows',
      'columns', '{"public.stories_v2":{"id":"uuid","owner":"uuid","kind":"text","audience":"text","created_at":"timestamptz","expires_at":"timestamptz","deleted_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","owner":"uuid","kind":"string","audience":"string","created_at":"timestamp","expires_at":"timestamp","deleted_at":"timestamp"}'::jsonb,
      'query', 'SELECT story.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', story.id, ''owner'', story.owner, ''kind'', story.kind, ''audience'', story.audience, ''created_at'', story.created_at, ''expires_at'', story.expires_at, ''deleted_at'', story.deleted_at) AS value FROM public.stories_v2 AS story WHERE story.owner = $1'),
    pg_catalog.jsonb_build_object('id', 'story_content', 'version', 1, 'source', 'public.story_content', 'owner_filter', 'story_id joins stories_v2 with owner = auth.uid(); retained public URLs only',
      'columns', '{"public.stories_v2":{"id":"uuid","owner":"uuid"},"public.story_content":{"story_id":"uuid","media_url":"text"}}'::jsonb,
      'shape', '{"story_id":"uuid","owner":"uuid","media_url":"url"}'::jsonb,
      'query', 'SELECT content.story_id::text AS sort_key, pg_catalog.jsonb_build_object(''story_id'', content.story_id, ''owner'', story.owner, ''media_url'', content.media_url) AS value FROM public.story_content AS content JOIN public.stories_v2 AS story ON story.id = content.story_id WHERE story.owner = $1'),
    pg_catalog.jsonb_build_object('id', 'story_interactions', 'version', 1, 'source', 'public.story_interactions', 'owner_filter', 'viewer = auth.uid(); never other viewers even on own Stories',
      'columns', '{"public.story_interactions":{"story_id":"uuid","viewer":"uuid","qualified_at":"timestamptz","liked":"bool"}}'::jsonb,
      'shape', '{"story_id":"uuid","viewer":"uuid","qualified_at":"timestamp","liked":"boolean"}'::jsonb,
      'query', 'SELECT interaction.story_id::text AS sort_key, pg_catalog.jsonb_build_object(''story_id'', interaction.story_id, ''viewer'', interaction.viewer, ''qualified_at'', interaction.qualified_at, ''liked'', interaction.liked) AS value FROM public.story_interactions AS interaction WHERE interaction.viewer = $1'),
    pg_catalog.jsonb_build_object('id', 'story_blocks', 'version', 1, 'source', 'public.story_blocks', 'owner_filter', 'blocker = auth.uid(); no incoming block identities',
      'columns', '{"public.story_blocks":{"blocker":"uuid","blocked":"uuid"}}'::jsonb,
      'shape', '{"blocker":"uuid","blocked":"uuid"}'::jsonb,
      'query', 'SELECT block.blocked::text AS sort_key, pg_catalog.jsonb_build_object(''blocker'', block.blocker, ''blocked'', block.blocked) AS value FROM public.story_blocks AS block WHERE block.blocker = $1'),
    pg_catalog.jsonb_build_object('id', 'story_preferences', 'version', 1, 'source', 'public.story_notification_preferences', 'owner_filter', 'uid = auth.uid()',
      'columns', '{"public.story_notification_preferences":{"uid":"uuid","likes":"bool","replies":"bool","sound":"bool","reply_permission":"text","version":"int4"}}'::jsonb,
      'shape', '{"uid":"uuid","likes":"boolean","replies":"boolean","sound":"boolean","reply_permission":"string","version":"integer"}'::jsonb,
      'query', 'SELECT preference.uid::text AS sort_key, pg_catalog.jsonb_build_object(''uid'', preference.uid, ''likes'', preference.likes, ''replies'', preference.replies, ''sound'', preference.sound, ''reply_permission'', preference.reply_permission, ''version'', preference.version) AS value FROM public.story_notification_preferences AS preference WHERE preference.uid = $1'),
    pg_catalog.jsonb_build_object('id', 'story_notifications', 'version', 1, 'source', 'public.story_notifications', 'owner_filter', 'recipient = auth.uid(); references only, no actor identity',
      'columns', '{"public.story_notifications":{"id":"uuid","recipient":"uuid","story_id":"uuid","kind":"text","message_id":"text","created_at":"timestamptz","read_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","recipient":"uuid","story_id":"uuid","kind":"string","message_id":"string","created_at":"timestamp","read_at":"timestamp"}'::jsonb,
      'query', 'SELECT notification.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', notification.id, ''recipient'', notification.recipient, ''story_id'', notification.story_id, ''kind'', notification.kind, ''message_id'', notification.message_id, ''created_at'', notification.created_at, ''read_at'', notification.read_at) AS value FROM public.story_notifications AS notification WHERE notification.recipient = $1'),
    pg_catalog.jsonb_build_object('id', 'story_reports', 'version', 1, 'source', 'public.story_reports', 'owner_filter', 'reporter = auth.uid(); own submission only, no reported_uid',
      'columns', '{"public.story_reports":{"id":"uuid","reporter":"uuid","story_id":"uuid","message_id":"text","reason":"text","status":"text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","reporter":"uuid","story_id":"uuid","message_id":"string","reason":"string","status":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT report.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', report.id, ''reporter'', report.reporter, ''story_id'', report.story_id, ''message_id'', report.message_id, ''reason'', report.reason, ''status'', report.status, ''created_at'', report.created_at) AS value FROM public.story_reports AS report WHERE report.reporter = $1'),
    pg_catalog.jsonb_build_object('id', 'support_cases', 'version', 1, 'source', 'public.support_cases', 'owner_filter', 'owner = auth.uid()',
      'columns', '{"public.support_cases":{"id":"uuid","owner":"uuid","request_id":"uuid","subject":"text","status":"text","version":"int4","created_at":"timestamptz","updated_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","owner":"uuid","request_id":"uuid","subject":"string","status":"string","version":"integer","created_at":"timestamp","updated_at":"timestamp"}'::jsonb,
      'query', 'SELECT ticket.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', ticket.id, ''owner'', ticket.owner, ''request_id'', ticket.request_id, ''subject'', ticket.subject, ''status'', ticket.status, ''version'', ticket.version, ''created_at'', ticket.created_at, ''updated_at'', ticket.updated_at) AS value FROM public.support_cases AS ticket WHERE ticket.owner = $1'),
    pg_catalog.jsonb_build_object('id', 'support_messages', 'version', 1, 'source', 'public.support_messages', 'owner_filter', 'case_id joins support_cases with owner = auth.uid() AND visibility = thread; no staff identity',
      'columns', '{"public.support_cases":{"id":"uuid","owner":"uuid"},"public.support_messages":{"id":"uuid","case_id":"uuid","author_role":"text","visibility":"text","body":"text","evidence":"_text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","case_id":"uuid","owner":"uuid","author_role":"string","visibility":"string","body":"string","evidence":["string"],"created_at":"timestamp"}'::jsonb,
      'query', 'SELECT message.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', message.id, ''case_id'', message.case_id, ''owner'', ticket.owner, ''author_role'', message.author_role, ''visibility'', message.visibility, ''body'', message.body, ''evidence'', coalesce(pg_catalog.to_jsonb(message.evidence),''[]''::jsonb), ''created_at'', message.created_at) AS value FROM public.support_messages AS message JOIN public.support_cases AS ticket ON ticket.id = message.case_id WHERE ticket.owner = $1 AND message.visibility = ''thread'''),
    pg_catalog.jsonb_build_object('id', 'legacy_support', 'version', 1, 'source', 'public.support_tickets', 'owner_filter', 'uid = auth.uid()::text; legacy aliases excluded',
      'columns', '{"public.support_tickets":{"id":["uuid","int8"],"uid":"text","email":"text","subject":"text","message":"text","tier":"text","status":"text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","uid":"uuid","email":"string","subject":"string","message":"string","tier":"string","status":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT ticket.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', ticket.id::text, ''uid'', ticket.uid, ''email'', ticket.email, ''subject'', ticket.subject, ''message'', ticket.message, ''tier'', ticket.tier, ''status'', ticket.status, ''created_at'', ticket.created_at) AS value FROM public.support_tickets AS ticket WHERE ticket.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'reports', 'version', 1, 'source', 'public.report_cases', 'owner_filter', 'reporter = auth.uid(); never reports where caller is merely the subject',
      'columns', '{"public.report_cases":{"id":"uuid","reporter":"uuid","request_id":"uuid","kind":"text","target_id":"text","reason":"text","status":"text","version":"int4","created_at":"timestamptz","updated_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","reporter":"uuid","request_id":"uuid","kind":"string","target_id":"string","reason":"string","status":"string","version":"integer","created_at":"timestamp","updated_at":"timestamp"}'::jsonb,
      'query', 'SELECT report.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', report.id, ''reporter'', report.reporter, ''request_id'', report.request_id, ''kind'', report.kind, ''target_id'', report.target_id, ''reason'', report.reason, ''status'', report.status, ''version'', report.version, ''created_at'', report.created_at, ''updated_at'', report.updated_at) AS value FROM public.report_cases AS report WHERE report.reporter = $1'),
    pg_catalog.jsonb_build_object('id', 'consent', 'version', 1, 'source', 'public.billing_analytics_consent', 'owner_filter', 'uid = auth.uid()::text; includes the stored withdrawal choice',
      'columns', '{"public.billing_analytics_consent":{"uid":"text","granted":"bool","version":"text","revision":"uuid","captured_at":"timestamptz"}}'::jsonb,
      'shape', '{"uid":"uuid","granted":"boolean","version":"string","revision":"uuid","captured_at":"timestamp"}'::jsonb,
      'query', 'SELECT consent.uid AS sort_key, pg_catalog.jsonb_build_object(''uid'', consent.uid, ''granted'', consent.granted, ''version'', consent.version, ''revision'', consent.revision, ''captured_at'', consent.captured_at) AS value FROM public.billing_analytics_consent AS consent WHERE consent.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'activation', 'version', 1, 'source', 'public.activation_members', 'owner_filter', 'uid = auth.uid(); own recorded measurement facts only',
      'columns', '{"public.activation_members":{"uid":"uuid","consent_version":"text","consent_revision":"uuid","consent_captured_at":"timestamptz","registered_at":"timestamptz","first_workout_at":"timestamptz","pending_workout_date":"date","history_state":"text","incomplete_reason":"text"}}'::jsonb,
      'shape', '{"uid":"uuid","consent_version":"string","consent_revision":"uuid","consent_captured_at":"timestamp","registered_at":"timestamp","first_workout_at":"timestamp","pending_workout_date":"string","history_state":"string","incomplete_reason":"string"}'::jsonb,
      'query', 'SELECT member.uid::text AS sort_key, pg_catalog.jsonb_build_object(''uid'', member.uid, ''consent_version'', member.consent_version, ''consent_revision'', member.consent_revision, ''consent_captured_at'', member.consent_captured_at, ''registered_at'', member.registered_at, ''first_workout_at'', member.first_workout_at, ''pending_workout_date'', member.pending_workout_date, ''history_state'', member.history_state, ''incomplete_reason'', member.incomplete_reason) AS value FROM public.activation_members AS member WHERE member.uid = $1'),
    pg_catalog.jsonb_build_object('id', 'workout_finalizations', 'version', 1, 'source', 'public.activation_finalization_receipts', 'owner_filter', 'uid = auth.uid()',
      'columns', '{"public.activation_finalization_receipts":{"uid":"uuid","request_id":"uuid","workout_date":"date","recorded_at":"timestamptz"}}'::jsonb,
      'shape', '{"uid":"uuid","request_id":"uuid","workout_date":"string","recorded_at":"timestamp"}'::jsonb,
      'query', 'SELECT receipt.request_id::text AS sort_key, pg_catalog.jsonb_build_object(''uid'', receipt.uid, ''request_id'', receipt.request_id, ''workout_date'', receipt.workout_date, ''recorded_at'', receipt.recorded_at) AS value FROM public.activation_finalization_receipts AS receipt WHERE receipt.uid = $1'),
    pg_catalog.jsonb_build_object('id', 'entitlements', 'version', 1, 'source', 'public.entitlements', 'owner_filter', 'uid = auth.uid()::text; provider references are not credentials',
      'columns', '{"public.entitlements":{"uid":"text","tier":"text","status":"text","provider":"text","subscription_id":"text","current_period_end":"timestamptz","updated_at":"timestamptz"}}'::jsonb,
      'shape', '{"uid":"uuid","tier":"string","status":"string","provider":"string","subscription_id":"string","current_period_end":"timestamp","updated_at":"timestamp"}'::jsonb,
      'query', 'SELECT entitlement.uid AS sort_key, pg_catalog.jsonb_build_object(''uid'', entitlement.uid, ''tier'', entitlement.tier, ''status'', entitlement.status, ''provider'', entitlement.provider, ''subscription_id'', entitlement.subscription_id, ''current_period_end'', entitlement.current_period_end, ''updated_at'', entitlement.updated_at) AS value FROM public.entitlements AS entitlement WHERE entitlement.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'billing_receipts', 'version', 1, 'source', 'public.billing_event_receipts', 'owner_filter', 'uid = auth.uid()::text; no input digest or webhook payload',
      'columns', '{"public.billing_event_receipts":{"provider":"text","event_id":"text","uid":"text","occurred_at":"timestamptz","reference":"text","status":"text","paid_cursor_at":"timestamptz","applied":"bool","reason":"text","received_at":"timestamptz"}}'::jsonb,
      'shape', '{"provider":"string","event_id":"string","uid":"uuid","occurred_at":"timestamp","reference":"string","status":"string","paid_cursor_at":"timestamp","applied":"boolean","reason":"string","received_at":"timestamp"}'::jsonb,
      'query', 'SELECT pg_catalog.jsonb_build_array(receipt.provider,receipt.event_id)::text AS sort_key, pg_catalog.jsonb_build_object(''provider'', receipt.provider, ''event_id'', receipt.event_id, ''uid'', receipt.uid, ''occurred_at'', receipt.occurred_at, ''reference'', receipt.reference, ''status'', receipt.status, ''paid_cursor_at'', receipt.paid_cursor_at, ''applied'', receipt.applied, ''reason'', receipt.reason, ''received_at'', receipt.received_at) AS value FROM public.billing_event_receipts AS receipt WHERE receipt.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'billing_history', 'version', 1, 'source', 'public.billing_events', 'owner_filter', 'uid = auth.uid()::text; metadata only, never raw',
      'columns', '{"public.billing_events":{"id":["uuid","int8"],"uid":"text","type":"text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"string","uid":"uuid","type":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT event.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', event.id::text, ''uid'', event.uid, ''type'', event.type, ''created_at'', event.created_at) AS value FROM public.billing_events AS event WHERE event.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'analytics_events', 'version', 1, 'source', 'public.analytics_outbox', 'owner_filter', 'uid = auth.uid()::text; own financial/consent/delivery facts, no lease tokens',
      'columns', '{"public.analytics_outbox":{"event_id":"uuid","uid":"text","event_name":"text","occurred_at":"timestamptz","tier":"text","rail":"text","currency":"text","amount_minor":"int8","consent_version":"text","consent_captured_at":"timestamptz","state":"text","provider_acknowledged_at":"timestamptz","delivered_at":"timestamptz"}}'::jsonb,
      'shape', '{"event_id":"uuid","uid":"uuid","event_name":"string","occurred_at":"timestamp","tier":"string","rail":"string","currency":"string","amount_minor":"integer","consent_version":"string","consent_captured_at":"timestamp","state":"string","provider_acknowledged_at":"timestamp","delivered_at":"timestamp"}'::jsonb,
      'query', 'SELECT event.event_id::text AS sort_key, pg_catalog.jsonb_build_object(''event_id'', event.event_id, ''uid'', event.uid, ''event_name'', event.event_name, ''occurred_at'', event.occurred_at, ''tier'', event.tier, ''rail'', event.rail, ''currency'', event.currency, ''amount_minor'', event.amount_minor, ''consent_version'', event.consent_version, ''consent_captured_at'', event.consent_captured_at, ''state'', event.state, ''provider_acknowledged_at'', event.provider_acknowledged_at, ''delivered_at'', event.delivered_at) AS value FROM public.analytics_outbox AS event WHERE event.uid = $1::text'),
    pg_catalog.jsonb_build_object('id', 'auth_contact', 'version', 1, 'source', 'auth.users', 'owner_filter', 'id = auth.uid(); fixed contact/status columns only, no tokens or metadata objects',
      'columns', '{"auth.users":{"id":"uuid","phone":"text","email_confirmed_at":"timestamptz","phone_confirmed_at":"timestamptz","updated_at":"timestamptz","last_sign_in_at":"timestamptz"}}'::jsonb,
      'shape', '{"id":"uuid","phone":"string","email_confirmed_at":"timestamp","phone_confirmed_at":"timestamp","updated_at":"timestamp","last_sign_in_at":"timestamp"}'::jsonb,
      'query', 'SELECT member.id::text AS sort_key, pg_catalog.jsonb_build_object(''id'', member.id, ''phone'', member.phone, ''email_confirmed_at'', member.email_confirmed_at, ''phone_confirmed_at'', member.phone_confirmed_at, ''updated_at'', member.updated_at, ''last_sign_in_at'', member.last_sign_in_at) AS value FROM auth.users AS member WHERE member.id = $1'),
    pg_catalog.jsonb_build_object('id', 'post_reactions', 'version', 1, 'source', 'public.posts', 'owner_filter', 'likes[auth.uid()::text] = true; no other liker or post content',
      'columns', '{"public.posts":{"id":"text","likes":"jsonb"}}'::jsonb,
      'shape', '{"post_id":"string","viewer":"uuid","liked":"boolean"}'::jsonb,
      'query', 'SELECT post.id AS sort_key, pg_catalog.jsonb_build_object(''post_id'', post.id, ''viewer'', $1::uuid, ''liked'', true) AS value FROM public.posts AS post WHERE post.likes->$1::text = ''true''::jsonb'),
    pg_catalog.jsonb_build_object('id', 'story_actions', 'version', 1, 'source', 'public.story_action_receipts', 'owner_filter', 'actor = auth.uid(); action metadata only, never cached response or digest',
      'columns', '{"public.story_action_receipts":{"actor":"uuid","request_id":"uuid","action":"text","created_at":"timestamptz"}}'::jsonb,
      'shape', '{"actor":"uuid","request_id":"uuid","action":"string","created_at":"timestamp"}'::jsonb,
      'query', 'SELECT receipt.request_id::text AS sort_key, pg_catalog.jsonb_build_object(''actor'', receipt.actor, ''request_id'', receipt.request_id, ''action'', receipt.action, ''created_at'', receipt.created_at) AS value FROM public.story_action_receipts AS receipt WHERE receipt.actor = $1')
  );
END;
$function$;

CREATE FUNCTION public.account_rights_source_status_v2(p_columns jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  source record;
  field record;
  relation oid;
  missing jsonb := '[]'::jsonb;
  missing_table boolean := false;
BEGIN
  FOR source IN SELECT key, value FROM pg_catalog.jsonb_each(p_columns) LOOP
    relation := pg_catalog.to_regclass(source.key);
    IF relation IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_tables
      WHERE schemaname = pg_catalog.split_part(source.key, '.', 1) AND tablename = pg_catalog.split_part(source.key, '.', 2)) THEN
      missing_table := true;
      missing := missing || pg_catalog.jsonb_build_array(source.key);
    ELSE
      FOR field IN SELECT key, value FROM pg_catalog.jsonb_each(source.value) LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = relation AND attname = field.key
          AND attnum > 0 AND NOT attisdropped AND atttypid IN (SELECT pg_catalog.to_regtype('pg_catalog.' || expected_type)
            FROM pg_catalog.jsonb_array_elements_text(CASE WHEN pg_catalog.jsonb_typeof(field.value) = 'array'
              THEN field.value ELSE pg_catalog.jsonb_build_array(field.value) END) AS allowed(expected_type))) THEN
          missing := missing || pg_catalog.jsonb_build_array(source.key || '.' || field.key);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('available', missing = '[]'::jsonb, 'status', CASE WHEN missing_table THEN 'missing_table'
    WHEN missing <> '[]'::jsonb THEN 'schema_mismatch' ELSE 'available' END, 'missing_columns', missing);
END;
$function$;

CREATE FUNCTION public.account_rights_export_guard_v2(p_rows integer, p_bytes bigint)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF p_rows IS NULL OR p_bytes IS NULL OR p_rows > 10000 OR p_bytes > 8388608 THEN
    RAISE EXCEPTION 'Known server data exceeds export capacity; no partial archive produced' USING ERRCODE = 'PT413';
  END IF;
  RETURN true;
END;
$function$;

CREATE FUNCTION public.account_rights_collect_export_v2(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  source jsonb;
  availability jsonb;
  inventory jsonb := '[]'::jsonb;
  projection jsonb := '{}'::jsonb;
  count_queries text[] := ARRAY[]::text[];
  data_fields text[] := ARRAY[]::text[];
  result jsonb;
BEGIN
  IF p_owner_id IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE = '22023'; END IF;
  FOR source IN SELECT value FROM pg_catalog.jsonb_array_elements(public.account_rights_export_sources_v2()) LOOP
    availability := public.account_rights_source_status_v2(source->'columns');
    inventory := inventory || pg_catalog.jsonb_build_array((source - 'query' - 'shape' - 'columns') || availability
      || '{"row_limit":10000,"source_execution_allowed":false}'::jsonb);
    projection := projection || pg_catalog.jsonb_build_object(source->>'id', source->'shape');
    IF (availability->>'available')::boolean THEN
      count_queries := pg_catalog.array_append(count_queries, pg_catalog.format(
        'SELECT %L::text AS source_id, count(*)::integer AS matched_rows, coalesce(sum(pg_catalog.octet_length(value::text)::bigint + 2),0)::bigint AS source_bytes FROM (%s ORDER BY sort_key LIMIT 10001) AS bounded', source->>'id', source->>'query'));
      data_fields := pg_catalog.array_append(data_fields, pg_catalog.format(
        '%L, (SELECT coalesce(pg_catalog.jsonb_agg(public.account_rights_project_v2(value, %L::jsonb) ORDER BY sort_key), ''[]''::jsonb) FROM (%s ORDER BY sort_key LIMIT 10001) AS bounded)', source->>'id', source->'shape', source->>'query'));
    ELSE
      data_fields := pg_catalog.array_append(data_fields, pg_catalog.format('%L, NULL', source->>'id'));
    END IF;
  END LOOP;
  IF pg_catalog.cardinality(count_queries) = 0 THEN
    count_queries := ARRAY['SELECT NULL::text AS source_id, 0::integer AS matched_rows, 0::bigint AS source_bytes WHERE false'];
  END IF;
  EXECUTE 'WITH counts AS MATERIALIZED (' || pg_catalog.array_to_string(count_queries, ' UNION ALL ') || ')
    SELECT CASE WHEN public.account_rights_export_guard_v2(coalesce((SELECT max(matched_rows) FROM counts),0),
      coalesce((SELECT sum(source_bytes) FROM counts),0)::bigint) THEN pg_catalog.jsonb_build_object(
      ''data'', pg_catalog.jsonb_build_object(' || pg_catalog.array_to_string(data_fields, ', ') || '),
      ''projection'', $3::jsonb, ''known_source_schemas_available'', NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements($2::jsonb) AS source WHERE NOT (source->>''available'')::boolean),
      ''source_inventory'', (SELECT pg_catalog.jsonb_agg(source || pg_catalog.jsonb_build_object(''matched_rows'', counts.matched_rows,
        ''truncated'', false) ORDER BY position) FROM pg_catalog.jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entries(source,position)
        LEFT JOIN counts ON counts.source_id = source->>''id'')) END'
    INTO result USING p_owner_id, inventory, projection;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.account_rights_export_info(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  SELECT pg_catalog.jsonb_build_object('schema_version', 1, 'request_ref', exported.request_ref,
    'requester', request.owner_id, 'generated_at', exported.generated_at, 'total_bytes', exported.total_bytes,
    'sha256', exported.sha256, 'max_chunk_bytes', 32768, 'operation_status', 'committed',
    'operation_id', (SELECT action.operation_id FROM public.account_rights_actions AS action
      WHERE action.request_ref = p_id AND action.action = 'export_ready'), 'receipt', public.account_rights_receipt(request))
    FROM public.account_rights_exports AS exported JOIN public.account_rights_requests AS request ON request.id = exported.request_ref
    WHERE exported.request_ref = p_id;
$function$;

CREATE FUNCTION public.prepare_account_rights_export(p_id uuid, p_version integer, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  receipt public.account_rights_requests%ROWTYPE;
  prior public.account_rights_actions%ROWTYPE;
  generated timestamptz := pg_catalog.clock_timestamp();
  profile_shape jsonb := '{"name":"scalar","email":"scalar","phone":"scalar","gender":"scalar","dob":"scalar","age":"scalar","heightCm":"scalar","startWeightKg":"scalar","weightKg":"scalar","targetWeightKg":"scalar","goal":"scalar","physique":"scalar","physiqueChosen":"scalar","diet":"scalar","activityFactor":"scalar","bio":"scalar","username":"scalar","privacy":"scalar","verified":"scalar","unit":"scalar","experience":"scalar","onboarded":"scalar","socials":{"instagram":"scalar","linkedin":"scalar","facebook":"scalar"}}'::jsonb;
  state_shape jsonb;
  records jsonb;
  history jsonb;
  archive_text text;
  archive_bytes integer;
BEGIN
  IF p_id IS NULL OR p_version IS NULL OR p_version < 1 OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Request, version and operation identifier required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || caller::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = caller FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  IF receipt.kind <> 'export' OR receipt.status IN ('cancelled', 'superseded', 'held', 'export_released') THEN
    RAISE EXCEPTION 'Request cannot produce an export' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public.account_rights_require_clear_holds(caller);
  SELECT * INTO prior FROM public.account_rights_actions WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.request_ref <> p_id OR prior.actor_id IS DISTINCT FROM caller OR prior.actor_role <> 'authenticated'
      OR prior.action <> 'export_ready' OR prior.previous_version <> p_version THEN
      RAISE EXCEPTION 'Operation identifier conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN public.account_rights_export_info(p_id);
  END IF;
  IF receipt.version <> p_version OR receipt.status NOT IN ('received', 'under_review') THEN
    RAISE EXCEPTION 'Request changed; refresh before exporting' USING ERRCODE = 'PT409';
  END IF;
  IF (SELECT count(*) FROM public.account_rights_exports AS exported JOIN public.account_rights_requests AS request
    ON request.id = exported.request_ref WHERE request.owner_id = caller) >= 8 THEN
    RAISE EXCEPTION 'Cached export capacity reached; release an existing cached export or request approved service release' USING ERRCODE = 'PT429';
  END IF;
  IF receipt.payload->>'scope' = 'account_server_personal_v2' THEN
    SELECT public.account_rights_collect_export_v2(caller) INTO records;
  ELSE
  IF coalesce((SELECT pg_catalog.octet_length(data::text) FROM public.accounts WHERE uid = caller::text), 0)
    + coalesce((SELECT pg_catalog.octet_length(data::text) FROM public.profiles WHERE uid = caller::text), 0) > 8388608 THEN
    RAISE EXCEPTION 'Account exceeds automatic export capacity; no partial archive produced' USING ERRCODE = 'PT413';
  END IF;
  state_shape := pg_catalog.jsonb_build_object('profile', profile_shape) || '{"updatedAt":"scalar","weightLog":[{"date":"scalar","kg":"scalar"}],"workoutLog":[{"date":"scalar","split":"scalar","volume":"scalar","finalizationRequestId":"scalar","exercises":[{"id":"scalar","name":"scalar","muscle":"scalar","sets":[{"reps":"scalar","weight":"scalar"}]}]}],"foodLog":[{"date":"scalar","items":[{"id":"scalar","text":"scalar","kcal":"scalar","protein":"scalar","carbs":"scalar","fat":"scalar","qty":"scalar","unit":"scalar"}]}],"restDays":["scalar"]}'::jsonb;
  SELECT pg_catalog.jsonb_build_object(
    'identity', (SELECT pg_catalog.jsonb_build_object('id', id, 'email', email, 'created_at', created_at) FROM auth.users WHERE id = caller),
    'account', (SELECT pg_catalog.jsonb_build_object('source_updated_at', updated_at, 'state', public.account_rights_project(data, state_shape)) FROM public.accounts WHERE uid = caller::text),
    'profile', (SELECT public.account_rights_project(data, profile_shape) FROM public.profiles WHERE uid = caller::text)) INTO records;
  END IF;
  INSERT INTO public.account_rights_actions(operation_id, request_ref, actor_role, actor_id, action, previous_version, from_status, to_status)
    VALUES (p_operation_id, p_id, 'authenticated', caller, 'export_ready', p_version, receipt.status, 'export_ready');
  UPDATE public.account_rights_requests SET status = 'export_ready', snapshot_status = 'available', version = version + 1, updated_at = generated WHERE id = p_id;
  IF receipt.payload->>'scope' = 'account_server_personal_v2' THEN
    archive_text := pg_catalog.jsonb_build_object('schema', 'formora.account-rights', 'schema_version', 2,
      'scope', 'account_server_personal_v2', 'request_ref', p_id, 'requester', caller, 'generated_at', generated,
      'coverage', pg_catalog.jsonb_build_object('all_personal_data', false, 'known_source_schemas_available', records->'known_source_schemas_available',
        'legacy_aliases', 'not_verified', 'ownership', 'canonical_auth_uid_only',
        'snapshot', 'single_sql_statement_before_preparation', 'media', 'public_url_references_only_no_bytes'),
      'provenance', pg_catalog.jsonb_build_object('ownership', 'canonical auth.uid() only; versioned source filters',
        'snapshot', 'bounded counts, byte preflight and all projected sources share one SQL statement snapshot; rights history precedes preparation commit',
        'availability', 'local catalog table and exact column type checks, not hosted policy or provider verification'),
      'projection', records->'projection', 'source_inventory', records->'source_inventory',
      'exclusions', ARRAY['unsynced device data, drafts, local-only preferences and photos',
        'media bytes, inline images, non-HTTPS URLs and URLs containing queries or fragments',
        'credentials, tokens, raw provider payloads, operator notes and other reporters or Story viewers',
        'missing or mismatched sources and fields outside the versioned projections',
        'unknown schemas, legacy aliases without verified ownership, external providers, backups and operational logs'],
      'data', records->'data')::text;
  ELSE
  SELECT pg_catalog.jsonb_build_object('requests', coalesce((SELECT pg_catalog.jsonb_agg(public.account_rights_receipt(request)
    ORDER BY request.created_at, request.id) FROM public.account_rights_requests AS request WHERE owner_id = caller), '[]'::jsonb),
    'actions', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('request_ref', action.request_ref,
      'action', action.action, 'version', action.previous_version + 1, 'from_status', action.from_status,
      'to_status', action.to_status, 'created_at', action.created_at) ORDER BY action.created_at, action.id)
      FROM public.account_rights_actions AS action JOIN public.account_rights_requests AS request ON request.id = action.request_ref
      WHERE request.owner_id = caller), '[]'::jsonb)) INTO history;
  archive_text := pg_catalog.jsonb_build_object('schema', 'formora.account-rights', 'schema_version', 1,
    'scope', 'account_profile_logs_v1', 'request_ref', p_id, 'requester', caller, 'generated_at', generated,
    'provenance', pg_catalog.jsonb_build_object('identity', 'auth.users allowlist; requester = auth.uid()',
      'account', 'public.accounts saved server copy; not unsynced device data', 'profile', 'public.profiles own row allowlist',
      'history', 'private account-rights receipts and redacted lifecycle actions', 'snapshot', 'immutable on preparation; source reads share one SQL statement snapshot'),
    'projection', pg_catalog.jsonb_build_object('identity', ARRAY['id','email','created_at'], 'account_state', state_shape, 'profile', profile_shape),
    'exclusions', ARRAY['unsynced device data and drafts', 'media bytes, media URLs and lookPhotos',
      'social graph, referral identities and social caches', 'posts, Stories, Story receipts, messages and notifications',
      'support/report prose, subjects, operator identities and evidence references', 'billing records, credentials and tokens',
      'unrecognized fields outside the versioned projection'], 'data', records, 'request_history', history)::text;
  END IF;
  archive_bytes := pg_catalog.octet_length(archive_text);
  IF archive_bytes > 8388608 THEN
    RAISE EXCEPTION 'Export exceeds capacity; no partial archive produced' USING ERRCODE = 'PT413';
  END IF;
  IF archive_bytes + coalesce((SELECT sum(exported.total_bytes)
    FROM public.account_rights_exports AS exported JOIN public.account_rights_requests AS request ON request.id = exported.request_ref
    WHERE request.owner_id = caller), 0) > 33554432 THEN
    RAISE EXCEPTION 'Cached export byte capacity reached; release an existing cached export or request approved service release' USING ERRCODE = 'PT429';
  END IF;
  INSERT INTO public.account_rights_exports(request_ref, archive_text, total_bytes, sha256, generated_at)
    VALUES (p_id, archive_text, archive_bytes, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(archive_text, 'UTF8')), 'hex'), generated);
  RETURN public.account_rights_export_info(p_id);
END;
$function$;

CREATE FUNCTION public.read_account_rights_export(p_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 32768)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
  receipt public.account_rights_requests%ROWTYPE;
  exported public.account_rights_exports%ROWTYPE;
  next_offset integer;
BEGIN
  IF p_id IS NULL OR p_offset IS NULL OR p_offset < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 32768 THEN
    RAISE EXCEPTION 'Invalid export cursor or size' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || caller::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = caller FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Export unavailable' USING ERRCODE = 'PT404'; END IF;
  IF receipt.kind <> 'export' OR receipt.status <> 'export_ready' THEN
    RAISE EXCEPTION 'Export not available for this request state' USING ERRCODE = 'PT409';
  END IF;
  PERFORM public.account_rights_require_clear_holds(caller);
  SELECT * INTO exported FROM public.account_rights_exports WHERE request_ref = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Export unavailable' USING ERRCODE = 'PT404'; END IF;
  IF p_offset > exported.total_bytes THEN RAISE EXCEPTION 'Invalid export cursor' USING ERRCODE = '22023'; END IF;
  next_offset := least(exported.total_bytes, p_offset + p_limit);
  RETURN public.account_rights_export_info(p_id) || pg_catalog.jsonb_build_object('offset', p_offset,
    'next_offset', next_offset, 'complete', next_offset = exported.total_bytes,
    'chunk_base64', pg_catalog.encode(pg_catalog.substr(pg_catalog.convert_to(exported.archive_text, 'UTF8'), p_offset + 1, next_offset - p_offset), 'base64'));
END;
$function$;

CREATE FUNCTION public.account_rights_require_service()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF NOT (pg_catalog.current_setting('role', true) = 'service_role'
    OR (pg_catalog.current_setting('role', true) = 'none' AND session_user = 'service_role')) THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.account_rights_release_cached_export(p_id uuid, p_owner_id uuid, p_version integer,
  p_operation_id uuid, p_actor_role text, p_actor_id uuid, p_approval_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  receipt public.account_rights_requests%ROWTYPE;
  prior public.account_rights_actions%ROWTYPE;
  audit jsonb;
  released_bytes integer;
  next_status text;
BEGIN
  IF p_id IS NULL OR p_owner_id IS NULL OR p_version IS NULL OR p_version < 1 OR p_operation_id IS NULL
    OR (p_actor_role = 'service_role' AND p_approval_ref IS NULL) THEN
    RAISE EXCEPTION 'Request, owner, version, operation and service approval reference required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || p_owner_id::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  audit := pg_catalog.jsonb_build_object('scope', 'cached_export_only', 'approval_ref', p_approval_ref);
  SELECT * INTO prior FROM public.account_rights_actions WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.request_ref <> p_id OR prior.actor_role <> p_actor_role OR prior.actor_id IS DISTINCT FROM p_actor_id
      OR prior.action <> 'release_export' OR prior.previous_version <> p_version OR prior.payload - 'released_bytes' <> audit THEN
      RAISE EXCEPTION 'Operation identifier conflict' USING ERRCODE = 'PT409';
    END IF;
    released_bytes := (prior.payload->>'released_bytes')::integer;
  ELSE
    IF receipt.version <> p_version OR receipt.kind <> 'export' OR receipt.snapshot_status <> 'available' THEN
      RAISE EXCEPTION 'Cached export changed or unavailable; refresh before releasing' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public.account_rights_require_clear_holds(p_owner_id);
    DELETE FROM public.account_rights_exports WHERE request_ref = p_id RETURNING total_bytes INTO released_bytes;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cached export unavailable' USING ERRCODE = 'PT409'; END IF;
    next_status := CASE WHEN receipt.status IN ('cancelled', 'superseded') THEN receipt.status ELSE 'export_released' END;
    INSERT INTO public.account_rights_actions(operation_id, request_ref, actor_role, actor_id, action, previous_version, payload, from_status, to_status)
      VALUES (p_operation_id, p_id, p_actor_role, p_actor_id, 'release_export', p_version,
        audit || pg_catalog.jsonb_build_object('released_bytes', released_bytes), receipt.status, next_status);
    UPDATE public.account_rights_requests SET status = next_status, snapshot_status = 'released', version = version + 1,
      updated_at = pg_catalog.clock_timestamp() WHERE id = p_id RETURNING * INTO receipt;
  END IF;
  RETURN pg_catalog.jsonb_build_object('schema_version', 1, 'operation_id', p_operation_id, 'operation_status', 'committed',
    'action', 'release_export', 'scope', 'cached_export_only', 'request_ref', p_id, 'requester', p_owner_id,
    'released_bytes', released_bytes, 'source_data_deleted', false, 'receipt', public.account_rights_receipt(receipt));
END;
$function$;

CREATE FUNCTION public.release_my_account_rights_export(p_id uuid, p_version integer, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := public.account_rights_owner();
BEGIN
  RETURN public.account_rights_release_cached_export(p_id, caller, p_version, p_operation_id, 'authenticated', caller, NULL);
END;
$function$;

CREATE FUNCTION public.release_account_rights_export(p_id uuid, p_owner_id uuid, p_version integer, p_operation_id uuid, p_approval_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  PERFORM public.account_rights_require_service();
  RETURN public.account_rights_release_cached_export(p_id, p_owner_id, p_version, p_operation_id, 'service_role', NULL, p_approval_ref);
END;
$function$;

CREATE FUNCTION public.account_rights_inventory(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  source jsonb;
  probe record;
  availability jsonb;
  relation oid;
  column_found boolean;
  owned_count integer;
  inventory jsonb := '[]'::jsonb;
BEGIN
  FOR source IN SELECT value FROM pg_catalog.jsonb_array_elements(public.account_rights_export_sources_v2()) LOOP
    availability := public.account_rights_source_status_v2(source->'columns');
    owned_count := NULL;
    IF (availability->>'available')::boolean THEN
      EXECUTE pg_catalog.format('SELECT count(*)::integer FROM (%s ORDER BY sort_key LIMIT 10001) AS owned', source->>'query')
        INTO owned_count USING p_owner_id;
    END IF;
    inventory := inventory || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'category', CASE source->>'id' WHEN 'identity' THEN 'auth' WHEN 'account' THEN 'account_and_logs' ELSE source->>'id' END,
      'source', source->>'source', 'source_version', source->'version', 'available', availability->'available', 'status', availability->'status',
      'matched_rows', CASE WHEN (availability->>'available')::boolean THEN least(owned_count, 10000) ELSE NULL END,
      'has_more', coalesce(owned_count > 10000, false), 'source_execution_allowed', false, 'deletion_authorized', false));
  END LOOP;
  FOR probe IN SELECT * FROM (VALUES
    ('media', 'storage', 'objects', 'owner_id', false),
    ('authored_messages', 'public', 'messages', 'from_uid', true),
    ('received_messages', 'public', 'messages', 'to_uid', true),
    ('subject_reports', 'public', 'report_cases', 'reported_uid', true)
  ) AS sources(category, schema_name, table_name, owner_column, shared_record) LOOP
    relation := pg_catalog.to_regclass(pg_catalog.format('%I.%I', probe.schema_name, probe.table_name));
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = relation
      AND attname = probe.owner_column AND attnum > 0 AND NOT attisdropped AND atttypid IN ('text'::regtype, 'uuid'::regtype)) INTO column_found;
    owned_count := NULL;
    IF column_found THEN
      EXECUTE pg_catalog.format('SELECT count(*)::integer FROM (SELECT 1 FROM %I.%I WHERE %I::text = $1 LIMIT 10001) AS owned',
        probe.schema_name, probe.table_name, probe.owner_column) INTO owned_count USING p_owner_id::text;
    END IF;
    inventory := inventory || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('category', probe.category,
      'source', probe.schema_name || '.' || probe.table_name, 'owner_column', probe.owner_column,
      'available', column_found, 'matched_rows', CASE WHEN column_found THEN least(owned_count, 10000) ELSE NULL END,
      'has_more', coalesce(owned_count > 10000, false),
      'shared_record', probe.shared_record, 'deletion_authorized', false, 'source_execution_allowed', false,
      'scope', 'count_only_ownership_and_policy_review_required'));
  END LOOP;
  RETURN inventory;
END;
$function$;

CREATE FUNCTION public.account_rights_report_holds(p_owner_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  held_count integer;
BEGIN
  IF pg_catalog.to_regclass('public.report_cases') IS NULL OR pg_catalog.to_regclass('public.report_evidence_holds') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT count(*)::integer FROM (SELECT 1 FROM public.report_evidence_holds AS held
    JOIN public.report_cases AS report ON report.id = held.case_id
    WHERE report.reporter = $1 OR report.reported_uid = $1::text LIMIT 10001) AS evidence'
    INTO held_count USING p_owner_id;
  RETURN held_count;
EXCEPTION WHEN undefined_table OR undefined_column THEN
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.review_account_rights_request(p_id uuid, p_owner_id uuid, p_version integer,
  p_action text, p_operation_id uuid, p_evidence_ref uuid, p_related_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  receipt public.account_rights_requests%ROWTYPE;
  related public.account_rights_requests%ROWTYPE;
  prior public.account_rights_actions%ROWTYPE;
  evidence jsonb;
  next_status text;
  terminal boolean;
BEGIN
  PERFORM public.account_rights_require_service();
  IF p_id IS NULL OR p_owner_id IS NULL OR p_version IS NULL OR p_version < 1 OR p_action IS NULL
    OR p_action NOT IN ('review', 'authorize', 'hold', 'release_hold', 'supersede')
    OR p_operation_id IS NULL OR p_evidence_ref IS NULL
    OR (p_action = 'supersede') <> (p_related_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid operator action or missing evidence reference' USING ERRCODE = '22023';
  END IF;
  evidence := pg_catalog.jsonb_build_object('evidence_ref', p_evidence_ref, 'related_id', p_related_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || p_owner_id::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  SELECT * INTO prior FROM public.account_rights_actions WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.request_ref <> p_id OR prior.actor_role <> 'service_role' OR prior.action <> p_action
      OR prior.previous_version <> p_version OR prior.payload <> evidence THEN
      RAISE EXCEPTION 'Operation identifier conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN public.account_rights_receipt(receipt);
  END IF;
  IF receipt.version <> p_version THEN RAISE EXCEPTION 'Request changed; refresh before review' USING ERRCODE = 'PT409'; END IF;
  terminal := receipt.status IN ('cancelled', 'superseded', 'export_released');
  IF terminal AND p_action NOT IN ('hold', 'release_hold') THEN
    RAISE EXCEPTION 'Request is no longer active' USING ERRCODE = 'PT409';
  END IF;
  IF p_action = 'hold' THEN
    IF (SELECT count(*) FROM public.account_rights_holds WHERE request_ref = p_id) >= 32
      AND NOT EXISTS (SELECT 1 FROM public.account_rights_holds WHERE request_ref = p_id AND hold_ref = p_evidence_ref) THEN
      RAISE EXCEPTION 'Evidence hold capacity reached' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.account_rights_holds(request_ref, hold_ref) VALUES (p_id, p_evidence_ref) ON CONFLICT DO NOTHING;
    next_status := CASE WHEN terminal THEN receipt.status ELSE 'held' END;
  ELSIF p_action = 'release_hold' THEN
    DELETE FROM public.account_rights_holds WHERE request_ref = p_id AND hold_ref = p_evidence_ref;
    IF NOT FOUND THEN RAISE EXCEPTION 'Hold reference unavailable' USING ERRCODE = 'PT409'; END IF;
    next_status := receipt.status;
    IF receipt.status = 'held' AND NOT EXISTS (SELECT 1 FROM public.account_rights_holds WHERE request_ref = p_id) THEN
      next_status := CASE WHEN EXISTS (SELECT 1 FROM public.account_rights_exports WHERE request_ref = p_id) THEN 'export_ready' ELSE 'under_review' END;
    END IF;
  ELSIF p_action = 'review' AND receipt.status IN ('received', 'authorized') THEN
    next_status := 'under_review';
  ELSIF p_action = 'authorize' AND receipt.kind = 'erasure' AND receipt.status = 'under_review' THEN
    PERFORM public.account_rights_require_clear_holds(p_owner_id);
    next_status := 'authorized';
  ELSIF p_action = 'supersede' THEN
    SELECT * INTO related FROM public.account_rights_requests WHERE id = p_related_id AND owner_id = p_owner_id FOR UPDATE;
    IF NOT FOUND OR p_related_id = p_id OR related.kind <> receipt.kind OR related.status IN ('cancelled', 'superseded', 'export_released') THEN
      RAISE EXCEPTION 'Replacement must be an active same-owner request of the same kind' USING ERRCODE = 'PT409';
    END IF;
    PERFORM public.account_rights_require_clear_holds(p_owner_id);
    DELETE FROM public.account_rights_exports WHERE request_ref = p_id;
    next_status := 'superseded';
  ELSE
    RAISE EXCEPTION 'Invalid account-rights transition' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.account_rights_actions(operation_id, request_ref, actor_role, action, previous_version, payload, from_status, to_status)
    VALUES (p_operation_id, p_id, 'service_role', p_action, p_version, evidence, receipt.status, next_status);
  UPDATE public.account_rights_requests SET status = next_status, version = version + 1,
    snapshot_status = CASE WHEN p_action = 'supersede' AND snapshot_status = 'available' THEN 'released' ELSE snapshot_status END,
    updated_at = pg_catalog.clock_timestamp() WHERE id = p_id RETURNING * INTO receipt;
  RETURN public.account_rights_receipt(receipt);
END;
$function$;

CREATE FUNCTION public.preview_account_rights_erasure(p_id uuid, p_owner_id uuid, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  receipt public.account_rights_requests%ROWTYPE;
  prior public.account_rights_previews%ROWTYPE;
  preview jsonb;
  held_count integer;
BEGIN
  PERFORM public.account_rights_require_service();
  IF p_id IS NULL OR p_owner_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Request, owner proof and operation identifier required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-rights:' || p_owner_id::text, 0));
  SELECT * INTO receipt FROM public.account_rights_requests WHERE id = p_id AND owner_id = p_owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404'; END IF;
  IF receipt.kind <> 'erasure' THEN RAISE EXCEPTION 'Erasure request required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO prior FROM public.account_rights_previews WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.request_ref <> p_id THEN RAISE EXCEPTION 'Preview identifier conflict' USING ERRCODE = 'PT409'; END IF;
    RETURN prior.preview;
  END IF;
  IF (SELECT count(*) FROM public.account_rights_previews WHERE request_ref = p_id) >= 100 THEN
    RAISE EXCEPTION 'Preview audit capacity reached' USING ERRCODE = 'PT429';
  END IF;
  SELECT count(*) INTO held_count FROM public.account_rights_holds AS held
    JOIN public.account_rights_requests AS request ON request.id = held.request_ref WHERE request.owner_id = p_owner_id;
  preview := pg_catalog.jsonb_build_object('schema_version', 1, 'dry_run', true, 'operation_id', p_operation_id,
    'request_ref', p_id, 'requester', p_owner_id, 'observed_request_version', receipt.version,
    'observed_status', receipt.status, 'generated_at', pg_catalog.clock_timestamp(),
    'owner_proof', 'request owner was derived from auth.uid(); operator supplied expected owner matches',
    'authorization_scope', 'preparation_only', 'preparation_authorized_at_preview', receipt.status = 'authorized'
      AND public.account_rights_hold_state(p_owner_id)->>'hold_status' = 'clear',
    'execution_allowed', false, 'execution_blocker', 'approved_policy_specific_erasure_executor_not_implemented',
    'active_request_holds', held_count, 'report_evidence_holds', public.account_rights_report_holds(p_owner_id),
    'inventory', public.account_rights_inventory(p_owner_id), 'legacy_aliases', 'not included without separately verified ownership',
    'required_before_execution', ARRAY['approved retention, evidence holds and shared-thread tombstone policy',
      'explicit accountable operator and exact production erasure authorization', 'fresh identity verification and active request version',
      'verified backup and recovery procedure', 'complete source inventory including unavailable or differently named tables and storage ownership',
      'preserve paid entitlements, receipts, INR 1 and NULL-expiry/founding/coaching obligations as required',
      'separately implemented service-only executor with interruption, replay and post-operation verification']);
  INSERT INTO public.account_rights_previews(operation_id, request_ref, preview) VALUES (p_operation_id, p_id, preview);
  RETURN preview;
END;
$function$;

CREATE FUNCTION public.account_rights_operator_queue(p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  items jsonb;
  has_more boolean;
BEGIN
  PERFORM public.account_rights_require_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_before IS NULL) <> (p_before_id IS NULL)
    OR (p_before IS NOT NULL AND NOT pg_catalog.isfinite(p_before)) THEN
    RAISE EXCEPTION 'Invalid queue cursor or limit' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(public.account_rights_receipt(receipt) ORDER BY receipt.created_at DESC, receipt.id DESC), '[]'::jsonb)
    INTO items FROM (SELECT * FROM public.account_rights_requests
      WHERE p_before IS NULL OR (created_at, id) < (p_before, p_before_id)
      ORDER BY created_at DESC, id DESC LIMIT p_limit + 1) AS receipt;
  has_more := pg_catalog.jsonb_array_length(items) > p_limit;
  IF has_more THEN items := items - p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object('items', items, 'has_more', has_more,
    'next_cursor', CASE WHEN has_more THEN pg_catalog.jsonb_build_object('created_at', items->-1->>'created_at', 'id', items->-1->>'id') ELSE NULL END);
END;
$function$;

CREATE FUNCTION public.account_rights_operator_history(p_id uuid, p_owner_id uuid, p_before_version integer DEFAULT NULL, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  items jsonb;
  has_more boolean;
BEGIN
  PERFORM public.account_rights_require_service();
  IF p_id IS NULL OR p_owner_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_before_version < 1 THEN
    RAISE EXCEPTION 'Invalid history request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_rights_requests WHERE id = p_id AND owner_id = p_owner_id) THEN
    RAISE EXCEPTION 'Request unavailable' USING ERRCODE = 'PT404';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(history_row) ORDER BY history_row.previous_version DESC), '[]'::jsonb)
    INTO items FROM (SELECT * FROM public.account_rights_actions WHERE request_ref = p_id
      AND (p_before_version IS NULL OR previous_version + 1 < p_before_version)
      ORDER BY previous_version DESC LIMIT p_limit + 1) AS history_row;
  has_more := pg_catalog.jsonb_array_length(items) > p_limit;
  IF has_more THEN items := items - p_limit; END IF;
  RETURN pg_catalog.jsonb_build_object('request_ref', p_id, 'requester', p_owner_id, 'items', items, 'has_more', has_more,
    'next_before_version', CASE WHEN has_more THEN (items->-1->>'previous_version')::integer + 1 ELSE NULL END);
END;
$function$;

REVOKE ALL ON FUNCTION public.account_rights_owner(), public.account_rights_receipt(public.account_rights_requests),
  public.submit_account_rights_request(uuid,text,jsonb), public.my_account_rights_request(uuid),
  public.my_account_rights_requests(timestamptz,uuid,integer), public.cancel_account_rights_request(uuid,integer,uuid),
  public.account_rights_recent_auth(), public.my_account_rights_history(uuid,integer,integer),
  public.account_rights_project(jsonb,jsonb), public.account_rights_export_info(uuid),
  public.account_rights_project_v2(jsonb,jsonb), public.account_rights_export_sources_v2(),
  public.account_rights_source_status_v2(jsonb), public.account_rights_export_guard_v2(integer,bigint), public.account_rights_collect_export_v2(uuid),
  public.account_rights_hold_state(uuid), public.account_rights_require_clear_holds(uuid),
  public.account_rights_release_cached_export(uuid,uuid,integer,uuid,text,uuid,uuid), public.release_my_account_rights_export(uuid,integer,uuid),
  public.prepare_account_rights_export(uuid,integer,uuid), public.read_account_rights_export(uuid,integer,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_account_rights_request(uuid,text,jsonb), public.my_account_rights_request(uuid),
  public.my_account_rights_requests(timestamptz,uuid,integer), public.cancel_account_rights_request(uuid,integer,uuid),
  public.my_account_rights_history(uuid,integer,integer), public.prepare_account_rights_export(uuid,integer,uuid),
  public.read_account_rights_export(uuid,integer,integer), public.release_my_account_rights_export(uuid,integer,uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.account_rights_require_service(), public.account_rights_inventory(uuid), public.account_rights_report_holds(uuid),
  public.review_account_rights_request(uuid,uuid,integer,text,uuid,uuid,uuid), public.preview_account_rights_erasure(uuid,uuid,uuid),
  public.account_rights_operator_queue(timestamptz,uuid,integer), public.account_rights_operator_history(uuid,uuid,integer,integer),
  public.release_account_rights_export(uuid,uuid,integer,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_account_rights_request(uuid,uuid,integer,text,uuid,uuid,uuid),
  public.preview_account_rights_erasure(uuid,uuid,uuid), public.account_rights_operator_queue(timestamptz,uuid,integer),
  public.account_rights_operator_history(uuid,uuid,integer,integer), public.release_account_rights_export(uuid,uuid,integer,uuid,uuid) TO service_role;

CREATE TABLE IF NOT EXISTS public.account_rights_report_hold_epochs (
  owner_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0)
);
ALTER TABLE public.account_rights_report_hold_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_rights_report_hold_epochs FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.account_rights_report_hold_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  affected_owners text[] := '{}'::text[];
  mapped record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Report hold history requires individual row transitions' USING ERRCODE = 'PT409';
  END IF;
  IF TG_RELID = pg_catalog.to_regclass('public.report_evidence_holds') THEN
    IF TG_OP = 'UPDATE' AND (OLD.case_id, OLD.hold_ref) IS NOT DISTINCT FROM (NEW.case_id, NEW.hold_ref) THEN
      RETURN NEW;
    END IF;
    IF TG_OP <> 'INSERT' THEN
      SELECT report.reporter::text AS reporter, report.reported_uid INTO mapped
        FROM public.report_cases AS report WHERE report.id = OLD.case_id FOR SHARE;
      IF NOT FOUND OR mapped.reporter IS NULL THEN
        RAISE EXCEPTION 'Unknown report hold owner mapping' USING ERRCODE = 'PT409';
      END IF;
      affected_owners := affected_owners || ARRAY[mapped.reporter, mapped.reported_uid];
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT report.reporter::text AS reporter, report.reported_uid INTO mapped
        FROM public.report_cases AS report WHERE report.id = NEW.case_id FOR SHARE;
      IF NOT FOUND OR mapped.reporter IS NULL THEN
        RAISE EXCEPTION 'Unknown report hold owner mapping' USING ERRCODE = 'PT409';
      END IF;
      affected_owners := affected_owners || ARRAY[mapped.reporter, mapped.reported_uid];
    END IF;
  ELSIF TG_RELID = pg_catalog.to_regclass('public.report_cases') THEN
    IF TG_OP = 'UPDATE' AND (OLD.id, OLD.reporter, OLD.reported_uid) IS NOT DISTINCT FROM (NEW.id, NEW.reporter, NEW.reported_uid) THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.report_evidence_holds WHERE case_id = OLD.id) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF OLD.reporter IS NULL OR (TG_OP = 'UPDATE' AND NEW.reporter IS NULL) THEN
      RAISE EXCEPTION 'Unknown report hold owner mapping' USING ERRCODE = 'PT409';
    END IF;
    affected_owners := ARRAY[OLD.reporter::text, OLD.reported_uid];
    IF TG_OP = 'UPDATE' THEN
      affected_owners := affected_owners || ARRAY[NEW.reporter::text, NEW.reported_uid];
    END IF;
  ELSE
    RAISE EXCEPTION 'Unexpected report hold history trigger source' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.account_rights_report_hold_epochs(owner_id, version)
    SELECT DISTINCT owner_key, 1 FROM pg_catalog.unnest(affected_owners) AS owners(owner_key)
      WHERE owner_key IS NOT NULL ORDER BY owner_key
    ON CONFLICT (owner_id) DO UPDATE SET version = public.account_rights_report_hold_epochs.version + 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.account_rights_report_hold_history_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.report_cases', 'id', 'uuid'::regtype),
      ('public.report_cases', 'reporter', 'uuid'::regtype),
      ('public.report_cases', 'reported_uid', 'text'::regtype),
      ('public.report_evidence_holds', 'case_id', 'uuid'::regtype),
      ('public.report_evidence_holds', 'hold_ref', 'uuid'::regtype),
      ('public.account_rights_report_hold_epochs', 'owner_id', 'text'::regtype),
      ('public.account_rights_report_hold_epochs', 'version', 'bigint'::regtype)
    ) AS expected(relation_name, column_name, column_type)
    LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = pg_catalog.to_regclass(expected.relation_name) AND relation.relkind = 'r'
    LEFT JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
      AND attribute.attname = expected.column_name AND attribute.atttypid = expected.column_type
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attrelid IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('public.report_evidence_holds', 'account_rights_report_hold_transition', 29),
      ('public.report_cases', 'account_rights_report_hold_mapping', 27),
      ('public.report_evidence_holds', 'account_rights_report_hold_truncate', 34),
      ('public.report_cases', 'account_rights_report_case_truncate', 34)
    ) AS expected(relation_name, trigger_name, trigger_type)
    LEFT JOIN pg_catalog.pg_trigger AS guard ON guard.tgrelid = pg_catalog.to_regclass(expected.relation_name)
      AND guard.tgname = expected.trigger_name AND guard.tgtype = expected.trigger_type
      AND guard.tgfoid = pg_catalog.to_regprocedure('public.account_rights_report_hold_transition()')
      AND guard.tgenabled IN ('O', 'A') AND NOT guard.tgisinternal AND guard.tgqual IS NULL AND guard.tgnargs = 0
    WHERE guard.oid IS NULL
  );
$function$;

CREATE OR REPLACE FUNCTION public.account_rights_install_report_hold_history()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('public.report_cases') AND relkind = 'r')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = pg_catalog.to_regclass('public.report_evidence_holds') AND relkind = 'r') THEN
    RETURN;
  END IF;
  LOCK TABLE public.report_cases, public.report_evidence_holds IN SHARE ROW EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS account_rights_report_hold_transition ON public.report_evidence_holds;
  CREATE TRIGGER account_rights_report_hold_transition AFTER INSERT OR UPDATE OR DELETE ON public.report_evidence_holds
    FOR EACH ROW EXECUTE FUNCTION public.account_rights_report_hold_transition();
  DROP TRIGGER IF EXISTS account_rights_report_hold_mapping ON public.report_cases;
  CREATE TRIGGER account_rights_report_hold_mapping BEFORE UPDATE OR DELETE ON public.report_cases
    FOR EACH ROW EXECUTE FUNCTION public.account_rights_report_hold_transition();
  DROP TRIGGER IF EXISTS account_rights_report_hold_truncate ON public.report_evidence_holds;
  CREATE TRIGGER account_rights_report_hold_truncate BEFORE TRUNCATE ON public.report_evidence_holds
    FOR EACH STATEMENT EXECUTE FUNCTION public.account_rights_report_hold_transition();
  DROP TRIGGER IF EXISTS account_rights_report_case_truncate ON public.report_cases;
  CREATE TRIGGER account_rights_report_case_truncate BEFORE TRUNCATE ON public.report_cases
    FOR EACH STATEMENT EXECUTE FUNCTION public.account_rights_report_hold_transition();
END;
$function$;

CREATE OR REPLACE FUNCTION public.account_rights_hold_state(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  request_holds integer;
  report_holds integer;
  hold_version bigint;
  report_hold_version bigint;
BEGIN
  SELECT count(*)::integer INTO request_holds FROM public.account_rights_holds AS held
    JOIN public.account_rights_requests AS request ON request.id = held.request_ref WHERE request.owner_id = p_owner_id;
  SELECT count(*) INTO hold_version FROM public.account_rights_actions AS action
    JOIN public.account_rights_requests AS request ON request.id = action.request_ref
    WHERE request.owner_id = p_owner_id AND action.action IN ('hold', 'release_hold');
  IF p_owner_id IS NOT NULL AND public.account_rights_report_hold_history_ready() THEN
    report_holds := public.account_rights_report_holds(p_owner_id);
    SELECT coalesce((SELECT version FROM public.account_rights_report_hold_epochs WHERE owner_id = p_owner_id::text), 0)
      INTO report_hold_version;
  END IF;
  RETURN pg_catalog.jsonb_build_object('hold_status', CASE WHEN request_holds > 0 OR report_holds > 0 THEN 'held'
    WHEN report_holds IS NULL THEN 'unknown' ELSE 'clear' END, 'hold_version', hold_version,
    'report_hold_version', report_hold_version);
END;
$function$;

REVOKE ALL ON FUNCTION public.account_rights_report_hold_transition(), public.account_rights_report_hold_history_ready(),
  public.account_rights_install_report_hold_history(), public.account_rights_hold_state(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $account_rights_report_hold_install$
BEGIN
  PERFORM public.account_rights_install_report_hold_history();
END;
$account_rights_report_hold_install$;

DO $permissions$
DECLARE
  entry record;
  checked_role text;
  allowed boolean;
BEGIN
  FOR entry IN SELECT oid, proname, proowner, proacl FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%account_rights%' LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(entry.proacl, pg_catalog.acldefault('f', entry.proowner)))
      WHERE grantee = 0 AND privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC account-rights function privilege' USING ERRCODE = '42501';
    END IF;
    FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      allowed := (checked_role = 'authenticated' AND entry.proname IN ('submit_account_rights_request', 'my_account_rights_request',
        'my_account_rights_requests', 'cancel_account_rights_request', 'my_account_rights_history', 'prepare_account_rights_export', 'read_account_rights_export', 'release_my_account_rights_export'))
        OR (checked_role = 'service_role' AND entry.proname IN ('review_account_rights_request', 'preview_account_rights_erasure',
          'account_rights_operator_queue', 'account_rights_operator_history', 'release_account_rights_export'));
      IF pg_catalog.has_function_privilege(checked_role, entry.oid, 'EXECUTE') <> allowed THEN
        RAISE EXCEPTION 'Unexpected effective account-rights function privilege (including inheritance): % %', checked_role, entry.proname USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  FOR entry IN SELECT oid, relname FROM pg_catalog.pg_class
    WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'account_rights_%' AND relkind = 'r' LOOP
    FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF pg_catalog.has_table_privilege(checked_role, entry.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(checked_role, entry.oid, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'Unexpected effective account-rights table privilege (including inheritance): % %', checked_role, entry.relname USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
END;
$permissions$;

NOTIFY pgrst, 'reload schema';
COMMIT;