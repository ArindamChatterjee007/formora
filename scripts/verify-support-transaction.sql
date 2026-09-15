DO $verification$
DECLARE
  owner_id uuid := pg_catalog.gen_random_uuid();
  stranger_id uuid := pg_catalog.gen_random_uuid();
  staff_id uuid := pg_catalog.gen_random_uuid();
  request_id uuid := pg_catalog.gen_random_uuid();
  reply_id uuid := pg_catalog.gen_random_uuid();
  policy_reference uuid := pg_catalog.gen_random_uuid();
  receipt jsonb;
  replay jsonb;
  view_result jsonb;
  before_state jsonb := '{}'::jsonb;
  after_state jsonb := '{}'::jsonb;
  table_names constant text[] := ARRAY['support_policy', 'support_limits', 'support_staff',
    'support_cases', 'support_messages', 'support_case_actions'];
  table_name text;
  table_digest text;
  intake_enabled boolean;
  checks text[] := ARRAY[]::text[];
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
  PERFORM pg_catalog.set_config('statement_timeout', '15s', true);
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Support verification requires the authorized database operator';
  END IF;
  IF (SELECT collection_enabled FROM public.support_policy WHERE singleton) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Support verification requires intake to remain closed';
  END IF;
  FOREACH table_name IN ARRAY table_names LOOP
    EXECUTE pg_catalog.format('SELECT md5(coalesce(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text), ''[]''::jsonb)::text) FROM public.%I AS entry', table_name)
      INTO table_digest;
    before_state := before_state || pg_catalog.jsonb_build_object(table_name, table_digest);
  END LOOP;

  BEGIN
    PERFORM pg_catalog.set_config('role', 'service_role', true);
    PERFORM public.configure_support_policy(true, NULL, NULL, false, NULL, false, policy_reference);
    INSERT INTO public.support_staff(uid) VALUES (staff_id);
    PERFORM pg_catalog.set_config('role', 'anon', true);
    BEGIN
      PERFORM 1 FROM public.support_cases;
      RAISE EXCEPTION 'Anonymous direct support access was permitted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.support_settings();
      RAISE EXCEPTION 'Anonymous support RPC access was permitted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    checks := pg_catalog.array_append(checks, 'Anonymous table and RPC access denied');

    PERFORM pg_catalog.set_config('role', 'authenticated', true);
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', owner_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
    IF auth.uid() IS DISTINCT FROM owner_id OR current_user <> 'authenticated' THEN
      RAISE EXCEPTION 'Member role or auth.uid did not match the synthetic identity';
    END IF;
    BEGIN
      PERFORM 1 FROM public.support_cases;
      RAISE EXCEPTION 'Member direct support access was permitted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    receipt := public.submit_support_case(request_id, 'Synthetic QAT request', 'Synthetic request body', NULL);
    replay := public.submit_support_case(request_id, 'Synthetic QAT request', 'Synthetic request body', NULL);
    IF receipt->>'duplicate' IS DISTINCT FROM 'false' OR replay->>'duplicate' IS DISTINCT FROM 'true'
      OR receipt->>'id' IS NULL OR replay->>'id' IS DISTINCT FROM receipt->>'id'
      OR replay->>'version' IS DISTINCT FROM '1' OR receipt ? 'body' OR receipt ? 'subject' THEN
      RAISE EXCEPTION 'Receipt replay or private response contract failed';
    END IF;
    BEGIN
      PERFORM public.submit_support_case(request_id, 'Synthetic QAT request', 'Changed request body', NULL);
      RAISE EXCEPTION 'Changed request payload was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
    checks := pg_catalog.array_append(checks, 'Owner receipt replay is idempotent and changed payload conflicts');

    PERFORM pg_catalog.set_config('request.jwt.claim.sub', stranger_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', stranger_id, 'role', 'authenticated')::text, true);
    IF public.my_support_cases() IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'Another member received the owner case';
    END IF;
    BEGIN
      PERFORM public.support_thread((receipt->>'id')::uuid);
      RAISE EXCEPTION 'Another member received the owner thread';
    EXCEPTION WHEN SQLSTATE 'PT404' THEN NULL;
    END;
    BEGIN
      PERFORM public.add_support_reply((receipt->>'id')::uuid, pg_catalog.gen_random_uuid(), 'Unauthorized reply', NULL);
      RAISE EXCEPTION 'Another member changed the owner thread';
    EXCEPTION WHEN SQLSTATE 'PT404' THEN NULL;
    END;
    BEGIN
      PERFORM public.support_queue();
      RAISE EXCEPTION 'Ordinary member accessed the staff queue';
    EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;
    END;
    checks := pg_catalog.array_append(checks, 'Other-member thread writes and staff queue access denied');

    PERFORM pg_catalog.set_config('request.jwt.claim.sub', staff_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', staff_id, 'role', 'authenticated')::text, true);
    replay := public.staff_update_support_case((receipt->>'id')::uuid, 1, 'waiting_customer',
      'Synthetic public staff reply', 'Synthetic internal staff note', pg_catalog.gen_random_uuid());
    IF replay->>'version' IS DISTINCT FROM '2' OR replay->>'status' IS DISTINCT FROM 'waiting_customer' THEN
      RAISE EXCEPTION 'Staff decision did not advance the case';
    END IF;
    view_result := public.support_thread((receipt->>'id')::uuid);
    IF pg_catalog.jsonb_array_length(view_result->'messages') IS DISTINCT FROM 3
      OR view_result#>>'{case,owner}' IS DISTINCT FROM owner_id::text THEN
      RAISE EXCEPTION 'Staff thread did not contain the complete case';
    END IF;
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', owner_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
    view_result := public.support_thread((receipt->>'id')::uuid);
    IF pg_catalog.jsonb_array_length(view_result->'messages') IS DISTINCT FROM 2
      OR view_result#>'{case,owner}' IS DISTINCT FROM 'null'::jsonb
      OR view_result::text LIKE '%Synthetic internal staff note%'
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(view_result->'messages') AS message
        WHERE message->>'visibility' IS DISTINCT FROM 'thread' OR message->'author' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'Member thread exposed an internal note or identity';
    END IF;
    checks := pg_catalog.array_append(checks, 'Staff notes and identities stay out of the member projection');

    replay := public.add_support_reply((receipt->>'id')::uuid, reply_id, 'Synthetic member follow-up', NULL);
    IF replay->>'version' IS DISTINCT FROM '3' OR replay->>'status' IS DISTINCT FROM 'in_progress'
      OR replay->>'duplicate' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'Member reply did not advance waiting_customer once';
    END IF;
    replay := public.add_support_reply((receipt->>'id')::uuid, reply_id, 'Synthetic member follow-up', NULL);
    IF replay->>'version' IS DISTINCT FROM '3' OR replay->>'duplicate' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Member reply replay duplicated the action';
    END IF;
    checks := pg_catalog.array_append(checks, 'Member reply and replay preserve one versioned action');

    PERFORM pg_catalog.set_config('request.jwt.claim.sub', staff_id::text, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', staff_id, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.staff_update_support_case((receipt->>'id')::uuid, 2, 'closed', NULL, NULL, pg_catalog.gen_random_uuid());
      RAISE EXCEPTION 'Stale staff version was accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
    replay := public.staff_update_support_case((receipt->>'id')::uuid, 3, 'closed', NULL, NULL, pg_catalog.gen_random_uuid());
    IF replay->>'version' IS DISTINCT FROM '4' OR replay->>'status' IS DISTINCT FROM 'closed'
      OR pg_catalog.jsonb_array_length(public.support_case_history((receipt->>'id')::uuid)) IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'Staff closure or immutable history count failed';
    END IF;
    checks := pg_catalog.array_append(checks, 'Stale staff decisions conflict and closure preserves history');
    RAISE EXCEPTION 'Rollback synthetic support verification' USING ERRCODE = 'PZ001';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;

  FOREACH table_name IN ARRAY table_names LOOP
    EXECUTE pg_catalog.format('SELECT md5(coalesce(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text), ''[]''::jsonb)::text) FROM public.%I AS entry', table_name)
      INTO table_digest;
    after_state := after_state || pg_catalog.jsonb_build_object(table_name, table_digest);
  END LOOP;
  SELECT collection_enabled INTO intake_enabled FROM public.support_policy WHERE singleton;
  IF after_state IS DISTINCT FROM before_state OR pg_catalog.cardinality(checks) <> 6
    OR intake_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Support verification did not restore all six tables or complete every check';
  END IF;
  PERFORM pg_catalog.set_config('formora.support_verification', pg_catalog.jsonb_build_object(
    'result', 'passed', 'checks', checks, 'supportTablesUnchanged', pg_catalog.cardinality(table_names), 'intakeEnabled', intake_enabled,
    'scope', 'Hosted SQL role simulation with rolled-back synthetic fixtures; not HTTP, real authentication, concurrency or UI acceptance')::text, true);
END;
$verification$;
SELECT pg_catalog.current_setting('formora.support_verification')::jsonb AS verification;