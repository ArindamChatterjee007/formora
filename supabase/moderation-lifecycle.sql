BEGIN;

CREATE TABLE public.report_lifecycle_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  execution_enabled boolean NOT NULL DEFAULT false,
  retention_approved boolean NOT NULL DEFAULT false,
  retention_days integer,
  retention_basis text,
  retention_policy_ref uuid,
  erasure_approved boolean NOT NULL DEFAULT false,
  erasure_procedure_ref uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((retention_approved AND retention_days IS NOT NULL AND retention_days > 0
    AND retention_basis IS NOT NULL AND retention_basis = 'closed_updated_at' AND retention_policy_ref IS NOT NULL)
    OR (NOT retention_approved AND retention_days IS NULL AND retention_basis IS NULL AND retention_policy_ref IS NULL)),
  CHECK (erasure_approved = (erasure_procedure_ref IS NOT NULL)),
  CHECK (NOT execution_enabled OR retention_approved OR erasure_approved)
);
INSERT INTO public.report_lifecycle_policy(singleton) VALUES (true);

CREATE TABLE public.report_evidence_holds (
  case_id uuid NOT NULL REFERENCES public.report_cases(id) ON DELETE RESTRICT,
  hold_ref uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (case_id, hold_ref)
);

CREATE TABLE public.report_deletion_audit (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN ('retention', 'account_reporter', 'account_subject', 'account_both')),
  deleted_cases integer NOT NULL CHECK (deleted_cases BETWEEN 1 AND 100),
  deleted_actions integer NOT NULL CHECK (deleted_actions BETWEEN 0 AND 1000),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  executed_role text NOT NULL CHECK (executed_role = 'service_role'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX report_lifecycle_closed_cutoff ON public.report_cases(updated_at, id) WHERE status = 'closed';
CREATE INDEX report_lifecycle_reported_subject ON public.report_cases(reported_uid, id);
CREATE INDEX report_lifecycle_action_case ON public.report_case_actions(case_id);

ALTER TABLE public.report_lifecycle_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_evidence_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_deletion_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_lifecycle_policy, public.report_evidence_holds, public.report_deletion_audit
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.report_lifecycle_policy, public.report_evidence_holds, public.report_deletion_audit TO service_role;

CREATE FUNCTION public.report_lifecycle_require_service()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF NOT (pg_catalog.current_setting('role', true) = 'service_role'
    OR (pg_catalog.current_setting('role', true) = 'none' AND session_user = 'service_role')) THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.configure_report_lifecycle(p_execution_enabled boolean, p_retention_approved boolean,
  p_retention_days integer, p_retention_basis text, p_retention_policy_ref uuid,
  p_erasure_approved boolean, p_erasure_procedure_ref uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  policy public.report_lifecycle_policy%ROWTYPE;
BEGIN
  PERFORM public.report_lifecycle_require_service();
  UPDATE public.report_lifecycle_policy SET execution_enabled = p_execution_enabled,
    retention_approved = p_retention_approved, retention_days = p_retention_days,
    retention_basis = p_retention_basis, retention_policy_ref = p_retention_policy_ref,
    erasure_approved = p_erasure_approved, erasure_procedure_ref = p_erasure_procedure_ref,
    revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
    WHERE singleton RETURNING * INTO policy;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle policy missing' USING ERRCODE = 'PT403'; END IF;
  RETURN pg_catalog.to_jsonb(policy);
END;
$function$;

CREATE FUNCTION public.set_report_evidence_hold(p_case_id uuid, p_hold_ref uuid, p_held boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  PERFORM public.report_lifecycle_require_service();
  IF p_case_id IS NULL OR p_hold_ref IS NULL OR p_held IS NULL THEN
    RAISE EXCEPTION 'Case, opaque hold reference and hold state required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.report_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE = 'PT404'; END IF;
  IF p_held THEN
    INSERT INTO public.report_evidence_holds(case_id, hold_ref) VALUES (p_case_id, p_hold_ref) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.report_evidence_holds WHERE case_id = p_case_id AND hold_ref = p_hold_ref;
  END IF;
  RETURN pg_catalog.jsonb_build_object('held', EXISTS (SELECT 1 FROM public.report_evidence_holds WHERE case_id = p_case_id));
END;
$function$;

CREATE FUNCTION public.report_lifecycle_context(p_operation text, p_cutoff timestamptz,
  p_account_id uuid, p_legacy_subject_ids text[])
RETURNS TABLE (policy_revision integer, execution_allowed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  policy public.report_lifecycle_policy%ROWTYPE;
BEGIN
  PERFORM public.report_lifecycle_require_service();
  IF p_operation IS NULL OR p_operation NOT IN ('retention', 'account_reporter', 'account_subject', 'account_both')
    OR p_legacy_subject_ids IS NULL OR pg_catalog.cardinality(p_legacy_subject_ids) > 16
    OR (pg_catalog.cardinality(p_legacy_subject_ids) > 0 AND pg_catalog.array_ndims(p_legacy_subject_ids) <> 1)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_legacy_subject_ids) AS alias(value)
      WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 255 OR value <> trim(value) OR value = p_account_id::text)
    OR (SELECT count(DISTINCT value) FROM pg_catalog.unnest(p_legacy_subject_ids) AS alias(value)) <> pg_catalog.cardinality(p_legacy_subject_ids) THEN
    RAISE EXCEPTION 'Invalid lifecycle scope' USING ERRCODE = '22023';
  END IF;
  IF p_operation = 'retention' THEN
    IF p_cutoff IS NULL OR NOT pg_catalog.isfinite(p_cutoff) OR p_cutoff > pg_catalog.transaction_timestamp()
      OR p_account_id IS NOT NULL OR pg_catalog.cardinality(p_legacy_subject_ids) <> 0 THEN
      RAISE EXCEPTION 'Explicit finite past cutoff required for retention only' USING ERRCODE = '22023';
    END IF;
  ELSIF p_account_id IS NULL OR p_cutoff IS NOT NULL
    OR (p_operation = 'account_reporter' AND pg_catalog.cardinality(p_legacy_subject_ids) <> 0) THEN
    RAISE EXCEPTION 'Explicit account and applicable subject aliases required for erasure' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO policy FROM public.report_lifecycle_policy WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle policy missing' USING ERRCODE = 'PT403'; END IF;
  policy_revision := policy.revision;
  execution_allowed := coalesce(policy.execution_enabled AND (
    (p_operation = 'retention' AND policy.retention_approved
      AND extract(epoch FROM pg_catalog.transaction_timestamp()) - extract(epoch FROM p_cutoff) >= policy.retention_days::numeric * 86400)
    OR (p_operation IN ('account_reporter', 'account_subject', 'account_both') AND policy.erasure_approved)), false);
  RETURN NEXT;
END;
$function$;

CREATE FUNCTION public.report_lifecycle_candidates(p_operation text, p_cutoff timestamptz,
  p_account_id uuid, p_legacy_subject_ids text[], p_case_ids uuid[], p_limit integer)
RETURNS TABLE (id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  SELECT report.id FROM public.report_cases AS report
    WHERE (p_case_ids IS NULL OR report.id = ANY(p_case_ids))
      AND ((p_operation = 'retention' AND report.status = 'closed' AND report.updated_at < p_cutoff)
        OR (p_operation IN ('account_reporter', 'account_both') AND report.reporter = p_account_id)
        OR (p_operation IN ('account_subject', 'account_both')
          AND report.reported_uid = ANY(ARRAY[p_account_id::text] || p_legacy_subject_ids)))
      AND NOT EXISTS (SELECT 1 FROM public.report_evidence_holds AS held WHERE held.case_id = report.id)
    ORDER BY report.updated_at, report.id LIMIT p_limit;
$function$;

CREATE FUNCTION public.preview_report_lifecycle(p_operation text, p_cutoff timestamptz DEFAULT NULL,
  p_account_id uuid DEFAULT NULL, p_legacy_subject_ids text[] DEFAULT '{}'::text[], p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  lifecycle record;
  candidate_ids uuid[];
BEGIN
  SELECT * INTO lifecycle FROM public.report_lifecycle_context(p_operation, p_cutoff, p_account_id, p_legacy_subject_ids);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Preview limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  candidate_ids := ARRAY(SELECT id FROM public.report_lifecycle_candidates(
    p_operation, p_cutoff, p_account_id, p_legacy_subject_ids, NULL, p_limit + 1));
  RETURN pg_catalog.jsonb_build_object('dry_run', true, 'policy_revision', lifecycle.policy_revision,
    'policy_allows_execution', lifecycle.execution_allowed, 'case_ids', candidate_ids[1:p_limit],
    'returned_cases', least(pg_catalog.cardinality(candidate_ids), p_limit),
    'has_more', pg_catalog.cardinality(candidate_ids) > p_limit, 'holds_excluded', true);
END;
$function$;

CREATE FUNCTION public.purge_report_lifecycle(p_operation text, p_case_ids uuid[], p_cutoff timestamptz DEFAULT NULL,
  p_account_id uuid DEFAULT NULL, p_legacy_subject_ids text[] DEFAULT '{}'::text[], p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  lifecycle record;
  candidate_ids uuid[];
  action_count integer;
  deleted_cases integer := 0;
  deleted_actions integer := 0;
  audit_id uuid;
BEGIN
  SELECT * INTO lifecycle FROM public.report_lifecycle_context(p_operation, p_cutoff, p_account_id, p_legacy_subject_ids);
  IF p_case_ids IS NULL OR pg_catalog.cardinality(p_case_ids) NOT BETWEEN 1 AND 100
    OR pg_catalog.array_ndims(p_case_ids) <> 1 OR p_dry_run IS NULL
    OR (SELECT count(DISTINCT value) FROM pg_catalog.unnest(p_case_ids) AS requested(value)) <> pg_catalog.cardinality(p_case_ids) THEN
    RAISE EXCEPTION 'One to 100 distinct non-null case IDs and explicit dry-run state required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND NOT lifecycle.execution_allowed THEN
    RAISE EXCEPTION 'Lifecycle execution disabled or approved policy does not permit this operation/cutoff' USING ERRCODE = 'PT403';
  END IF;
  IF NOT p_dry_run THEN
    PERFORM 1 FROM public.report_cases WHERE id = ANY(p_case_ids) ORDER BY id FOR UPDATE;
  END IF;
  candidate_ids := ARRAY(SELECT id FROM public.report_lifecycle_candidates(
    p_operation, p_cutoff, p_account_id, p_legacy_subject_ids, p_case_ids, 100));
  SELECT count(*) INTO action_count FROM (
    SELECT id FROM public.report_case_actions WHERE case_id = ANY(candidate_ids) LIMIT 1001
  ) AS bounded_actions;
  IF action_count > 1000 THEN
    RAISE EXCEPTION 'Batch exceeds 1000 actions; reduce scope or request a separately reviewed procedure' USING ERRCODE = 'PT413';
  END IF;
  IF NOT p_dry_run AND pg_catalog.cardinality(candidate_ids) > 0 THEN
    DELETE FROM public.report_case_actions WHERE case_id = ANY(candidate_ids);
    GET DIAGNOSTICS deleted_actions = ROW_COUNT;
    DELETE FROM public.report_cases WHERE id = ANY(candidate_ids);
    GET DIAGNOSTICS deleted_cases = ROW_COUNT;
    IF deleted_cases <> pg_catalog.cardinality(candidate_ids) OR deleted_actions <> action_count THEN
      RAISE EXCEPTION 'Lifecycle candidates changed; transaction aborted' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.report_deletion_audit(operation, deleted_cases, deleted_actions, policy_revision, executed_role)
      VALUES (p_operation, deleted_cases, deleted_actions, lifecycle.policy_revision, 'service_role') RETURNING id INTO audit_id;
  END IF;
  RETURN pg_catalog.jsonb_build_object('dry_run', p_dry_run, 'policy_revision', lifecycle.policy_revision,
    'policy_allows_execution', lifecycle.execution_allowed, 'eligible_cases', pg_catalog.cardinality(candidate_ids),
    'eligible_actions', action_count, 'skipped_cases', pg_catalog.cardinality(p_case_ids) - pg_catalog.cardinality(candidate_ids),
    'deleted_cases', deleted_cases, 'deleted_actions', deleted_actions, 'audit_id', audit_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.report_lifecycle_require_service(),
  public.configure_report_lifecycle(boolean,boolean,integer,text,uuid,boolean,uuid),
  public.set_report_evidence_hold(uuid,uuid,boolean),
  public.report_lifecycle_context(text,timestamptz,uuid,text[]),
  public.report_lifecycle_candidates(text,timestamptz,uuid,text[],uuid[],integer),
  public.preview_report_lifecycle(text,timestamptz,uuid,text[],integer),
  public.purge_report_lifecycle(text,uuid[],timestamptz,uuid,text[],boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.configure_report_lifecycle(boolean,boolean,integer,text,uuid,boolean,uuid),
  public.set_report_evidence_hold(uuid,uuid,boolean),
  public.preview_report_lifecycle(text,timestamptz,uuid,text[],integer),
  public.purge_report_lifecycle(text,uuid[],timestamptz,uuid,text[],boolean) TO service_role;

DO $account_rights_report_hold_bridge$
BEGIN
  IF pg_catalog.to_regprocedure('public.account_rights_install_report_hold_history()') IS NOT NULL THEN
    PERFORM public.account_rights_install_report_hold_history();
  END IF;
END;
$account_rights_report_hold_bridge$;

COMMIT;