BEGIN;

-- T-110 support receipts. Additive and private: a member-owned support case with a durable
-- reference, an owner-only thread and a versioned staff workflow. Nothing here reads, changes
-- or migrates the legacy public.support_tickets table, whose real DDL is unknown to this file.
-- Intake is disabled until an authorized service operator records an approval reference, so
-- applying this migration alone collects nothing and publishes no response-time claim.

CREATE TABLE public.support_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  collection_enabled boolean NOT NULL DEFAULT false,
  response_expectation text CHECK (response_expectation IS NULL OR length(trim(response_expectation)) BETWEEN 1 AND 200),
  contact_channel text CHECK (contact_channel IS NULL OR length(trim(contact_channel)) BETWEEN 1 AND 200),
  retention_approved boolean NOT NULL DEFAULT false,
  retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  erasure_approved boolean NOT NULL DEFAULT false,
  policy_ref uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT support_policy_collection_ref CHECK (NOT collection_enabled OR policy_ref IS NOT NULL),
  CONSTRAINT support_policy_claim_ref CHECK ((response_expectation IS NULL AND contact_channel IS NULL) OR policy_ref IS NOT NULL),
  CONSTRAINT support_policy_retention CHECK (retention_approved = (retention_days IS NOT NULL)),
  CONSTRAINT support_policy_retention_ref CHECK (NOT retention_approved OR policy_ref IS NOT NULL),
  CONSTRAINT support_policy_erasure_ref CHECK (NOT erasure_approved OR policy_ref IS NOT NULL)
);
INSERT INTO public.support_policy DEFAULT VALUES;

CREATE TABLE public.support_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_cases_per_day integer NOT NULL DEFAULT 10 CHECK (owner_cases_per_day BETWEEN 1 AND 100),
  owner_messages_per_minute integer NOT NULL DEFAULT 5 CHECK (owner_messages_per_minute BETWEEN 1 AND 60),
  owner_messages_per_day integer NOT NULL DEFAULT 50 CHECK (owner_messages_per_day BETWEEN 1 AND 500),
  case_messages_total integer NOT NULL DEFAULT 100 CHECK (case_messages_total BETWEEN 1 AND 200),
  staff_actions_per_minute integer NOT NULL DEFAULT 60 CHECK (staff_actions_per_minute BETWEEN 1 AND 600)
);
INSERT INTO public.support_limits DEFAULT VALUES;

-- Staff membership is provisioned by an authorized service operator only. No RPC grants,
-- revokes or audits membership here, so no completeness of membership auditing is claimed.
CREATE TABLE public.support_staff (
  uid uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE public.support_cases (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner uuid NOT NULL,
  request_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  payload_digest text NOT NULL CHECK (length(payload_digest) = 32),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count BETWEEN 0 AND 200),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (owner, request_id)
);
CREATE INDEX support_cases_owner_date ON public.support_cases (owner, created_at DESC, id DESC);
CREATE INDEX support_cases_status_date ON public.support_cases (status, created_at DESC, id DESC);

CREATE TABLE public.support_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.support_cases(id),
  author uuid NOT NULL,
  author_role text NOT NULL CHECK (author_role IN ('member', 'staff')),
  visibility text NOT NULL CHECK (visibility IN ('thread', 'internal')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  evidence text[] CHECK (evidence IS NULL OR (pg_catalog.array_length(evidence, 1) BETWEEN 1 AND 5
    AND length(pg_catalog.array_to_string(evidence, '|')) BETWEEN 1 AND 600)),
  request_id uuid NOT NULL,
  case_version integer NOT NULL CHECK (case_version > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (author, request_id, visibility),
  CONSTRAINT support_messages_internal_is_staff CHECK (visibility = 'thread' OR author_role = 'staff'),
  CONSTRAINT support_messages_evidence_is_member CHECK (evidence IS NULL OR author_role = 'member')
);
CREATE INDEX support_messages_case_date ON public.support_messages (case_id, created_at, id);

CREATE TABLE public.support_case_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.support_cases(id),
  actor uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('member', 'staff')),
  request_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (length(payload_digest) = 32),
  from_status text NOT NULL,
  to_status text NOT NULL,
  previous_version integer NOT NULL CHECK (previous_version > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (actor, request_id),
  UNIQUE (case_id, previous_version)
);

ALTER TABLE public.support_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_case_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_policy, public.support_limits, public.support_staff,
  public.support_cases, public.support_messages, public.support_case_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.support_policy, public.support_limits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_staff TO service_role;
GRANT SELECT ON public.support_cases, public.support_messages, public.support_case_actions TO service_role;

CREATE FUNCTION public.can_staff_support()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.support_staff WHERE uid = auth.uid() AND enabled);
$function$;

-- Only approved, operator-recorded values are ever published. Nulls mean "not published";
-- the client must not substitute a response time or a staffed contact of its own.
CREATE FUNCTION public.support_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  RETURN (SELECT pg_catalog.jsonb_build_object(
    'collection_enabled', policy.collection_enabled,
    'response_expectation', policy.response_expectation,
    'contact_channel', policy.contact_channel,
    'staff', public.can_staff_support()) FROM public.support_policy AS policy WHERE policy.singleton);
END;
$function$;

CREATE FUNCTION public.support_intake_guard()
RETURNS public.support_limits LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE limits public.support_limits%ROWTYPE; open_now boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  SELECT collection_enabled INTO open_now FROM public.support_policy WHERE singleton;
  IF open_now IS NOT TRUE THEN RAISE EXCEPTION 'Support requests are not being accepted' USING ERRCODE = 'PT503'; END IF;
  SELECT * INTO limits FROM public.support_limits WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'Support service unavailable' USING ERRCODE = 'PT503'; END IF;
  RETURN limits;
END;
$function$;

CREATE FUNCTION public.support_clean_evidence(p_evidence text[])
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE cleaned text[];
BEGIN
  IF p_evidence IS NULL THEN RETURN NULL; END IF;
  IF pg_catalog.array_length(p_evidence, 1) IS NULL OR pg_catalog.array_length(p_evidence, 1) > 5
    OR pg_catalog.array_ndims(p_evidence) <> 1
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_evidence) AS item WHERE item IS NULL OR length(trim(item)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Evidence references are not valid' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(trim(item) ORDER BY ordinality) INTO cleaned
    FROM pg_catalog.unnest(p_evidence) WITH ORDINALITY AS entry(item, ordinality);
  RETURN cleaned;
END;
$function$;

CREATE FUNCTION public.support_digest(VARIADIC p_parts text[])
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT pg_catalog.md5(pg_catalog.array_to_string(p_parts, pg_catalog.chr(31)));
$function$;

-- One transaction writes the case and its first message; the receipt is returned only after
-- that write commits. Replaying the same request id returns the same reference; replaying it
-- with a different payload is a conflict rather than a silent second case.
CREATE FUNCTION public.submit_support_case(p_request_id uuid, p_subject text, p_body text, p_evidence text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  limits public.support_limits%ROWTYPE;
  existing public.support_cases%ROWTYPE;
  cleaned text[];
  digest text;
BEGIN
  limits := public.support_intake_guard();
  IF p_request_id IS NULL OR p_subject IS NULL OR p_body IS NULL
    OR length(trim(p_subject)) NOT BETWEEN 1 AND 120 OR length(trim(p_body)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'A subject and message are required' USING ERRCODE = '22023';
  END IF;
  cleaned := public.support_clean_evidence(p_evidence);
  digest := public.support_digest(trim(p_subject), trim(p_body), coalesce(pg_catalog.array_to_string(cleaned, pg_catalog.chr(30)), ''));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('support:' || caller::text, 0));
  IF EXISTS (SELECT 1 FROM public.support_case_actions WHERE actor = caller AND request_id = p_request_id) THEN
    RAISE EXCEPTION 'Request id already used for a different request' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO existing FROM public.support_cases WHERE owner = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF existing.payload_digest <> digest THEN
      RAISE EXCEPTION 'Request id already used for a different request' USING ERRCODE = 'PT409';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', existing.id, 'request_id', existing.request_id, 'status', existing.status,
      'version', existing.version, 'created_at', existing.created_at, 'updated_at', existing.updated_at, 'duplicate', true);
  END IF;
  IF (SELECT count(*) FROM public.support_cases WHERE owner = caller
    AND created_at > pg_catalog.clock_timestamp() - interval '1 day') >= limits.owner_cases_per_day THEN
    RAISE EXCEPTION 'Support request limit reached; try later' USING ERRCODE = 'PT429';
  END IF;
  INSERT INTO public.support_cases(owner, request_id, subject, payload_digest, message_count)
    VALUES (caller, p_request_id, trim(p_subject), digest, 1) RETURNING * INTO existing;
  INSERT INTO public.support_messages(case_id, author, author_role, visibility, body, evidence, request_id, case_version)
    VALUES (existing.id, caller, 'member', 'thread', trim(p_body), cleaned, p_request_id, existing.version);
  RETURN pg_catalog.jsonb_build_object('id', existing.id, 'request_id', existing.request_id, 'status', existing.status,
    'version', existing.version, 'created_at', existing.created_at, 'updated_at', existing.updated_at, 'duplicate', false);
END;
$function$;

CREATE FUNCTION public.my_support_cases(p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', row.id, 'subject', row.subject,
    'status', row.status, 'version', row.version, 'message_count', row.message_count,
    'created_at', row.created_at, 'updated_at', row.updated_at) ORDER BY row.created_at DESC, row.id DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.support_cases WHERE owner = auth.uid()
      AND (p_before IS NULL OR (created_at, id) < (p_before, p_before_id))
      ORDER BY created_at DESC, id DESC LIMIT 50) AS row);
END;
$function$;

-- Members read their own thread only. Internal notes are never selected for a member, and a
-- case that is not theirs is reported as unavailable rather than as forbidden.
CREATE FUNCTION public.support_thread(p_case_id uuid, p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  staff boolean;
  current_case public.support_cases%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF p_case_id IS NULL OR (p_before IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  staff := public.can_staff_support();
  SELECT * INTO current_case FROM public.support_cases WHERE id = p_case_id;
  IF NOT FOUND OR (current_case.owner <> caller AND NOT staff) THEN
    RAISE EXCEPTION 'Support request unavailable' USING ERRCODE = 'PT404';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'case', pg_catalog.jsonb_build_object('id', current_case.id, 'subject', current_case.subject, 'status', current_case.status,
      'version', current_case.version, 'message_count', current_case.message_count,
      'created_at', current_case.created_at, 'updated_at', current_case.updated_at,
      'owner', CASE WHEN staff THEN pg_catalog.to_jsonb(current_case.owner) ELSE 'null'::jsonb END),
    'messages', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', row.id, 'author_role', row.author_role,
      'visibility', row.visibility, 'body', row.body, 'evidence', coalesce(pg_catalog.to_jsonb(row.evidence), '[]'::jsonb),
      'created_at', row.created_at, 'author', CASE WHEN staff THEN pg_catalog.to_jsonb(row.author) ELSE 'null'::jsonb END)
      ORDER BY row.created_at, row.id), '[]'::jsonb)
      FROM (SELECT * FROM public.support_messages WHERE case_id = p_case_id AND (staff OR visibility = 'thread')
        AND (p_before IS NULL OR (created_at, id) > (p_before, p_before_id))
        ORDER BY created_at, id LIMIT 50) AS row));
END;
$function$;

-- A member reply on a case that is waiting for the customer moves it back to in progress.
-- That is the only automatic transition; a closed case needs a new request.
CREATE FUNCTION public.add_support_reply(p_case_id uuid, p_request_id uuid, p_body text, p_evidence text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  limits public.support_limits%ROWTYPE;
  prior public.support_case_actions%ROWTYPE;
  current_case public.support_cases%ROWTYPE;
  cleaned text[];
  digest text;
  next_status text;
BEGIN
  limits := public.support_intake_guard();
  IF p_case_id IS NULL OR p_request_id IS NULL OR p_body IS NULL OR length(trim(p_body)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'A message is required' USING ERRCODE = '22023';
  END IF;
  cleaned := public.support_clean_evidence(p_evidence);
  digest := public.support_digest(p_case_id::text, trim(p_body), coalesce(pg_catalog.array_to_string(cleaned, pg_catalog.chr(30)), ''));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('support:' || caller::text, 0));
  IF EXISTS (SELECT 1 FROM public.support_cases WHERE owner = caller AND request_id = p_request_id) THEN
    RAISE EXCEPTION 'Request id already used for a different request' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO prior FROM public.support_case_actions WHERE actor = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.payload_digest <> digest OR prior.case_id <> p_case_id THEN
      RAISE EXCEPTION 'Request id already used for a different message' USING ERRCODE = 'PT409';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', prior.case_id, 'status', prior.to_status,
      'version', prior.previous_version + 1, 'duplicate', true);
  END IF;
  SELECT * INTO current_case FROM public.support_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND OR current_case.owner <> caller THEN RAISE EXCEPTION 'Support request unavailable' USING ERRCODE = 'PT404'; END IF;
  IF current_case.status = 'closed' THEN
    RAISE EXCEPTION 'This request is closed; send a new request' USING ERRCODE = 'PT409';
  END IF;
  IF (SELECT count(*) FROM public.support_messages WHERE author = caller
      AND created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= limits.owner_messages_per_minute
    OR (SELECT count(*) FROM public.support_messages WHERE author = caller
      AND created_at > pg_catalog.clock_timestamp() - interval '1 day') >= limits.owner_messages_per_day
    OR current_case.message_count >= limits.case_messages_total THEN
    RAISE EXCEPTION 'Message limit reached; try later' USING ERRCODE = 'PT429';
  END IF;
  next_status := CASE WHEN current_case.status = 'waiting_customer' THEN 'in_progress' ELSE current_case.status END;
  INSERT INTO public.support_messages(case_id, author, author_role, visibility, body, evidence, request_id, case_version)
    VALUES (p_case_id, caller, 'member', 'thread', trim(p_body), cleaned, p_request_id, current_case.version);
  INSERT INTO public.support_case_actions(case_id, actor, actor_role, request_id, payload_digest, from_status, to_status, previous_version)
    VALUES (p_case_id, caller, 'member', p_request_id, digest, current_case.status, next_status, current_case.version);
  UPDATE public.support_cases SET status = next_status, version = version + 1, message_count = message_count + 1,
    updated_at = pg_catalog.clock_timestamp() WHERE id = p_case_id;
  RETURN pg_catalog.jsonb_build_object('id', p_case_id, 'status', next_status,
    'version', current_case.version + 1, 'duplicate', false);
END;
$function$;

CREATE FUNCTION public.support_queue(p_status text DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.can_staff_support() THEN RAISE EXCEPTION 'Support staff access required' USING ERRCODE = 'PT403'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', row.id, 'owner', row.owner, 'subject', row.subject,
    'status', row.status, 'version', row.version, 'message_count', row.message_count,
    'created_at', row.created_at, 'updated_at', row.updated_at) ORDER BY row.created_at DESC, row.id DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.support_cases WHERE (p_status IS NULL OR status = p_status)
      AND (p_before IS NULL OR (created_at, id) < (p_before, p_before_id))
      ORDER BY created_at DESC, id DESC LIMIT 50) AS row);
END;
$function$;

CREATE FUNCTION public.support_case_history(p_case_id uuid, p_before_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.can_staff_support() THEN RAISE EXCEPTION 'Support staff access required' USING ERRCODE = 'PT403'; END IF;
  IF p_case_id IS NULL OR p_before_version < 1 THEN RAISE EXCEPTION 'Invalid history cursor' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.support_cases WHERE id = p_case_id) THEN
    RAISE EXCEPTION 'Support request unavailable' USING ERRCODE = 'PT404';
  END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', row.id, 'actor', row.actor,
    'actor_role', row.actor_role, 'from_status', row.from_status, 'to_status', row.to_status,
    'previous_version', row.previous_version, 'created_at', row.created_at) ORDER BY row.previous_version DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.support_case_actions WHERE case_id = p_case_id
      AND (p_before_version IS NULL OR previous_version < p_before_version)
      ORDER BY previous_version DESC LIMIT 50) AS row);
END;
$function$;

-- Staff decisions are version checked and idempotent per request id. A public reply and an
-- internal note are separate rows: the note is never selectable by the member. Closing intake
-- stops new member writes but deliberately does not strand cases that are already open.
CREATE FUNCTION public.staff_update_support_case(p_case_id uuid, p_version integer, p_status text,
  p_reply text, p_internal_note text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  limits public.support_limits%ROWTYPE;
  prior public.support_case_actions%ROWTYPE;
  current_case public.support_cases%ROWTYPE;
  reply text := nullif(trim(coalesce(p_reply, '')), '');
  note text := nullif(trim(coalesce(p_internal_note, '')), '');
  digest text;
  next_status text;
  added integer := 0;
BEGIN
  IF NOT public.can_staff_support() THEN RAISE EXCEPTION 'Support staff access required' USING ERRCODE = 'PT403'; END IF;
  SELECT * INTO limits FROM public.support_limits WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'Support service unavailable' USING ERRCODE = 'PT503'; END IF;
  IF p_case_id IS NULL OR p_request_id IS NULL OR p_version IS NULL OR p_version < 1
    OR (p_status IS NOT NULL AND p_status NOT IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed'))
    OR (reply IS NOT NULL AND length(reply) > 2000) OR (note IS NOT NULL AND length(note) > 2000) THEN
    RAISE EXCEPTION 'Invalid support decision' USING ERRCODE = '22023';
  END IF;
  digest := public.support_digest(p_case_id::text, p_version::text, coalesce(p_status, ''), coalesce(reply, ''), coalesce(note, ''));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('support-staff:' || caller::text, 0));
  SELECT * INTO prior FROM public.support_case_actions WHERE actor = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.payload_digest <> digest OR prior.case_id <> p_case_id THEN
      RAISE EXCEPTION 'Request id already used for a different decision' USING ERRCODE = 'PT409';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', prior.case_id, 'status', prior.to_status,
      'version', prior.previous_version + 1, 'duplicate', true);
  END IF;
  IF (SELECT count(*) FROM public.support_case_actions WHERE actor = caller
    AND created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= limits.staff_actions_per_minute THEN
    RAISE EXCEPTION 'Decision limit reached; try later' USING ERRCODE = 'PT429';
  END IF;
  SELECT * INTO current_case FROM public.support_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Support request unavailable' USING ERRCODE = 'PT404'; END IF;
  IF current_case.version <> p_version THEN
    RAISE EXCEPTION 'This request changed; refresh before deciding' USING ERRCODE = 'PT409';
  END IF;
  next_status := coalesce(p_status, current_case.status);
  IF next_status = current_case.status THEN
    IF reply IS NULL AND note IS NULL THEN RAISE EXCEPTION 'Nothing to record' USING ERRCODE = '22023'; END IF;
  ELSIF NOT ((current_case.status = 'open' AND next_status IN ('in_progress', 'waiting_customer', 'resolved', 'closed'))
    OR (current_case.status = 'in_progress' AND next_status IN ('waiting_customer', 'resolved', 'closed'))
    OR (current_case.status = 'waiting_customer' AND next_status IN ('in_progress', 'resolved', 'closed'))
    OR (current_case.status = 'resolved' AND next_status IN ('in_progress', 'closed'))
    OR (current_case.status = 'closed' AND next_status = 'in_progress')) THEN
    RAISE EXCEPTION 'Invalid support transition' USING ERRCODE = '22023';
  END IF;
  IF reply IS NOT NULL THEN added := added + 1; END IF;
  IF note IS NOT NULL THEN added := added + 1; END IF;
  IF current_case.message_count + added > limits.case_messages_total THEN
    RAISE EXCEPTION 'Message limit reached; try later' USING ERRCODE = 'PT429';
  END IF;
  IF reply IS NOT NULL THEN
    INSERT INTO public.support_messages(case_id, author, author_role, visibility, body, request_id, case_version)
      VALUES (p_case_id, caller, 'staff', 'thread', reply, p_request_id, current_case.version);
  END IF;
  IF note IS NOT NULL THEN
    INSERT INTO public.support_messages(case_id, author, author_role, visibility, body, request_id, case_version)
      VALUES (p_case_id, caller, 'staff', 'internal', note, p_request_id, current_case.version);
  END IF;
  INSERT INTO public.support_case_actions(case_id, actor, actor_role, request_id, payload_digest, from_status, to_status, previous_version)
    VALUES (p_case_id, caller, 'staff', p_request_id, digest, current_case.status, next_status, current_case.version);
  UPDATE public.support_cases SET status = next_status, version = version + 1, message_count = message_count + added,
    updated_at = pg_catalog.clock_timestamp() WHERE id = p_case_id;
  RETURN pg_catalog.jsonb_build_object('id', p_case_id, 'status', next_status,
    'version', current_case.version + 1, 'duplicate', false);
END;
$function$;

-- Service-only configuration. SECURITY INVOKER on purpose: only service_role holds the table
-- grant, so an authenticated caller is denied by the database rather than by a code check.
-- The reference is an opaque identifier for a separately verified approval, not proof of one.
-- No retention duration, deletion job or erasure procedure is created by this migration.
CREATE FUNCTION public.configure_support_policy(p_collection boolean, p_response text, p_contact text,
  p_retention_approved boolean, p_retention_days integer, p_erasure_approved boolean, p_policy_ref uuid)
RETURNS public.support_policy LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE updated public.support_policy%ROWTYPE;
BEGIN
  UPDATE public.support_policy SET
    collection_enabled = coalesce(p_collection, false),
    response_expectation = nullif(trim(coalesce(p_response, '')), ''),
    contact_channel = nullif(trim(coalesce(p_contact, '')), ''),
    retention_approved = coalesce(p_retention_approved, false),
    retention_days = p_retention_days,
    erasure_approved = coalesce(p_erasure_approved, false),
    policy_ref = p_policy_ref,
    revision = revision + 1,
    updated_at = pg_catalog.clock_timestamp()
  WHERE singleton RETURNING * INTO updated;
  RETURN updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.can_staff_support(), public.support_settings(), public.support_intake_guard(),
  public.support_clean_evidence(text[]), public.support_digest(text[]),
  public.submit_support_case(uuid, text, text, text[]), public.my_support_cases(timestamptz, uuid),
  public.support_thread(uuid, timestamptz, uuid), public.add_support_reply(uuid, uuid, text, text[]),
  public.support_queue(text, timestamptz, uuid), public.support_case_history(uuid, integer),
  public.staff_update_support_case(uuid, integer, text, text, text, uuid),
  public.configure_support_policy(boolean, text, text, boolean, integer, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_staff_support(), public.support_settings(),
  public.submit_support_case(uuid, text, text, text[]), public.my_support_cases(timestamptz, uuid),
  public.support_thread(uuid, timestamptz, uuid), public.add_support_reply(uuid, uuid, text, text[]),
  public.support_queue(text, timestamptz, uuid), public.support_case_history(uuid, integer),
  public.staff_update_support_case(uuid, integer, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.configure_support_policy(boolean, text, text, boolean, integer, boolean, uuid) TO service_role;

-- Effective-privilege closure. The GRANT statements above state intent; this asserts the
-- result, including privileges reached by role inheritance, and aborts the migration if it
-- does not hold. Every object is named explicitly so nothing pre-existing -- in particular the
-- legacy public.support_tickets surface -- is inspected, altered or weakened by this check.
DO $permissions$
DECLARE
  entry record;
  checked_role text;
  privilege text;
  allowed boolean;
  found_calls integer := 0;
  found_tables integer := 0;
  every_call text[] := ARRAY['can_staff_support', 'support_settings', 'support_intake_guard', 'support_clean_evidence',
    'support_digest', 'submit_support_case', 'my_support_cases', 'support_thread', 'add_support_reply',
    'support_queue', 'support_case_history', 'staff_update_support_case', 'configure_support_policy'];
  member_calls text[] := ARRAY['can_staff_support', 'support_settings', 'submit_support_case', 'my_support_cases',
    'support_thread', 'add_support_reply', 'support_queue', 'support_case_history', 'staff_update_support_case'];
  service_calls text[] := ARRAY['configure_support_policy'];
  every_table text[] := ARRAY['support_policy', 'support_limits', 'support_staff',
    'support_cases', 'support_messages', 'support_case_actions'];
  service_tables jsonb := pg_catalog.jsonb_build_object(
    'support_policy', 'SELECT,UPDATE', 'support_limits', 'SELECT,UPDATE',
    'support_staff', 'SELECT,INSERT,UPDATE,DELETE', 'support_cases', 'SELECT',
    'support_messages', 'SELECT', 'support_case_actions', 'SELECT');
BEGIN
  FOR entry IN SELECT oid, proname, proowner, proacl FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = ANY (every_call) LOOP
    found_calls := found_calls + 1;
    IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(entry.proacl, pg_catalog.acldefault('f', entry.proowner)))
      WHERE grantee = 0 AND privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC support function privilege: %', entry.proname USING ERRCODE = '42501';
    END IF;
    FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      allowed := (checked_role = 'authenticated' AND entry.proname = ANY (member_calls))
        OR (checked_role = 'service_role' AND entry.proname = ANY (service_calls));
      IF pg_catalog.has_function_privilege(checked_role, entry.oid, 'EXECUTE') <> allowed THEN
        RAISE EXCEPTION 'Unexpected effective support function privilege (including inheritance): % %',
          checked_role, entry.proname USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  IF found_calls <> pg_catalog.array_length(every_call, 1) THEN
    RAISE EXCEPTION 'Support function inventory incomplete: % of %', found_calls, pg_catalog.array_length(every_call, 1) USING ERRCODE = '42501';
  END IF;

  FOR entry IN SELECT oid, relname, relacl, relowner, relrowsecurity FROM pg_catalog.pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      AND relname = ANY (every_table) LOOP
    found_tables := found_tables + 1;
    IF NOT entry.relrowsecurity THEN
      RAISE EXCEPTION 'Row level security is not enabled on %', entry.relname USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(entry.relacl, pg_catalog.acldefault('r', entry.relowner)))
      WHERE grantee = 0) THEN
      RAISE EXCEPTION 'PUBLIC support table privilege: %', entry.relname USING ERRCODE = '42501';
    END IF;
    FOREACH checked_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF pg_catalog.has_table_privilege(checked_role, entry.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(checked_role, entry.oid, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'Unexpected effective support table privilege (including inheritance): % %',
          checked_role, entry.relname USING ERRCODE = '42501';
      END IF;
    END LOOP;
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege('service_role', entry.oid, privilege)
        <> (pg_catalog.strpos(service_tables ->> entry.relname, privilege) > 0) THEN
        RAISE EXCEPTION 'Unexpected effective support table privilege (including inheritance): service_role % %',
          entry.relname, privilege USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  IF found_tables <> pg_catalog.array_length(every_table, 1) THEN
    RAISE EXCEPTION 'Support table inventory incomplete: % of %', found_tables, pg_catalog.array_length(every_table, 1) USING ERRCODE = '42501';
  END IF;
END;
$permissions$;

NOTIFY pgrst, 'reload schema';
COMMIT;
