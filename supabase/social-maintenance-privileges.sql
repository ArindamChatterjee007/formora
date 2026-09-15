BEGIN;

LOCK TABLE public.requests,public.notifications IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
      WHERE schemaname='public' AND tablename='requests') IS DISTINCT FROM
      ARRAY['requests_accept','requests_ins','requests_read','requests_remove','requests_retry']::text[]
    OR (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
      WHERE schemaname='public' AND tablename='notifications') IS DISTINCT FROM ARRAY['notifs_read','notifs_upd']::text[] THEN
    RAISE EXCEPTION 'Installed request compatibility and notification admission required' USING ERRCODE='55000';
  END IF;
END;
$preflight$;

REVOKE TRIGGER,TRUNCATE,MAINTAIN ON public.requests,public.notifications FROM PUBLIC,anon,authenticated;

DO $permissions$
BEGIN
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated']) AS role_name
    CROSS JOIN unnest(ARRAY['public.requests','public.notifications']) AS table_name
    WHERE pg_catalog.has_table_privilege(role_name,table_name,'TRIGGER,TRUNCATE,MAINTAIN')) THEN
    RAISE EXCEPTION 'Unexpected effective social maintenance privileges' USING ERRCODE='42501';
  END IF;
END;
$permissions$;

COMMIT;