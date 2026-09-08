BEGIN;

DO $preflight$
BEGIN
  IF (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = 'public.get_state()'::regprocedure) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Request privacy requires the reviewed security-invoker feed RPC' USING ERRCODE = '55000';
  END IF;
  IF (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'requests') IS DISTINCT FROM ARRAY['requests_ins', 'requests_read']::text[] THEN
    RAISE EXCEPTION 'Request actions require the reviewed core policy baseline' USING ERRCODE = '55000';
  END IF;
  IF (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.requests'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION 'Request row security must already be enabled' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.requests WHERE id <> from_uid || '__' || to_uid OR from_uid = to_uid
    OR from_uid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR to_uid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR status NOT IN ('pending', 'accepted')) THEN
    RAISE EXCEPTION 'Legacy request rows require explicit reconciliation before this migration' USING ERRCODE = '55000';
  END IF;
END;
$preflight$;

DROP POLICY requests_read ON public.requests;
CREATE POLICY requests_read ON public.requests FOR SELECT TO authenticated
  USING (auth.uid()::text = from_uid OR auth.uid()::text = to_uid);
DROP POLICY requests_ins ON public.requests;
CREATE POLICY requests_ins ON public.requests FOR INSERT TO authenticated
  WITH CHECK (auth.uid()::text = from_uid AND from_uid <> to_uid AND status = 'pending'
    AND id = from_uid || '__' || to_uid);
CREATE POLICY requests_accept ON public.requests FOR UPDATE TO authenticated
  USING (auth.uid()::text = to_uid)
  WITH CHECK (auth.uid()::text = to_uid AND status = 'accepted');
CREATE POLICY requests_remove ON public.requests FOR DELETE TO authenticated
  USING (auth.uid()::text = from_uid OR auth.uid()::text = to_uid);

REVOKE UPDATE ON public.requests FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (id, from_uid, to_uid, status, ts) ON public.requests FROM PUBLIC, anon, authenticated;
GRANT UPDATE (status), DELETE ON public.requests TO authenticated;

DO $permissions$
DECLARE column_name text;
BEGIN
  IF pg_catalog.has_table_privilege('anon', 'public.requests', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.requests', 'UPDATE')
    OR NOT pg_catalog.has_column_privilege('authenticated', 'public.requests', 'status', 'UPDATE')
    OR NOT pg_catalog.has_table_privilege('authenticated', 'public.requests', 'DELETE') THEN
    RAISE EXCEPTION 'Unexpected effective request action privileges' USING ERRCODE = '42501';
  END IF;
  FOREACH column_name IN ARRAY ARRAY['id', 'from_uid', 'to_uid', 'ts'] LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.requests', column_name, 'UPDATE')
      OR pg_catalog.has_column_privilege('anon', 'public.requests', column_name, 'UPDATE') THEN
      RAISE EXCEPTION 'Request identity columns must remain immutable to members' USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$permissions$;

COMMIT;