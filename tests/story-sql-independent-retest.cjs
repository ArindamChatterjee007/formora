'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire, wrap } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');

const WORKSPACE = path.resolve(__dirname, '..');
const RUNNER = path.join(WORKSPACE, 'scripts/verify-postgres-concurrency.cjs');
const SQL = 'supabase/story-interactions.sql';
const SELF = 'tests/story-sql-independent-retest.cjs';
const AUGMENTATION = '\nmodule.exports = { ...module.exports, LocalCluster, fingerprint, IDS, sqlLiteral, resetStories, seedStory, storyLockKey, errorDetails };\n';
const runnerSource = fs.readFileSync(RUNNER, 'utf8');
const runnerModule = { exports: {} };
new vm.Script(wrap(runnerSource + AUGMENTATION), { filename: RUNNER }).runInThisContext()(
  runnerModule.exports, createRequire(RUNNER), runnerModule, RUNNER, path.dirname(RUNNER));
const harness = runnerModule.exports;
const { LocalCluster, IDS, sqlLiteral, resetStories, errorDetails } = harness;
const migration = fs.readFileSync(path.join(WORKSPACE, SQL), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = filename => hash(fs.readFileSync(path.join(WORKSPACE, filename)));

function sourceHashes() {
  const original = harness.fingerprint();
  return { ...Object.fromEntries(Object.entries(original.files).map(([filename, entry]) => [filename, entry.sha256])),
    'supabase/security.sql': fileHash('supabase/security.sql'), [SELF]: fileHash(SELF) };
}

function statement(name) {
  assert.ok(['story_feed', '_story_shape', 'resolve_story_reply_context', 'report_story_content'].includes(name));
  const expression = new RegExp('CREATE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\$function\\$;', 'g');
  const matches = migration.match(expression);
  assert.equal(matches?.length, 1, 'Expected one canonical function: ' + name);
  return matches[0];
}

function replaceExactly(source, oldText, newText) {
  assert.equal(source.split(oldText).length, 2, 'Fixture mutation must match exactly once');
  return source.replace(oldText, newText);
}

async function replaceFunction(cluster, name, source = statement(name)) {
  await cluster.admin.query(replaceExactly(source, 'CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION '));
}

async function exactFunctions(cluster) {
  const names = ['story_feed', '_story_shape', 'resolve_story_reply_context', 'report_story_content'];
  const definitions = await cluster.observer.value(`(SELECT jsonb_object_agg(proname,jsonb_build_object(
    'body',prosrc,'definition',pg_get_functiondef(oid),'securityDefiner',prosecdef,'configuration',proconfig))
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (${names.map(sqlLiteral).join(',')}))`);
  return Object.fromEntries(names.map(name => {
    const actual = definitions[name];
    assert.equal(actual.body, statement(name).split('$function$')[1], name + ' must execute the exact source body');
    assert.equal(actual.securityDefiner, true);
    assert.deepEqual(actual.configuration, ['search_path=""']);
    return [name, { bodySha256: hash(actual.body), definitionSha256: hash(actual.definition), sourceBodyExact: true }];
  }));
}

function newArtifactDirectory(runId) {
  const root = path.join(WORKSPACE, 'dist');
  const parent = path.join(root, 'story-sql-retest');
  for (const directory of [root, parent]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const info = fs.lstatSync(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Artifact parent must be a real directory');
  }
  const directory = path.join(parent, 'run-' + runId);
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}

function validatePage(page) {
  assert.ok(page && Array.isArray(page.items));
  assert.ok(page.items.length <= 50);
  for (const item of page.items) {
    assert.ok(item && typeof item === 'object', 'Feed must never emit a null item');
    assert.match(item.id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof item.photo, 'string');
    assert.ok(Number.isFinite(Date.parse(item.created_at)));
  }
  if (page.next_cursor !== null) {
    assert.equal(page.items.length, 50);
    assert.equal(page.next_cursor.id, page.items[49].id);
    assert.equal(page.next_cursor.at, page.items[49].created_at);
    assert.match(page.next_cursor.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(page.next_cursor.at)));
  }
}

async function feedNullCase(cluster, context, mutant) {
  await resetStories(cluster);
  const identifiers = Array.from({ length: 53 }, () => randomUUID()).sort().reverse();
  const victim = identifiers[49];
  await cluster.admin.query(`INSERT INTO public.stories_v2(id,owner,kind,audience,created_at,expires_at)
    SELECT identity, '${IDS.subject}', 'photo','authenticated',statement_timestamp(),statement_timestamp()+interval '24 hours'
    FROM unnest(ARRAY[${identifiers.map(sqlLiteral).join(',')}]::uuid[]) AS fixture(identity)`);
  await cluster.admin.query(`INSERT INTO public.story_content SELECT id,
    'https://fixture.supabase.co/storage/v1/object/public/media/stories/${IDS.subject}/fixture.jpg' FROM public.stories_v2`);
  const feedBefore = await cluster.observer.value("pg_get_functiondef('public.story_feed(jsonb)'::regprocedure)");
  const originalCopy = replaceExactly(statement('_story_shape'), 'public._story_shape(', 'public.qa_original_story_shape(');
  await cluster.admin.query(originalCopy);
  await cluster.admin.query('REVOKE ALL ON FUNCTION public.qa_original_story_shape(uuid,uuid) FROM PUBLIC,anon,authenticated');
  await cluster.admin.query(`CREATE TABLE public.qa_shape_log(story_id uuid,eligible_before boolean,eligible_after boolean,result_null boolean)`);
  const override = `CREATE FUNCTION public._story_shape(p_id uuid,p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $function$
    DECLARE was_eligible boolean; projected jsonb;
    BEGIN
      was_eligible := public._story_eligible(p_id,p_actor);
      IF p_id = '${victim}'::uuid THEN
        UPDATE public.stories_v2 SET deleted_at=pg_catalog.clock_timestamp() WHERE id=p_id;
      END IF;
      projected := public.qa_original_story_shape(p_id,p_actor);
      INSERT INTO public.qa_shape_log VALUES(p_id,was_eligible,public._story_eligible(p_id,p_actor),projected IS NULL);
      RETURN projected;
    END;
    $function$;`;
  context.evidence.instrumentation = { scope: 'Disposable database only', helperOverride: override,
    copiedHelper: 'Canonical _story_shape body with only function name changed to qa_original_story_shape',
    mutation: 'Tombstone the eligible candidate ranked 50th immediately before executing the canonical shape body',
    actualFeedUnmodified: !mutant, externalConcurrencyClaim: false };
  try {
    await replaceFunction(cluster, '_story_shape', override);
    if (mutant) {
      await replaceFunction(cluster, 'story_feed', replaceExactly(statement('story_feed'), ' AND checked.payload IS NOT NULL', ''));
      context.evidence.omission = 'Only AND checked.payload IS NOT NULL removed from the fixture-installed story_feed';
    } else {
      assert.equal(await cluster.observer.value("pg_get_functiondef('public.story_feed(jsonb)'::regprocedure)"), feedBefore);
    }
    const first = await cluster.first.value('public.story_feed(NULL)');
    const callLog = await cluster.observer.value(`(SELECT jsonb_agg(to_jsonb(entry)) FROM public.qa_shape_log AS entry)`);
    const victimLog = callLog.filter(entry => entry.story_id === victim);
    assert.deepEqual(victimLog, [{ story_id: victim, eligible_before: true, eligible_after: false, result_null: true }]);
    assert.equal(new Set(callLog.map(entry => entry.story_id)).size, callLog.length, 'One checked shape per evaluated candidate');
    context.reproductionExecuted = true;
    context.evidence.firstPage = first;
    context.evidence.projection = { victim, rankBeforeMutation: 50, evaluatedCandidates: callLog.length,
      maximumCallsPerCandidate: 1, victimLog };
    if (mutant) {
      assert.throws(() => validatePage(first), { name: 'AssertionError' });
      assert.equal(first.items[49], null);
      assert.deepEqual(first.next_cursor, { at: null, id: null });
      context.evidence.expectedInvariantFailure = 'The same page assertion rejects a null 50th item and a null/null cursor';
      return;
    }
    validatePage(first);
    const second = await cluster.first.value(`public.story_feed(${sqlLiteral(JSON.stringify(first.next_cursor))}::jsonb)`);
    validatePage(second);
    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 2);
    assert.equal(second.next_cursor, null);
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), identifiers.filter(identifier => identifier !== victim));
    context.evidence.secondPage = second;
    context.evidence.survivingItems = 52;
    context.evidence.noDuplicatesOmissionsOrMalformedCursor = true;
  } finally {
    await replaceFunction(cluster, 'story_feed');
    await replaceFunction(cluster, '_story_shape');
    await cluster.admin.query('DROP FUNCTION public.qa_original_story_shape(uuid,uuid)');
    await cluster.admin.query('DROP TABLE public.qa_shape_log');
  }
}

async function contextReadback(cluster, fixture) {
  return cluster.observer.value(`jsonb_build_object(
    'message',(SELECT to_jsonb(message) FROM public.messages AS message WHERE id=${sqlLiteral(fixture.message)}),
    'context',(SELECT to_jsonb(context) FROM public.story_message_context AS context WHERE message_id=${sqlLiteral(fixture.message)}))`);
}

async function durableEffects(cluster) {
  const tables = { reports: 'story_reports', receipts: 'story_action_receipts', rates: 'story_rate_limits',
    notifications: 'story_notifications', notificationEvents: 'story_notification_events', interactions: 'story_interactions' };
  return cluster.observer.value(`jsonb_build_object(${Object.entries(tables).map(([label, table]) =>
    `${sqlLiteral(label)},(SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY to_jsonb(entry)::text),'[]'::jsonb) FROM public.${table} AS entry)`
  ).join(',')})`);
}

function contextCall(fixture, operation) {
  return operation === 'resolver' ? `public.resolve_story_reply_context(${sqlLiteral(fixture.message)})` :
    `public.report_story_content('${fixture.story}',${sqlLiteral(fixture.message)},'Synthetic independent QA context','${fixture.request}')`;
}

async function contextFixture(cluster, context, operation) {
  await resetStories(cluster);
  const fixture = { story: await harness.seedStory(cluster), replacement: await harness.seedStory(cluster),
    message: 'qa-message-' + randomUUID(), request: randomUUID(),
    caller: operation === 'resolver' ? IDS.reporter : IDS.subject };
  await cluster.admin.query(`INSERT INTO public.messages VALUES(${sqlLiteral(fixture.message)},'${IDS.reporter}',
    '${IDS.subject}','Synthetic independent QA message',clock_timestamp());
    INSERT INTO public.story_message_context VALUES(${sqlLiteral(fixture.message)},'${fixture.story}')`);
  await cluster.first.identity(fixture.caller);
  context.evidence.fixture = fixture;
  context.evidence.operation = contextCall(fixture, operation);
  context.evidence.waits = [];
  await cluster.first.query('BEGIN');
  try {
    const value = await cluster.first.value(context.evidence.operation);
    if (operation === 'resolver') {
      assert.equal(value.available, true);
      assert.equal(value.story.id, fixture.story);
    } else assert.equal(value.committed, true);
    context.evidence.validBeforeMutation = { value, transactionRolledBack: true };
  } finally { await cluster.first.query('ROLLBACK'); }
  context.evidence.before = await contextReadback(cluster, fixture);
  context.evidence.effectsBefore = await durableEffects(cluster);
  for (const rows of Object.values(context.evidence.effectsBefore)) assert.equal(rows.length, 0);
  return fixture;
}

function mutationSql(fixture, mutation) {
  const message = sqlLiteral(fixture.message);
  const changes = {
    sender: `UPDATE public.messages SET from_uid='${IDS.other}' WHERE id=${message} RETURNING id`,
    recipient: `UPDATE public.messages SET to_uid='${IDS.other}' WHERE id=${message} RETURNING id`,
    message_delete: `DELETE FROM public.messages WHERE id=${message} RETURNING id`,
    context_delete: `DELETE FROM public.story_message_context WHERE message_id=${message} RETURNING message_id`,
    context_rebind: `UPDATE public.story_message_context SET story_id='${fixture.replacement}' WHERE message_id=${message} RETURNING message_id`,
  };
  assert.ok(Object.hasOwn(changes, mutation));
  return changes[mutation];
}

function assertMutation(readback, fixture, mutation) {
  if (mutation === 'sender') assert.equal(readback.message.from_uid, IDS.other);
  if (mutation === 'recipient') assert.equal(readback.message.to_uid, IDS.other);
  if (mutation === 'message_delete') assert.deepEqual(readback, { message: null, context: null });
  if (mutation === 'context_delete') {
    assert.equal(readback.message.id, fixture.message);
    assert.equal(readback.context, null);
  }
  if (mutation === 'context_rebind') {
    assert.equal(readback.message.id, fixture.message);
    assert.equal(readback.context.story_id, fixture.replacement);
  }
}

function functionName(operation) {
  assert.ok(['resolver', 'report'].includes(operation));
  return operation === 'resolver' ? 'resolve_story_reply_context' : 'report_story_content';
}

function withoutContextRecheck(operation) {
  const source = statement(functionName(operation));
  if (operation === 'resolver') return replaceExactly(source,
    `  PERFORM message.id FROM public.messages AS message JOIN public.story_message_context AS context ON context.message_id = message.id
    WHERE message.id = p_message_id AND context.story_id = target_story AND message.to_uid = recipient::text
      AND (message.from_uid = caller::text OR message.to_uid = caller::text) FOR SHARE OF message;
  IF FOUND THEN SELECT public._story_shape(target_story,caller) INTO result; END IF;`,
    '  SELECT public._story_shape(target_story,caller) INTO result;');
  return replaceExactly(source,
    `  IF p_message_id IS NOT NULL THEN
    PERFORM message.id FROM public.messages AS message JOIN public.story_message_context AS context ON context.message_id = message.id
      WHERE message.id = p_message_id AND message.to_uid = caller::text AND message.from_uid = reported::text AND context.story_id = p_id FOR SHARE OF message;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report target unavailable' USING ERRCODE = 'PT404'; END IF;
  END IF;`, '');
}

function assertUnavailable(outcome, operation) {
  if (operation === 'resolver') assert.deepEqual(outcome, { value: { available: false } }, 'No context or media may be exposed');
  else assert.equal(outcome.error?.code, 'PT404', 'A stale contextual report must be rejected with PT404');
}

function invariantFails(context, check) {
  let failure;
  try { check(); } catch (error) { failure = error; }
  assert.equal(failure?.name, 'AssertionError', 'A deliberate omission must fail the same safety assertion');
  context.evidence.expectedInvariantFailure = errorDetails(failure);
}

async function observedWait(cluster, context, phase, waiter, blocker, type, key) {
  const state = await cluster.waitForLock(waiter, blocker, type, key);
  context.evidence.waits.push({ phase, type, ...state });
  assert.equal(state.activity.state, 'active', 'The SQL function or writer must still be executing');
  return state;
}

async function rollbackAvailable(session) {
  if (!session.closed && !session.pending) await session.query('ROLLBACK');
}

async function invalidatedContextCase(cluster, context, operation, mutation, mutant = false) {
  const fixture = await contextFixture(cluster, context, operation);
  const recipient = operation === 'resolver' ? IDS.subject : IDS.reporter;
  const key = await harness.storyLockKey(cluster, [fixture.caller, fixture.story, recipient]);
  let pending;
  context.evidence.runtime = { function: functionName(operation), sourceBodyExact: !mutant, helpersInstrumented: false };
  try {
    if (mutant) {
      const omission = withoutContextRecheck(operation);
      context.evidence.omission = { scope: 'Disposable function definition only', change: 'Remove the post-lock message/context/participant recheck',
        installedSql: omission, sha256: hash(omission) };
      await replaceFunction(cluster, functionName(operation), omission);
    }
    await cluster.admin.query('BEGIN');
    await cluster.admin.value(`pg_advisory_xact_lock(hashtextextended(${sqlLiteral(key)},0))`);
    pending = cluster.first.value(contextCall(fixture, operation)).then(value => ({ value }), error => ({ error: errorDetails(error) }));
    await observedWait(cluster, context, 'RPC queued before contextual recheck', cluster.first, cluster.admin, 'advisory', key);
    context.evidence.mutation = { sql: mutationSql(fixture, mutation), writerBackendPid: cluster.qaWriter.pid };
    assert.deepEqual(await cluster.qaWriter.query(context.evidence.mutation.sql), [fixture.message]);
    context.evidence.committedMutationBeforeRelease = await contextReadback(cluster, fixture);
    assertMutation(context.evidence.committedMutationBeforeRelease, fixture, mutation);
    assert.deepEqual(await durableEffects(cluster), context.evidence.effectsBefore);
    await observedWait(cluster, context, 'Mutation committed and visible while RPC remains queued', cluster.first, cluster.admin, 'advisory', key);
    context.reproductionExecuted = true;
    await cluster.admin.query('COMMIT');
    const outcome = await pending;
    pending = null;
    context.evidence.outcome = outcome;
    context.evidence.after = await contextReadback(cluster, fixture);
    context.evidence.effectsAfter = await durableEffects(cluster);
    assert.deepEqual(context.evidence.after, context.evidence.committedMutationBeforeRelease);
    if (mutant) {
      invariantFails(context, () => assertUnavailable(outcome, operation));
      assert.equal(outcome.error, undefined);
      if (operation === 'resolver') {
        assert.equal(outcome.value.available, true);
        assert.equal(outcome.value.story.id, fixture.story);
        assert.equal(typeof outcome.value.story.photo, 'string');
      } else {
        assert.equal(outcome.value.committed, true);
        assert.equal(context.evidence.effectsAfter.reports.length, 1);
        assert.equal(context.evidence.effectsAfter.reports[0].reported_uid, IDS.reporter);
        assert.equal(context.evidence.after.message.from_uid, IDS.other);
        assert.equal(context.evidence.effectsAfter.receipts.length, 1);
      }
    } else {
      assertUnavailable(outcome, operation);
      if (operation === 'report') {
        assert.deepEqual(context.evidence.effectsAfter, context.evidence.effectsBefore);
        context.evidence.noDurableSideEffects = true;
      } else {
        for (const [name, rows] of Object.entries(context.evidence.effectsAfter)) if (name !== 'rates') assert.equal(rows.length, 0);
        context.evidence.readBudgetOnly = context.evidence.effectsAfter.rates;
      }
    }
  } finally {
    await rollbackAvailable(cluster.admin);
    if (pending) await pending;
    if (mutant) await replaceFunction(cluster, functionName(operation));
  }
}

async function installAfterCheckGate(cluster, context, operation, key) {
  if (operation === 'resolver') {
    await cluster.admin.query(replaceExactly(statement('_story_shape'), 'public._story_shape(', 'public.qa_original_story_shape('));
    await cluster.admin.query('REVOKE ALL ON FUNCTION public.qa_original_story_shape(uuid,uuid) FROM PUBLIC,anon,authenticated');
    const override = `CREATE FUNCTION public._story_shape(p_id uuid,p_actor uuid)
      RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $function$
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${sqlLiteral(key)},0));
        RETURN public.qa_original_story_shape(p_id,p_actor);
      END;
      $function$;`;
    await replaceFunction(cluster, '_story_shape', override);
    context.evidence.instrumentation = { helperOverride: override,
      copiedHelper: 'Canonical _story_shape body with only its name changed; actual resolver body is unchanged in normal cases',
      boundary: 'Entry to projection, after the resolver message/context FOR SHARE statement' };
  } else {
    const trigger = `CREATE FUNCTION public.qa_report_gate() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${sqlLiteral(key)},0));
        RETURN NEW;
      END;
      $function$;`;
    await cluster.admin.query(trigger);
    await cluster.admin.query('REVOKE ALL ON FUNCTION public.qa_report_gate() FROM PUBLIC,anon,authenticated');
    await cluster.admin.query('CREATE TRIGGER qa_after_context_check BEFORE INSERT ON public.story_reports FOR EACH ROW EXECUTE FUNCTION public.qa_report_gate()');
    context.evidence.instrumentation = { fixtureTriggerFunction: trigger,
      trigger: 'BEFORE INSERT ON story_reports; actual report function and helpers are unchanged in normal cases',
      boundary: 'After the report message/context FOR SHARE statement and before report insertion/FK checks' };
  }
}

async function removeAfterCheckGate(cluster, operation) {
  if (operation === 'resolver') {
    await replaceFunction(cluster, '_story_shape');
    await cluster.admin.query('DROP FUNCTION public.qa_original_story_shape(uuid,uuid)');
  } else {
    await cluster.admin.query('DROP TRIGGER qa_after_context_check ON public.story_reports');
    await cluster.admin.query('DROP FUNCTION public.qa_report_gate()');
  }
}

function assertWriterNotCommitted(before, during) {
  assert.deepEqual(during, before, 'The message row writer must not commit while the checked RPC is held open');
}

async function messageShareCase(cluster, context, operation, mutation, mutant = false) {
  const fixture = await contextFixture(cluster, context, operation);
  const key = 'qa-story-after-message-check:' + fixture.request;
  let pending, writerPending, gateInstalled = false;
  context.evidence.runtime = { function: functionName(operation), sourceBodyExact: !mutant };
  try {
    if (mutant) {
      const omission = replaceExactly(statement(functionName(operation)), ' FOR SHARE OF message', '');
      await replaceFunction(cluster, functionName(operation), omission);
      context.evidence.omission = { scope: 'Disposable function definition only', change: 'Remove only FOR SHARE OF message; retain every participant/context check',
        installedSql: omission, sha256: hash(omission) };
    }
    await installAfterCheckGate(cluster, context, operation, key);
    gateInstalled = true;
    await cluster.admin.query('BEGIN');
    await cluster.admin.value(`pg_advisory_xact_lock(hashtextextended(${sqlLiteral(key)},0))`);
    pending = cluster.first.value(contextCall(fixture, operation)).then(value => ({ value }), error => ({ error: errorDetails(error) }));
    await observedWait(cluster, context, 'RPC executing after message check', cluster.first, cluster.admin, 'advisory', key);
    await cluster.qaWriter.query('BEGIN');
    context.evidence.mutation = { sql: mutationSql(fixture, mutation), writerBackendPid: cluster.qaWriter.pid };
    writerPending = cluster.qaWriter.query(context.evidence.mutation.sql).then(lines => ({ lines }), error => ({ error: errorDetails(error) }));
    if (mutant) {
      const written = await writerPending;
      writerPending = null;
      assert.deepEqual(written, { lines: [fixture.message] });
      await cluster.qaWriter.query('COMMIT');
      context.evidence.beforeRpcRelease = await contextReadback(cluster, fixture);
      assertMutation(context.evidence.beforeRpcRelease, fixture, mutation);
      await observedWait(cluster, context, 'Writer committed while unchecked RPC still executes', cluster.first, cluster.admin, 'advisory', key);
      invariantFails(context, () => assertWriterNotCommitted(context.evidence.before, context.evidence.beforeRpcRelease));
      context.evidence.writerCommittedBeforeRpcRelease = true;
    } else {
      await observedWait(cluster, context, 'Message row writer blocked by active checked RPC', cluster.qaWriter, cluster.first, 'transactionid');
      context.evidence.beforeRpcRelease = await contextReadback(cluster, fixture);
      assertWriterNotCommitted(context.evidence.before, context.evidence.beforeRpcRelease);
      assert.deepEqual(await durableEffects(cluster), context.evidence.effectsBefore);
      context.evidence.writerCommittedBeforeRpcRelease = false;
    }
    context.reproductionExecuted = true;
    await cluster.admin.query('COMMIT');
    const outcome = await pending;
    pending = null;
    context.evidence.outcome = outcome;
    assert.equal(outcome.error, undefined);
    if (operation === 'resolver') {
      assert.equal(outcome.value.available, true);
      assert.equal(outcome.value.story.id, fixture.story);
    } else assert.equal(outcome.value.committed, true);
    if (writerPending) {
      assert.deepEqual(await writerPending, { lines: [fixture.message] });
      writerPending = null;
      await cluster.qaWriter.query('COMMIT');
    }
    context.evidence.afterWriterCommit = await contextReadback(cluster, fixture);
    assertMutation(context.evidence.afterWriterCommit, fixture, mutation);
    context.evidence.effectsAfter = await durableEffects(cluster);
    if (operation === 'report') {
      assert.equal(context.evidence.effectsAfter.reports.length, 1);
      assert.equal(context.evidence.effectsAfter.receipts.length, 1);
      assert.equal(context.evidence.effectsAfter.reports[0].reported_uid, IDS.reporter);
      assert.equal(context.evidence.effectsAfter.reports[0].message_id, mutation === 'message_delete' ? null : fixture.message);
    } else if (!mutant) {
      assert.deepEqual(await cluster.first.value(contextCall(fixture, operation)), { available: false });
      context.evidence.freshResolverAfterWriterCommit = { available: false };
    }
    context.evidence.serialization = mutant ? 'Writer committed after the check but before RPC completion: omission is detected' :
      'Valid RPC completes before the queued row writer can commit; a deletion may then cascade context or null the report message reference';
  } finally {
    await rollbackAvailable(cluster.admin);
    if (pending) await pending;
    if (writerPending) await writerPending;
    await rollbackAvailable(cluster.qaWriter);
    if (gateInstalled) await removeAfterCheckGate(cluster, operation);
    if (mutant) await replaceFunction(cluster, functionName(operation));
  }
}

function cases() {
  const definitions = [
    { id: 'feed-null-eligibility-pagination', defect: 'DEF-077', kind: 'normal', run: (cluster, context) => feedNullCase(cluster, context, false) },
    { id: 'feed-missing-null-guard', defect: 'DEF-077', kind: 'negative_control', run: (cluster, context) => feedNullCase(cluster, context, true) },
  ];
  for (const operation of ['resolver', 'report']) {
    for (const mutation of ['sender', 'recipient', 'message_delete', 'context_delete', 'context_rebind']) {
      definitions.push({ id: operation + '-queued-' + mutation, defect: 'DEF-078', kind: 'normal',
        run: (cluster, context) => invalidatedContextCase(cluster, context, operation, mutation) });
    }
    definitions.push({ id: operation + '-missing-context-recheck', defect: 'DEF-078', kind: 'negative_control',
      run: (cluster, context) => invalidatedContextCase(cluster, context, operation, 'sender', true) });
    for (const mutation of ['sender', 'message_delete']) {
      definitions.push({ id: operation + '-message-share-' + mutation, defect: 'DEF-078', kind: 'normal',
        run: (cluster, context) => messageShareCase(cluster, context, operation, mutation) });
    }
    definitions.push({ id: operation + '-missing-message-share', defect: 'DEF-078', kind: 'negative_control',
      run: (cluster, context) => messageShareCase(cluster, context, operation, 'sender', true) });
  }
  return definitions;
}

async function executeCase(cluster, report, definition) {
  const context = { id: definition.id, defect: definition.defect, kind: definition.kind,
    status: 'running', reproductionExecuted: false, evidence: {} };
  report.cases.push(context);
  const started = Date.now();
  try {
    await definition.run(cluster, context);
    context.status = 'passed';
  } catch (error) {
    context.status = 'failed';
    context.error = errorDetails(error);
    throw error;
  } finally {
    context.durationMs = Date.now() - started;
    console.log(`${context.status.toUpperCase()} ${context.kind} ${context.id}`);
  }
}

async function main() {
  harness.assertWorkspace();
  assert.equal(fs.realpathSync(__filename), path.join(WORKSPACE, SELF));
  assert.equal(process.argv.length, 2, 'No connection arguments, targets or flags are accepted');
  const report = { schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running',
    scope: ['DEF-077', 'DEF-078'], sourceBefore: harness.fingerprint(), sourceHashesBefore: sourceHashes(),
    cases: [], probeErrors: [], runtimeLoader: { source: path.relative(WORKSPACE, RUNNER), sha256: hash(runnerSource),
      augmentation: AUGMENTATION, existingRunnerMainExecuted: false, existingCaseSuiteExecuted: false,
      existingGuardOrUtilityBodyChanged: false }, plannedCases: cases().map(({ run, ...definition }) => definition),
    completedDefectCoverage: [] };
  assert.equal(hash(migration), report.sourceHashesBefore[SQL]);
  assert.equal(hash(runnerSource), report.sourceHashesBefore['scripts/verify-postgres-concurrency.cjs']);
  if (process.env.FORMORA_STORY_SQL_INITIAL) {
    const initial = JSON.parse(process.env.FORMORA_STORY_SQL_INITIAL);
    for (const [filename, digest] of Object.entries(initial.sourceHashes)) assert.equal(fileHash(filename), digest, filename + ' changed since initial routing');
    report.initialBaseline = initial;
  }
  const directory = newArtifactDirectory(report.runId);
  const destination = path.join(directory, 'result.json');
  const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const writeReport = () => {
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, JSON.stringify(report, null, 2) + '\n', 0, 'utf8');
    fs.fsyncSync(descriptor);
  };
  writeReport();
  const cluster = new LocalCluster(report);
  const cancel = () => {
    if (cluster.cleaning) return;
    cluster.cancelled = true;
    cluster.events.emit('cancel');
    for (const child of cluster.children) child.kill('SIGTERM');
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const deadline = setTimeout(cancel, 120000);
  try {
    await cluster.setup();
    report.runtimeBefore = await exactFunctions(cluster);
    await cluster.admin.query('ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY; ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY');
    cluster.qaWriter = await cluster.session('independent_qa_writer', 'fixture_superuser');
    for (const session of cluster.sessions) {
      await session.query("SET statement_timeout='10000ms'; SET lock_timeout='6000ms'; SET idle_in_transaction_session_timeout='15000ms'");
    }
    report.fixtureRls = await cluster.observer.value(`(SELECT jsonb_object_agg(relname,relrowsecurity) FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind='r' AND (relname LIKE 'story_%' OR relname IN ('stories_v2','messages','profiles')))`);
    assert.ok(Object.values(report.fixtureRls).every(enabled => enabled === true));
    report.memberRole = await cluster.first.value(`jsonb_build_object('role',current_user,'login',session_user,
      'uid',auth.uid(),'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
      'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user))`);
    assert.equal(report.memberRole.role, 'authenticated');
    assert.equal(report.memberRole.superuser, false);
    assert.equal(report.memberRole.bypassRls, false);
    for (const definition of cases()) await executeCase(cluster, report, definition);
    report.runtimeAfter = await exactFunctions(cluster);
    assert.deepEqual(report.runtimeAfter, report.runtimeBefore);
    report.completedDefectCoverage = ['DEF-077', 'DEF-078'];
  } catch (error) {
    report.probeErrors.push(errorDetails(error));
  } finally {
    clearTimeout(deadline);
    try {
      if (cluster.root && fs.existsSync(path.join(cluster.root, 'server.log'))) {
        harness.ownedDirectory(cluster.ownership);
        fs.copyFileSync(path.join(cluster.root, 'server.log'), path.join(directory, 'server-before-cleanup.log'), fs.constants.COPYFILE_EXCL);
      }
    } catch (error) { report.probeErrors.push(errorDetails(error)); }
    try { report.cleanup = await cluster.cleanup(); }
    catch (error) { report.cleanup = { ...report.cleanup, error: errorDetails(error) }; }
    report.sourceHashesAfter = sourceHashes();
    report.sourceUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
    report.counts = { normalPassed: report.cases.filter(entry => entry.kind === 'normal' && entry.status === 'passed').length,
      normalFailed: report.cases.filter(entry => entry.kind === 'normal' && entry.status === 'failed').length,
      deliberateMutantFailures: report.cases.filter(entry => entry.kind === 'negative_control' && entry.status === 'passed').length,
      negativeControlFailed: report.cases.filter(entry => entry.kind === 'negative_control' && entry.status === 'failed').length,
      probeErrors: report.probeErrors.length, planned: report.plannedCases.length, executed: report.cases.length,
      notRun: report.plannedCases.length - report.cases.length,
      observedLockWaits: report.cases.reduce((total, entry) => total + new Set((entry.evidence.waits || [])
        .map(wait => [wait.waiterPid,wait.blockerPid,wait.type,wait.advisoryKey].join(':'))).size, 0),
      lockObservations: report.cases.reduce((total, entry) => total + (entry.evidence.waits || []).length, 0),
      rowWriterWaits: report.cases.reduce((total, entry) => total + (entry.evidence.waits || []).filter(wait => wait.type === 'transactionid').length, 0),
      expectedReportRejections: report.cases.filter(entry => entry.kind === 'normal' && entry.evidence.outcome?.error?.code === 'PT404').length,
      rolledBackValidPreconditionControls: report.cases.filter(entry => entry.evidence.validBeforeMutation?.transactionRolledBack).length,
      sqlQueries: cluster.queryCount, lockProbes: cluster.lockProbeCount, peakConnections: cluster.peakConnections };
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.safety = { realPostgreSQL: true, pgliteUsed: false, clusterCount: cluster.root ? 1 : 0,
      networkOrProviderCalls: 0, defaultDatabaseTouched: false, packageInstalls: 0, productOrSqlFileWrites: 0,
      budgetMs: 180000, cancellationDeadlineMs: 120000, withinBudget: report.durationMs <= 180000,
      syntheticIdentityClaimsOnly: true, rlsDisabled: false, existingOfficePreviewStopped: false };
    report.status = report.cases.some(entry => entry.status !== 'passed') || report.counts.notRun || report.probeErrors.length || !report.sourceUnchanged ||
      !report.cleanup.processStopped || !report.cleanup.psqlChildrenClosed || !report.cleanup.removedOwnedDirectory || !report.safety.withinBudget ? 'failed' : 'passed';
    writeReport();
    fs.closeSync(descriptor);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    console.log(JSON.stringify({ report: path.relative(WORKSPACE, destination), status: report.status, counts: report.counts,
      probeErrors: report.probeErrors, cleanup: report.cleanup, sourceUnchanged: report.sourceUnchanged }, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify(errorDetails(error))); process.exitCode = 1; });