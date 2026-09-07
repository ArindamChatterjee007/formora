BEGIN;

CREATE TABLE public.report_cases (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reporter uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('post', 'comment', 'user')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 255),
  reported_uid text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'under_review', 'action_taken', 'no_action', 'closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (reporter, request_id)
);
CREATE INDEX report_cases_reporter_date ON public.report_cases (reporter, created_at DESC, id DESC);
CREATE INDEX report_cases_status_date ON public.report_cases (status, created_at DESC, id DESC);
CREATE INDEX report_cases_target_date ON public.report_cases (kind, target_id, created_at DESC);
CREATE TABLE public.report_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  reporter_per_minute integer NOT NULL DEFAULT 10 CHECK (reporter_per_minute BETWEEN 1 AND 100),
  reporter_per_day integer NOT NULL DEFAULT 50 CHECK (reporter_per_day BETWEEN 1 AND 1000),
  target_per_minute integer NOT NULL DEFAULT 100 CHECK (target_per_minute BETWEEN 1 AND 1000),
  target_per_day integer NOT NULL DEFAULT 1000 CHECK (target_per_day BETWEEN 1 AND 10000)
);
INSERT INTO public.report_limits DEFAULT VALUES;
CREATE TABLE public.report_moderators (
  uid uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE public.report_case_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.report_cases(id),
  actor uuid NOT NULL,
  request_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  previous_version integer NOT NULL,
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (actor, request_id)
);
CREATE UNIQUE INDEX report_case_actions_case_version ON public.report_case_actions (case_id, previous_version DESC);
ALTER TABLE public.report_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_moderators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_case_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_cases, public.report_limits, public.report_moderators, public.report_case_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.report_limits TO service_role;
GRANT SELECT ON public.report_cases, public.report_case_actions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_moderators TO service_role;

CREATE FUNCTION public.submit_report(p_request_id uuid, p_kind text, p_target_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  caller uuid := auth.uid();
  existing public.report_cases%ROWTYPE;
  target_owner text;
  limits public.report_limits%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF p_request_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('post','comment','user')
    OR p_target_id IS NULL OR length(p_target_id) NOT BETWEEN 1 AND 255
    OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Invalid report' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('report:' || caller::text, 0));
  SELECT * INTO existing FROM public.report_cases WHERE reporter = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF existing.kind <> p_kind OR existing.target_id <> p_target_id OR existing.reason <> trim(p_reason) THEN
      RAISE EXCEPTION 'Request id already used for another report' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    SELECT * INTO limits FROM public.report_limits WHERE singleton;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report service unavailable' USING ERRCODE = 'PT503'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('report-target:' || p_kind || ':' || p_target_id, 0));
    IF (SELECT count(*) FROM public.report_cases WHERE reporter = caller AND created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= limits.reporter_per_minute
      OR (SELECT count(*) FROM public.report_cases WHERE reporter = caller AND created_at > pg_catalog.clock_timestamp() - interval '1 day') >= limits.reporter_per_day
      OR (SELECT count(*) FROM public.report_cases WHERE kind = p_kind AND target_id = p_target_id AND created_at > pg_catalog.clock_timestamp() - interval '1 minute') >= limits.target_per_minute
      OR (SELECT count(*) FROM public.report_cases WHERE kind = p_kind AND target_id = p_target_id AND created_at > pg_catalog.clock_timestamp() - interval '1 day') >= limits.target_per_day THEN
      RAISE EXCEPTION 'Report limit reached; try later' USING ERRCODE = 'PT429';
    END IF;
    IF p_kind = 'post' THEN SELECT author::text INTO target_owner FROM public.posts WHERE id::text = p_target_id;
    ELSIF p_kind = 'comment' THEN SELECT author::text INTO target_owner FROM public.comments WHERE id::text = p_target_id;
    ELSE SELECT uid::text INTO target_owner FROM public.profiles WHERE uid::text = p_target_id;
    END IF;
    IF target_owner IS NULL THEN RAISE EXCEPTION 'Report target unavailable' USING ERRCODE = 'PT404'; END IF;
    IF target_owner = caller::text THEN RAISE EXCEPTION 'Cannot report your own content' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.report_cases(reporter, request_id, kind, target_id, reported_uid, reason)
      VALUES (caller, p_request_id, p_kind, p_target_id, target_owner, trim(p_reason)) RETURNING * INTO existing;
  END IF;
  RETURN pg_catalog.jsonb_build_object('id', existing.id, 'request_id', existing.request_id, 'kind', existing.kind,
    'status', existing.status, 'version', existing.version, 'created_at', existing.created_at, 'updated_at', existing.updated_at);
END;
$function$;

CREATE FUNCTION public.my_report_receipts(p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = 'PT401'; END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', receipt.id, 'kind', receipt.kind,
    'status', receipt.status, 'version', receipt.version, 'created_at', receipt.created_at, 'updated_at', receipt.updated_at)
    ORDER BY receipt.created_at DESC, receipt.id DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.report_cases WHERE reporter = auth.uid()
      AND (p_before IS NULL OR (created_at, id) < (p_before, p_before_id)) ORDER BY created_at DESC, id DESC LIMIT 50) AS receipt);
END;
$function$;

CREATE FUNCTION public.can_review_reports()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.report_moderators WHERE uid = auth.uid() AND enabled);
$function$;

CREATE FUNCTION public.moderation_queue(p_status text DEFAULT NULL, p_before timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.can_review_reports() THEN RAISE EXCEPTION 'Moderator access required' USING ERRCODE = 'PT403'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('received','under_review','action_taken','no_action','closed') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE = '22023';
  END IF;
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'Invalid cursor' USING ERRCODE = '22023'; END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(receipt) ORDER BY receipt.created_at DESC, receipt.id DESC), '[]'::jsonb)
    FROM (SELECT id, kind, target_id, reason, status, version, created_at, updated_at FROM public.report_cases
      WHERE (p_status IS NULL OR status = p_status) AND (p_before IS NULL OR (created_at, id) < (p_before, p_before_id))
      ORDER BY created_at DESC, id DESC LIMIT 50) AS receipt);
END;
$function$;

CREATE FUNCTION public.report_decision_history(p_id uuid, p_before_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.can_review_reports() THEN RAISE EXCEPTION 'Moderator access required' USING ERRCODE = 'PT403'; END IF;
  IF p_id IS NULL OR p_before_version < 1 THEN RAISE EXCEPTION 'Invalid history cursor' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.report_cases WHERE id = p_id) THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE = 'PT404'; END IF;
  RETURN (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(action) ORDER BY action.previous_version DESC), '[]'::jsonb)
    FROM (SELECT id, actor, from_status, to_status, previous_version, note, created_at FROM public.report_case_actions
      WHERE case_id = p_id AND (p_before_version IS NULL OR previous_version < p_before_version)
      ORDER BY previous_version DESC LIMIT 50) AS action);
END;
$function$;

CREATE FUNCTION public.review_report(p_id uuid, p_version integer, p_status text, p_note text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  current_case public.report_cases%ROWTYPE;
  prior_action public.report_case_actions%ROWTYPE;
  caller uuid := auth.uid();
BEGIN
  IF NOT public.can_review_reports() THEN RAISE EXCEPTION 'Moderator access required' USING ERRCODE = 'PT403'; END IF;
  IF p_id IS NULL OR p_request_id IS NULL OR p_version IS NULL OR p_version < 1 OR p_note IS NULL
    OR length(trim(p_note)) NOT BETWEEN 1 AND 2000 OR p_status IS NULL THEN
    RAISE EXCEPTION 'Decision and evidence note required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('review:' || caller::text, 0));
  SELECT * INTO prior_action FROM public.report_case_actions WHERE actor = caller AND request_id = p_request_id;
  IF FOUND THEN
    IF prior_action.case_id <> p_id OR prior_action.previous_version <> p_version OR prior_action.to_status <> p_status OR prior_action.note <> trim(p_note) THEN
      RAISE EXCEPTION 'Decision request conflict' USING ERRCODE = 'PT409';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', p_id, 'status', prior_action.to_status, 'version', prior_action.previous_version + 1, 'duplicate', true);
  END IF;
  SELECT * INTO current_case FROM public.report_cases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE = 'PT404'; END IF;
  IF current_case.version <> p_version THEN RAISE EXCEPTION 'Report changed; refresh before deciding' USING ERRCODE = 'PT409'; END IF;
  IF NOT ((current_case.status IN ('received','closed') AND p_status = 'under_review')
    OR (current_case.status = 'under_review' AND p_status IN ('action_taken','no_action'))
    OR (current_case.status IN ('action_taken','no_action') AND p_status = 'closed')) THEN
    RAISE EXCEPTION 'Invalid report transition' USING ERRCODE = '22023';
  END IF;
  UPDATE public.report_cases SET status = p_status, version = version + 1, updated_at = pg_catalog.clock_timestamp() WHERE id = p_id;
  INSERT INTO public.report_case_actions(case_id, actor, request_id, from_status, to_status, previous_version, note)
    VALUES (p_id, caller, p_request_id, current_case.status, p_status, p_version, trim(p_note));
  RETURN pg_catalog.jsonb_build_object('id', p_id, 'status', p_status, 'version', p_version + 1, 'duplicate', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_report(uuid,text,text,text), public.my_report_receipts(timestamptz,uuid),
  public.can_review_reports(), public.moderation_queue(text,timestamptz,uuid), public.report_decision_history(uuid,integer), public.review_report(uuid,integer,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_report(uuid,text,text,text), public.my_report_receipts(timestamptz,uuid),
  public.can_review_reports(), public.moderation_queue(text,timestamptz,uuid), public.report_decision_history(uuid,integer), public.review_report(uuid,integer,text,text,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;