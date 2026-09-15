BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.accounts') IS NULL
    OR pg_catalog.to_regclass('public.billing_analytics_consent') IS NULL
    OR pg_catalog.to_regclass('public.analytics_delivery_config') IS NULL THEN
    RAISE EXCEPTION 'Apply accounts security, billing-events.sql and analytics-outbox.sql first';
  END IF;
  IF pg_catalog.to_regclass('public.activation_config') IS NOT NULL
    OR pg_catalog.to_regclass('public.activation_members') IS NOT NULL THEN
    RAISE EXCEPTION 'Activation already exists; use a reviewed forward migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.accounts'::regclass AND attname = 'data' AND atttypid = 'jsonb'::regtype AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.accounts'::regclass AND attname = 'uid' AND atttypid = 'text'::regtype AND NOT attisdropped)
    OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.accounts'::regclass)
    OR pg_catalog.has_table_privilege('anon', 'public.accounts', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'auth.users', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Expected private accounts(uid text, data jsonb) and server-owned auth.users';
  END IF;
END;
$migration$;

LOCK TABLE auth.users, public.accounts, public.billing_analytics_consent IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.activation_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  collection_enabled boolean NOT NULL DEFAULT false,
  export_enabled boolean NOT NULL DEFAULT false,
  source_mode text NOT NULL DEFAULT 'unreviewed' CHECK (source_mode IN ('unreviewed', 'local_test', 'production')),
  consent_version text CHECK (consent_version ~ '^[a-z0-9-]{1,64}$'),
  permission_approved boolean NOT NULL DEFAULT false,
  source_verified boolean NOT NULL DEFAULT false,
  exclusions_verified boolean NOT NULL DEFAULT false,
  registration_flow_approved boolean NOT NULL DEFAULT false,
  retention_approved boolean NOT NULL DEFAULT false,
  source_epoch uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  enabled_at timestamptz CHECK (pg_catalog.isfinite(enabled_at)),
  registrations_complete_through timestamptz CHECK (pg_catalog.isfinite(registrations_complete_through)),
  workouts_complete_through timestamptz CHECK (pg_catalog.isfinite(workouts_complete_through)),
  CHECK (NOT export_enabled OR collection_enabled),
  CHECK (NOT collection_enabled OR (consent_version IS NOT NULL AND permission_approved AND source_verified
    AND exclusions_verified AND source_mode IN ('local_test', 'production')
    AND (source_mode = 'local_test' OR (registration_flow_approved AND retention_approved))))
);
INSERT INTO public.activation_config DEFAULT VALUES;

CREATE TABLE public.activation_members (
  uid uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  source_epoch uuid NOT NULL,
  source_mode text NOT NULL CHECK (source_mode IN ('local_test', 'production')),
  consent_version text NOT NULL,
  consent_revision uuid NOT NULL,
  consent_captured_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(consent_captured_at)),
  registered_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(registered_at)),
  first_workout_at timestamptz CHECK (pg_catalog.isfinite(first_workout_at)),
  pending_workout_date date CHECK (pg_catalog.isfinite(pending_workout_date)),
  history_state text NOT NULL DEFAULT 'awaiting_account' CHECK (history_state IN ('awaiting_account', 'observing', 'incomplete')),
  incomplete_reason text CHECK (incomplete_reason IN ('legacy_or_unknown_history', 'initial_import',
    'unfinalized_history', 'invalid_document', 'history_rewrite', 'untrusted_write', 'untrusted_log_date')),
  CHECK (consent_captured_at <= registered_at),
  CHECK (first_workout_at IS NULL OR first_workout_at >= registered_at),
  CHECK ((history_state = 'incomplete') = (incomplete_reason IS NOT NULL))
);
CREATE INDEX activation_members_cohort ON public.activation_members (source_epoch, registered_at);

CREATE TABLE public.activation_finalization_receipts (
  uid uuid NOT NULL REFERENCES public.activation_members(uid) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  workout_date date NOT NULL CHECK (pg_catalog.isfinite(workout_date)),
  recorded_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(recorded_at)),
  PRIMARY KEY (uid, request_id),
  UNIQUE (uid)
);

ALTER TABLE public.activation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_finalization_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.activation_config, public.activation_members, public.activation_finalization_receipts
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._activation_config_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  NEW.source_epoch := OLD.source_epoch;
  IF NEW.collection_enabled AND (NOT OLD.collection_enabled OR NEW.source_mode IS DISTINCT FROM OLD.source_mode
    OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
    OR NEW.source_verified IS DISTINCT FROM OLD.source_verified
    OR NEW.exclusions_verified IS DISTINCT FROM OLD.exclusions_verified
    OR NEW.permission_approved IS DISTINCT FROM OLD.permission_approved
    OR NEW.registration_flow_approved IS DISTINCT FROM OLD.registration_flow_approved
    OR NEW.retention_approved IS DISTINCT FROM OLD.retention_approved) THEN
    NEW.source_epoch := pg_catalog.gen_random_uuid();
    NEW.enabled_at := pg_catalog.clock_timestamp();
    NEW.registrations_complete_through := NULL;
    NEW.workouts_complete_through := NULL;
  ELSIF NOT NEW.collection_enabled THEN
    NEW.enabled_at := NULL;
    NEW.registrations_complete_through := NULL;
    NEW.workouts_complete_through := NULL;
  ELSE
    NEW.enabled_at := OLD.enabled_at;
  END IF;
  IF NEW.registrations_complete_through > pg_catalog.clock_timestamp()
    OR NEW.workouts_complete_through > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'A completeness watermark cannot be in the future' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_config_epoch BEFORE UPDATE ON public.activation_config
  FOR EACH ROW EXECUTE FUNCTION public._activation_config_epoch();

CREATE FUNCTION public._activation_verified_account(p_uid uuid) RETURNS boolean
LANGUAGE sql SET search_path = '' AS $function$
  SELECT EXISTS (SELECT 1 FROM auth.users AS account
    WHERE account.id = p_uid AND account.deleted_at IS NULL AND NOT COALESCE(account.is_anonymous, false)
      AND account.created_at IS NOT NULL AND pg_catalog.isfinite(account.created_at)
      AND account.created_at <= pg_catalog.clock_timestamp()
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) >= account.created_at
      AND COALESCE(account.email_confirmed_at, account.phone_confirmed_at) <= pg_catalog.clock_timestamp()
      AND account.raw_app_meta_data #>> '{activation,cohort}' = 'production');
$function$;

CREATE FUNCTION public._activation_register_auth() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.activation_config%ROWTYPE;
  choice public.billing_analytics_consent%ROWTYPE;
  incomplete boolean;
BEGIN
  SELECT * INTO STRICT settings FROM public.activation_config WHERE singleton;
  IF NOT settings.collection_enabled OR settings.enabled_at IS NULL
    OR settings.consent_version IS DISTINCT FROM (SELECT consent_version FROM public.analytics_delivery_config WHERE singleton) THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || NEW.id::text, 0));
  IF NOT public._activation_verified_account(NEW.id) THEN
    DELETE FROM public.activation_members WHERE uid = NEW.id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    UPDATE public.activation_members SET history_state = 'incomplete', incomplete_reason = 'legacy_or_unknown_history' WHERE uid = NEW.id;
    RETURN NEW;
  END IF;
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = NEW.id::text;
  IF NOT FOUND OR NOT choice.granted OR choice.version <> settings.consent_version
    OR choice.captured_at > NEW.created_at OR NEW.created_at < settings.enabled_at THEN RETURN NEW; END IF;
  incomplete := NEW.raw_app_meta_data #>> '{activation,history}' IS DISTINCT FROM 'native_only'
    OR (EXISTS (SELECT 1 FROM public.accounts WHERE uid = NEW.id::text)
      AND NOT EXISTS (SELECT 1 FROM public.activation_members WHERE uid = NEW.id));
  IF incomplete THEN
    UPDATE public.activation_members SET history_state = 'incomplete', incomplete_reason = 'legacy_or_unknown_history' WHERE uid = NEW.id;
  END IF;
  INSERT INTO public.activation_members (uid, source_epoch, source_mode, consent_version, consent_revision,
    consent_captured_at, registered_at, history_state, incomplete_reason)
  VALUES (NEW.id, settings.source_epoch, settings.source_mode, choice.version, choice.revision, choice.captured_at,
    NEW.created_at, CASE WHEN incomplete THEN 'incomplete' ELSE 'awaiting_account' END,
    CASE WHEN incomplete THEN 'legacy_or_unknown_history' ELSE NULL END)
  ON CONFLICT (uid) DO NOTHING;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_auth_registration AFTER INSERT OR UPDATE OF created_at, email_confirmed_at,
  phone_confirmed_at, is_anonymous, deleted_at, raw_app_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public._activation_register_auth();

CREATE FUNCTION public.get_activation_registration() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  settings public.activation_config%ROWTYPE;
  choice public.billing_analytics_consent%ROWTYPE;
  account auth.users%ROWTYPE;
  result jsonb := pg_catalog.jsonb_build_object('confirmed', false, 'status', 'not_enrolled', 'registered_at', NULL);
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO STRICT settings FROM public.activation_config WHERE singleton FOR SHARE;
  IF NOT settings.collection_enabled OR settings.enabled_at IS NULL THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'disabled');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || caller::text, 0));
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = caller::text;
  IF NOT FOUND OR NOT choice.granted OR choice.version IS DISTINCT FROM settings.consent_version
    OR settings.consent_version IS DISTINCT FROM (SELECT consent_version FROM public.analytics_delivery_config WHERE singleton) THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'consent_required');
  END IF;
  SELECT * INTO account FROM auth.users WHERE id = caller;
  IF NOT FOUND OR NOT public._activation_verified_account(caller) THEN RETURN result; END IF;
  IF choice.captured_at > account.created_at THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'prior_consent_required');
  END IF;
  IF account.created_at < settings.enabled_at OR NOT EXISTS (SELECT 1 FROM public.activation_members AS member
    WHERE member.uid = caller AND member.registered_at = account.created_at
      AND member.source_epoch = settings.source_epoch AND member.source_mode = settings.source_mode
      AND member.consent_version = choice.version AND member.consent_revision = choice.revision
      AND member.consent_captured_at = choice.captured_at) THEN RETURN result; END IF;
  RETURN pg_catalog.jsonb_build_object('confirmed', true, 'status', 'registered',
    'registered_at', pg_catalog.to_char(account.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END;
$function$;

CREATE FUNCTION public._activation_consent_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.activation_members WHERE uid::text = OLD.uid;
    RETURN OLD;
  END IF;
  IF NOT NEW.granted OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.version IS DISTINCT FROM OLD.version THEN
    DELETE FROM public.activation_members WHERE uid::text = OLD.uid;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_consent_changed AFTER UPDATE OR DELETE ON public.billing_analytics_consent
  FOR EACH ROW EXECUTE FUNCTION public._activation_consent_changed();

CREATE FUNCTION public._activation_log_days(p_data jsonb, p_completed_only boolean) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
DECLARE
  entry jsonb;
  exercise jsonb;
  logged_set jsonb;
  log_day text;
  draft_day text;
  positive_sets boolean;
  seen_days text[] := ARRAY[]::text[];
  result text[] := ARRAY[]::text[];
BEGIN
  IF pg_catalog.jsonb_typeof(p_data) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_data -> 'workoutLog') IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_data -> 'restDays') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF p_data ? 'draftSession' AND p_data -> 'draftSession' <> 'null'::jsonb THEN
    IF pg_catalog.jsonb_typeof(p_data -> 'draftSession') IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(p_data #> '{draftSession,session}') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
    draft_day := p_data #>> '{draftSession,date}';
    IF draft_day IS NULL OR draft_day !~ '^\d{4}-\d{2}-\d{2}$'
      OR pg_catalog.to_char(draft_day::date, 'YYYY-MM-DD') <> draft_day THEN RETURN NULL; END IF;
  END IF;
  FOR entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_data -> 'workoutLog') LOOP
    log_day := entry ->> 'date';
    IF pg_catalog.jsonb_typeof(entry) IS DISTINCT FROM 'object' OR log_day IS NULL
      OR log_day !~ '^\d{4}-\d{2}-\d{2}$' OR pg_catalog.to_char(log_day::date, 'YYYY-MM-DD') <> log_day
      OR pg_catalog.jsonb_typeof(entry -> 'exercises') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF log_day = ANY(seen_days) THEN RETURN NULL; END IF;
    seen_days := pg_catalog.array_append(seen_days, log_day);
    IF pg_catalog.jsonb_array_length(entry -> 'exercises') = 0 THEN CONTINUE; END IF;
    positive_sets := true;
    FOR exercise IN SELECT value FROM pg_catalog.jsonb_array_elements(entry -> 'exercises') LOOP
      IF pg_catalog.jsonb_typeof(exercise) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(exercise -> 'sets') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
      IF pg_catalog.jsonb_array_length(exercise -> 'sets') = 0 THEN RETURN NULL; END IF;
      FOR logged_set IN SELECT value FROM pg_catalog.jsonb_array_elements(exercise -> 'sets') LOOP
        IF pg_catalog.jsonb_typeof(logged_set) IS DISTINCT FROM 'object'
          OR pg_catalog.jsonb_typeof(logged_set -> 'reps') IS DISTINCT FROM 'number'
          OR pg_catalog.jsonb_typeof(logged_set -> 'weight') IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
        IF (logged_set ->> 'reps')::numeric <= 0 OR (logged_set ->> 'weight')::numeric < 0 THEN
          positive_sets := false;
        END IF;
      END LOOP;
    END LOOP;
    IF p_completed_only AND (NOT positive_sets OR log_day = draft_day OR (p_data -> 'restDays') ? log_day) THEN CONTINUE; END IF;
    IF NOT log_day = ANY(result) THEN result := pg_catalog.array_append(result, log_day); END IF;
  END LOOP;
  RETURN result;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public._activation_observe_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.activation_config%ROWTYPE;
  member public.activation_members%ROWTYPE;
  choice public.billing_analytics_consent%ROWTYPE;
  observed_at timestamptz := pg_catalog.clock_timestamp();
  before_days text[];
  before_completed text[];
  after_days text[];
  after_completed text[];
  added_days text[];
  reason text;
BEGIN
  SELECT * INTO STRICT settings FROM public.activation_config WHERE singleton;
  IF NOT settings.collection_enabled OR settings.enabled_at IS NULL
    OR settings.consent_version IS DISTINCT FROM (SELECT consent_version FROM public.analytics_delivery_config WHERE singleton)
    OR NEW.uid !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || NEW.uid, 0));
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = NEW.uid;
  IF NOT FOUND OR NOT choice.granted OR choice.version <> settings.consent_version THEN RETURN NEW; END IF;
  SELECT * INTO member FROM public.activation_members WHERE uid = NEW.uid::uuid
    AND source_epoch = settings.source_epoch AND source_mode = settings.source_mode
    AND consent_version = choice.version AND consent_revision = choice.revision
    AND consent_captured_at = choice.captured_at FOR UPDATE;
  IF NOT FOUND OR member.history_state = 'incomplete' OR NOT public._activation_verified_account(member.uid) THEN RETURN NEW; END IF;
  IF auth.uid() IS DISTINCT FROM member.uid OR (TG_OP = 'UPDATE' AND OLD.uid IS DISTINCT FROM NEW.uid) THEN
    UPDATE public.activation_members SET history_state = 'incomplete', incomplete_reason = 'untrusted_write' WHERE uid = member.uid;
    RETURN NEW;
  END IF;
  after_days := public._activation_log_days(NEW.data, false);
  after_completed := public._activation_log_days(NEW.data, true);
  IF after_days IS NULL OR after_completed IS NULL THEN
    reason := 'invalid_document';
  ELSIF TG_OP = 'INSERT' THEN
    IF pg_catalog.cardinality(after_days) > 0 THEN reason := 'initial_import'; END IF;
  ELSE
    before_days := public._activation_log_days(OLD.data, false);
    before_completed := public._activation_log_days(OLD.data, true);
    IF before_days IS NULL OR before_completed IS NULL THEN
      reason := 'invalid_document';
    ELSIF member.history_state <> 'observing' THEN
      reason := 'legacy_or_unknown_history';
    ELSIF NOT before_days <@ after_days OR NOT before_completed <@ after_completed THEN
      reason := 'history_rewrite';
    ELSE
      SELECT ARRAY(SELECT logged.day FROM pg_catalog.unnest(after_days) AS logged(day)
        WHERE NOT logged.day = ANY(before_days)) INTO added_days;
      IF pg_catalog.cardinality(added_days) > 1 THEN
        reason := 'initial_import';
      ELSIF pg_catalog.cardinality(added_days) = 1 THEN
        IF added_days[1]::date < (observed_at AT TIME ZONE 'UTC')::date - 1
          OR added_days[1]::date > (observed_at AT TIME ZONE 'UTC')::date + 1 THEN
          reason := 'untrusted_log_date';
        ELSIF member.first_workout_at IS NULL THEN
          IF member.pending_workout_date IS NOT NULL AND member.pending_workout_date <> added_days[1]::date THEN
            reason := 'unfinalized_history';
          ELSE
            UPDATE public.activation_members SET pending_workout_date = added_days[1]::date WHERE uid = member.uid;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  UPDATE public.activation_members SET history_state = CASE WHEN reason IS NULL THEN 'observing' ELSE 'incomplete' END,
    incomplete_reason = reason WHERE uid = member.uid;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER activation_account_observed AFTER INSERT OR UPDATE OF uid, data ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public._activation_observe_account();

CREATE FUNCTION public.record_workout_finalization(p_request_id uuid, p_workout_date date,
  p_consent_version text, p_consent_revision uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  settings public.activation_config%ROWTYPE;
  choice public.billing_analytics_consent%ROWTYPE;
  member public.activation_members%ROWTYPE;
  receipt public.activation_finalization_receipts%ROWTYPE;
  saved_data jsonb;
  completed_days text[];
  workout_day text := pg_catalog.to_char(p_workout_date, 'YYYY-MM-DD');
  observed_at timestamptz;
  result jsonb := pg_catalog.jsonb_build_object('request_id', p_request_id, 'confirmed', false,
    'status', 'not_ready', 'recorded_at', NULL);
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL OR p_workout_date IS NULL OR NOT pg_catalog.isfinite(p_workout_date)
    OR p_consent_version IS NULL OR p_consent_version !~ '^[a-z0-9-]{1,64}$' OR p_consent_revision IS NULL THEN
    RAISE EXCEPTION 'A request UUID, finite workout date and current consent revision are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT settings FROM public.activation_config WHERE singleton FOR SHARE;
  IF NOT settings.collection_enabled OR settings.enabled_at IS NULL THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'disabled');
  END IF;
  SELECT data INTO saved_data FROM public.accounts WHERE uid = caller::text FOR UPDATE;
  IF NOT FOUND THEN RETURN result; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.analytics_consent:' || caller::text, 0));
  SELECT * INTO choice FROM public.billing_analytics_consent WHERE uid = caller::text;
  IF NOT FOUND OR NOT choice.granted OR choice.version IS DISTINCT FROM p_consent_version
    OR choice.revision IS DISTINCT FROM p_consent_revision OR choice.version IS DISTINCT FROM settings.consent_version
    OR settings.consent_version IS DISTINCT FROM (SELECT consent_version FROM public.analytics_delivery_config WHERE singleton) THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'consent_required');
  END IF;
  SELECT * INTO member FROM public.activation_members WHERE uid = caller
    AND source_epoch = settings.source_epoch AND source_mode = settings.source_mode
    AND consent_version = choice.version AND consent_revision = choice.revision
    AND consent_captured_at = choice.captured_at FOR UPDATE;
  IF NOT FOUND OR NOT public._activation_verified_account(caller) THEN
    RETURN result || pg_catalog.jsonb_build_object('status', 'not_enrolled');
  END IF;
  SELECT * INTO receipt FROM public.activation_finalization_receipts WHERE uid = caller;
  IF FOUND THEN
    IF receipt.request_id <> p_request_id THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'already_recorded');
    END IF;
    IF receipt.workout_date <> p_workout_date THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'request_conflict');
    END IF;
  ELSE
    IF member.history_state = 'incomplete' THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'incomplete_history');
    END IF;
    IF member.first_workout_at IS NOT NULL THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'already_recorded');
    END IF;
    IF member.history_state <> 'observing' OR member.pending_workout_date IS DISTINCT FROM p_workout_date THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'not_candidate');
    END IF;
    observed_at := pg_catalog.clock_timestamp();
    IF p_workout_date < (observed_at AT TIME ZONE 'UTC')::date - 1
      OR p_workout_date > (observed_at AT TIME ZONE 'UTC')::date + 1 THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'date_out_of_range');
    END IF;
    completed_days := public._activation_log_days(saved_data, true);
    IF completed_days IS NULL THEN
      RETURN result || pg_catalog.jsonb_build_object('status', 'incomplete_history');
    END IF;
    IF NOT workout_day = ANY(completed_days)
      OR (saved_data ? 'draftSession' AND saved_data -> 'draftSession' <> 'null'::jsonb) THEN RETURN result; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(saved_data -> 'workoutLog') AS logged(entry)
        WHERE logged.entry ->> 'date' = workout_day
          AND logged.entry ->> 'finalizationRequestId' = p_request_id::text) THEN RETURN result; END IF;
    INSERT INTO public.activation_finalization_receipts (uid, request_id, workout_date, recorded_at)
      VALUES (caller, p_request_id, p_workout_date, observed_at) RETURNING * INTO receipt;
    UPDATE public.activation_members SET first_workout_at = observed_at, pending_workout_date = NULL WHERE uid = caller;
  END IF;
  RETURN pg_catalog.jsonb_build_object('request_id', receipt.request_id, 'confirmed', true, 'status', 'recorded',
    'recorded_at', pg_catalog.to_char(receipt.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END;
$function$;

CREATE FUNCTION public.get_activation_cohort(p_signup_day date, p_publish boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  settings public.activation_config%ROWTYPE;
  day_start timestamptz := p_signup_day::timestamp AT TIME ZONE 'UTC';
  day_end timestamptz := (p_signup_day + 1)::timestamp AT TIME ZONE 'UTC';
  complete_through timestamptz;
  registered bigint;
  eligible bigint;
  completed bigint;
  incomplete bigint;
  result jsonb;
BEGIN
  IF p_signup_day IS NULL OR NOT pg_catalog.isfinite(p_signup_day) OR p_publish IS NULL THEN
    RAISE EXCEPTION 'A finite UTC signup date and publication mode are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT settings FROM public.activation_config WHERE singleton;
  result := pg_catalog.jsonb_build_object('signup_day', p_signup_day, 'timezone', 'UTC',
    'source_mode', settings.source_mode, 'registration_source', 'auth.users.created_at',
    'workout_source', 'accounts.authenticated_finalization_receipt', 'provider_verified_workout', false,
    'workout_timestamp_source', 'server_acknowledgement',
    'publication', CASE WHEN p_publish THEN 'suppressed' ELSE 'private_qa' END,
    'status', 'incomplete', 'complete_through', NULL, 'registered_members', NULL,
    'activation_eligible', NULL, 'activation_completed', NULL, 'activation_7d', NULL,
    'd1_return', NULL, 'd7_return', NULL, 'retention_source_status', 'app_entry_source_unavailable');
  IF NOT settings.collection_enabled OR NOT settings.export_enabled OR settings.enabled_at IS NULL
    OR settings.enabled_at > day_start OR settings.registrations_complete_through IS NULL
    OR settings.workouts_complete_through IS NULL OR settings.registrations_complete_through < day_end
    OR settings.consent_version IS DISTINCT FROM (SELECT consent_version FROM public.analytics_delivery_config WHERE singleton)
    OR (p_publish AND settings.source_mode <> 'production') THEN RETURN result; END IF;
  complete_through := LEAST(settings.registrations_complete_through, settings.workouts_complete_through, pg_catalog.clock_timestamp());
  WITH cohort AS (
    SELECT member.* FROM public.activation_members AS member
      JOIN auth.users AS account ON account.id = member.uid
      JOIN public.billing_analytics_consent AS choice ON choice.uid = member.uid::text
    WHERE member.registered_at >= day_start AND member.registered_at < day_end
      AND member.source_epoch = settings.source_epoch AND member.source_mode = settings.source_mode
      AND choice.granted AND choice.version = settings.consent_version AND choice.version = member.consent_version
      AND choice.revision = member.consent_revision AND choice.captured_at = member.consent_captured_at
      AND public._activation_verified_account(member.uid)
  ) SELECT pg_catalog.count(*),
    pg_catalog.count(*) FILTER (WHERE registered_at + interval '168 hours' <= complete_through),
    pg_catalog.count(*) FILTER (WHERE registered_at + interval '168 hours' <= complete_through
      AND first_workout_at >= registered_at AND first_workout_at < registered_at + interval '168 hours'),
    pg_catalog.count(*) FILTER (WHERE history_state = 'incomplete')
    INTO registered, eligible, completed, incomplete FROM cohort;
  IF incomplete > 0 THEN RETURN result; END IF;
  result := result || pg_catalog.jsonb_build_object('status', CASE WHEN eligible = 0 THEN 'immature_or_empty' ELSE 'available' END,
    'complete_through', pg_catalog.to_char(complete_through AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'registered_members', CASE WHEN NOT p_publish OR registered >= 5 THEN registered END,
    'activation_eligible', CASE WHEN NOT p_publish OR eligible >= 5 THEN eligible END,
    'activation_completed', CASE WHEN NOT p_publish OR (completed >= 5 AND eligible - completed >= 5) THEN completed END,
    'activation_7d', CASE WHEN eligible > 0 AND (NOT p_publish OR (eligible >= 30 AND completed >= 5 AND eligible - completed >= 5))
      THEN pg_catalog.round(100.0 * completed / eligible, 2) END);
  IF p_publish AND eligible >= 30 AND completed >= 5 AND eligible - completed >= 5 THEN
    result := result || pg_catalog.jsonb_build_object('publication', 'publishable');
  END IF;
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public._activation_config_epoch(), public._activation_verified_account(uuid),
  public._activation_register_auth(), public.get_activation_registration(),
  public._activation_consent_changed(), public._activation_log_days(jsonb, boolean),
  public._activation_observe_account(), public.record_workout_finalization(uuid, date, text, uuid),
  public.get_activation_cohort(date, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_workout_finalization(uuid, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_activation_registration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_activation_cohort(date, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;