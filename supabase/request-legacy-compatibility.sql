BEGIN;

LOCK TABLE public.requests IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
      WHERE schemaname='public' AND tablename='requests') IS DISTINCT FROM
      ARRAY['requests_accept','requests_ins','requests_read','requests_remove']::text[]
    OR (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.requests'::regclass) IS NOT TRUE
    OR pg_catalog.has_table_privilege('authenticated','public.requests','UPDATE,TRIGGER')
    OR pg_catalog.has_table_privilege('anon','public.requests','SELECT,INSERT,UPDATE,DELETE,TRIGGER')
    OR pg_catalog.has_any_column_privilege('anon','public.requests','SELECT,INSERT,UPDATE,REFERENCES')
    OR NOT pg_catalog.has_column_privilege('authenticated','public.requests','status','UPDATE') THEN
    RAISE EXCEPTION 'Reviewed request-actions baseline required' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='requests'
    AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[] AND (
      (policyname='requests_read' AND cmd='SELECT' AND qual='(((auth.uid())::text = from_uid) OR ((auth.uid())::text = to_uid))' AND with_check IS NULL)
      OR (policyname='requests_ins' AND cmd='INSERT' AND qual IS NULL
        AND with_check='(((auth.uid())::text = from_uid) AND (from_uid <> to_uid) AND (status = ''pending''::text) AND (id = ((from_uid || ''__''::text) || to_uid)))')
      OR (policyname='requests_accept' AND cmd='UPDATE' AND qual='((auth.uid())::text = to_uid)'
        AND with_check='(((auth.uid())::text = to_uid) AND (status = ''accepted''::text))')
      OR (policyname='requests_remove' AND cmd='DELETE' AND qual='(((auth.uid())::text = from_uid) OR ((auth.uid())::text = to_uid))' AND with_check IS NULL)
    ))<>4 THEN
    RAISE EXCEPTION 'Request policies differ from the reviewed baseline' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.guard_legacy_request_retry()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $function$
DECLARE actor_id text:=auth.uid()::text;
BEGIN
  IF actor_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.from_uid IS DISTINCT FROM OLD.from_uid
    OR NEW.to_uid IS DISTINCT FROM OLD.to_uid OR NEW.ts IS DISTINCT FROM OLD.ts THEN
    RAISE EXCEPTION 'Request identity is immutable' USING ERRCODE='42501';
  END IF;
  IF actor_id=OLD.from_uid AND NEW.status='pending' THEN RETURN OLD; END IF;
  IF actor_id=OLD.to_uid AND OLD.status IN ('pending','accepted') AND NEW.status='accepted' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Request state change is not allowed' USING ERRCODE='42501';
END;
$function$;

CREATE TRIGGER guard_legacy_request_retry BEFORE UPDATE ON public.requests
FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_request_retry();

CREATE POLICY requests_retry ON public.requests FOR UPDATE TO authenticated
  USING (auth.uid()::text=from_uid) WITH CHECK (auth.uid()::text=from_uid);
GRANT UPDATE (id,from_uid,to_uid) ON public.requests TO authenticated;
REVOKE ALL ON FUNCTION public.guard_legacy_request_retry() FROM PUBLIC,anon,authenticated,service_role;

DO $permissions$
DECLARE column_name text; role_name text;
BEGIN
  IF pg_catalog.has_table_privilege('authenticated','public.requests','UPDATE,TRIGGER')
    OR pg_catalog.has_column_privilege('authenticated','public.requests','ts','UPDATE')
    OR pg_catalog.has_table_privilege('anon','public.requests','SELECT,INSERT,UPDATE,DELETE,TRIGGER')
    OR pg_catalog.has_any_column_privilege('anon','public.requests','SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unexpected request compatibility permissions' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.requests'::regclass
      AND tgname='guard_legacy_request_retry' AND tgfoid='public.guard_legacy_request_retry()'::regprocedure
      AND tgenabled='O' AND tgtype=19 AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='requests'
      AND policyname='requests_retry' AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[] AND cmd='UPDATE'
      AND qual='((auth.uid())::text = from_uid)' AND with_check='((auth.uid())::text = from_uid)') THEN
    RAISE EXCEPTION 'Request compatibility guard is missing or changed' USING ERRCODE='55000';
  END IF;
  FOREACH column_name IN ARRAY ARRAY['id','from_uid','to_uid','status'] LOOP
    IF NOT pg_catalog.has_column_privilege('authenticated','public.requests',column_name,'UPDATE') THEN
      RAISE EXCEPTION 'Missing compatibility column permission' USING ERRCODE='42501';
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF pg_catalog.has_function_privilege(role_name,'public.guard_legacy_request_retry()','EXECUTE') THEN
      RAISE EXCEPTION 'Request trigger helper must not be callable' USING ERRCODE='42501';
    END IF;
  END LOOP;
END;
$permissions$;

COMMIT;