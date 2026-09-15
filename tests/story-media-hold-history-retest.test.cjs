'use strict';
// Independent retest of the T-111 F2 repair (report-hold epochs invalidating stale cleanup approvals).
// Owns only this file: no product, existing test, office, CI or git change. PGlite only; not hosted
// Storage/PostgREST/GoTrue, no physical erasure, no release or activation acceptance.
// Maintainer test-only update, 2026-09-07 (not a second independent review): IR3 assumed the R-1 wedge was
// permanent. cancel_story_media_cleanup now retires an untouched invalidated plan, so IR3 keeps every
// original refusal and additionally requires that recovery is explicit and non-destructive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, owner, peer } = require('./story-media-sql.test.cjs');
const { cancelled, prepare, confirm } = require('./story-media-cleanup.test.cjs');

const rightsSql = fs.readFileSync(path.join(__dirname, '../supabase/account-rights.sql'), 'utf8');
const moderationSql = fs.readFileSync(path.join(__dirname, '../supabase/moderation-lifecycle.sql'), 'utf8');
const historyOffset = rightsSql.indexOf('CREATE TABLE IF NOT EXISTS public.account_rights_report_hold_epochs (');
assert.ok(historyOffset > 0, 'the report hold epoch history must live in supabase/account-rights.sql');
const historyUpgrade = 'BEGIN;\n' + rightsSql.slice(historyOffset);
// The negative control must be the ORIGINAL rights slice, not a half-installed current one: the cut runs
// from the history section to the permissions block that follows it, and both anchors are asserted so a
// moved section fails loudly instead of silently producing a broken schema that would fake the defect.
const permissionsOffset = rightsSql.indexOf('DO $permissions$', historyOffset);
assert.ok(permissionsOffset > historyOffset, 'the history section must be followed by the permissions block');
const preFixRightsSql = rightsSql.slice(0, historyOffset) + rightsSql.slice(permissionsOffset);
assert.equal(/report_hold_version|account_rights_report_hold_epochs|account_rights_install_report_hold_history/.test(preFixRightsSql), false,
  'no part of the fix may leak into the negative control');
assert.match(preFixRightsSql, /CREATE (?:OR REPLACE )?FUNCTION public\.account_rights_hold_state\(/,
  'the negative control must still define the original hold state, so a refusal cannot come from a missing function');
assert.match(preFixRightsSql, /CREATE (?:OR REPLACE )?FUNCTION public\.account_rights_report_holds\(/,
  'and it must still define the live report hold count the original snapshot was blind to');
const outsider = '55555555-5555-4555-8555-555555555555';

async function base(context) {
  const db = await database(context);
  await db.exec(`CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid NOT NULL,reported_uid text,
      status text NOT NULL DEFAULT 'received',updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.report_case_actions(id uuid PRIMARY KEY,case_id uuid REFERENCES public.report_cases(id));`);
  return db;
}

async function install(db, { moderationFirst = true, preFix = false } = {}) {
  const rights = preFix ? preFixRightsSql : rightsSql;
  await db.exec(moderationFirst ? moderationSql : rights);
  await db.exec(moderationFirst ? rights : moderationSql);
  await identity(db, null, 'service_role');
  await db.exec('UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
}

async function upgrade(db) {
  await db.exec('RESET ROLE');
  await db.exec(historyUpgrade);
}

async function holdState(db, account = owner) {
  await db.exec('RESET ROLE');
  return rpc(db, 'account_rights_hold_state', [account]);
}

async function epochs(db) {
  const states = [];
  for (const account of [owner, peer, outsider]) states.push(await holdState(db, account));
  assert.ok(states.every(state => state.hold_version === 0), 'the request-hold epoch must stay untouched by report holds');
  return states.map(state => [state.hold_status, state.report_hold_version]);
}

async function setHold(db, caseId, holdRef, held) {
  await identity(db, null, 'service_role');
  return rpc(db, 'set_report_evidence_hold', [caseId, holdRef, held]);
}

async function addCase(db, id, reporter, subject) {
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO public.report_cases(id,reporter,reported_uid) VALUES($1,$2,$3)', [id, reporter, subject]);
}

async function deleteObject(db, id) {
  await identity(db, null, 'service_role');
  return (await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [id])).rows.length;
}

async function objectCount(db, id) {
  await db.exec('RESET ROLE');
  return (await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE id=$1', [id])).rows[0].count;
}

async function cancel(db, plan, reference) {
  await identity(db, null, 'service_role');
  return rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]);
}

async function intentRows(db, planId) {
  await db.exec('RESET ROLE');
  return (await db.query('SELECT state,cancelled_at FROM public.story_media_cleanup_intents WHERE plan_id=$1 ORDER BY object_id', [planId])).rows;
}

test('IR1: a report-hold add/remove cycle is what fences an otherwise replayable approved cleanup, and no role can rewind it', async context => {
  const db = await base(context);
  await install(db);
  const reservation = await cancelled(db);
  const caseId = randomUUID(), holdRef = randomUUID(), approval = randomUUID();
  await addCase(db, caseId, peer, owner);
  const plan = await prepare(db, reservation);
  await confirm(db, plan, approval);
  assert.deepEqual(await confirm(db, plan, approval), await confirm(db, plan, approval),
    'baseline: an approved plan replays, so a later refusal is caused by the epoch and not by replay itself');
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT holds FROM public.story_media_cleanup_plans WHERE id=$1', [plan.plan_id])).rows[0].holds,
    { hold_status: 'clear', hold_version: 0, report_hold_version: 0 }, 'the epoch is pinned into the approved snapshot');
  assert.deepEqual(await epochs(db), [['clear', 0], ['clear', 0], ['clear', 0]]);

  assert.equal((await setHold(db, caseId, holdRef, true)).held, true);
  assert.deepEqual(await epochs(db), [['held', 1], ['held', 1], ['clear', 0]], 'subject and reporter both move; a stranger does not');
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' }, 'an active hold blocks approval replay');
  await assert.rejects(deleteObject(db, reservation.stored.id), { code: 'PT409' }, 'an active hold blocks the metadata delete');

  assert.equal((await setHold(db, caseId, holdRef, false)).held, false);
  assert.deepEqual(await epochs(db), [['clear', 2], ['clear', 2], ['clear', 0]], 'the flicker is visible even though the status is clear again');
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' }, 'the stale snapshot cannot be re-approved');
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' }, 'the stale snapshot cannot be claimed');
  await assert.rejects(deleteObject(db, reservation.stored.id), { code: 'PT409' }, 'the stale snapshot cannot delete');
  assert.equal(await objectCount(db, reservation.stored.id), 1);

  const frozen = await epochs(db);
  for (const role of ['anon', 'authenticated', 'service_role', 'inherited_service']) {
    await identity(db, owner, role);
    for (const statement of [
      'SELECT owner_id,version FROM public.account_rights_report_hold_epochs',
      `INSERT INTO public.account_rights_report_hold_epochs(owner_id,version) VALUES('${owner}',1)`,
      'UPDATE public.account_rights_report_hold_epochs SET version=1',
      'DELETE FROM public.account_rights_report_hold_epochs',
      'TRUNCATE public.account_rights_report_hold_epochs',
      'SELECT public.account_rights_report_hold_transition()',
      'SELECT public.account_rights_install_report_hold_history()',
      'SELECT public.account_rights_hold_state(NULL)',
      'DELETE FROM public.report_evidence_holds',
      'TRUNCATE public.report_evidence_holds',
      'ALTER TABLE public.report_evidence_holds DISABLE TRIGGER account_rights_report_hold_transition',
      'DROP TRIGGER account_rights_report_hold_mapping ON public.report_cases'
    ]) await assert.rejects(db.exec(statement), { code: '42501' }, role + ' :: ' + statement);
  }
  assert.deepEqual(await epochs(db), frozen, 'no denied attempt moved or cleared the epoch');

  const next = await cancelled(db);
  const fresh = await prepare(db, next);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256);
  await confirm(db, fresh);
  assert.equal(await deleteObject(db, next.stored.id), 1, 'work planned after the flicker still completes');
  assert.equal(await objectCount(db, reservation.stored.id), 1);
});

test('IR2: rights-first install still bridges, and only real owner, case or hold identity changes move the epoch', async context => {
  const db = await base(context);
  await db.exec(rightsSql);
  const unknown = await holdState(db);
  assert.equal(unknown.hold_status, 'unknown', 'no hold table yet means unknown, never a false clear');
  assert.equal(unknown.report_hold_version, null);
  await db.exec(moderationSql);
  const caseId = randomUUID(), quiet = randomUUID(), holdRef = randomUUID();
  await addCase(db, caseId, owner, peer);
  assert.deepEqual(await epochs(db), [['clear', 0], ['clear', 0], ['clear', 0]]);

  await setHold(db, caseId, holdRef, true);
  assert.deepEqual(await epochs(db), [['held', 1], ['held', 1], ['clear', 0]]);
  await db.exec('RESET ROLE');
  await assert.rejects(db.query('UPDATE public.report_cases SET reporter=NULL WHERE id=$1', [caseId]), { code: 'PT409' },
    'a held case cannot lose its owner mapping');
  await db.query("UPDATE public.report_cases SET reporter=reporter,reported_uid=reported_uid,status='under_review' WHERE id=$1", [caseId]);
  await db.query('UPDATE public.report_evidence_holds SET case_id=case_id,hold_ref=hold_ref WHERE case_id=$1', [caseId]);
  await setHold(db, caseId, holdRef, true);
  assert.deepEqual(await epochs(db), [['held', 1], ['held', 1], ['clear', 0]], 'no-op writes and an idempotent re-hold are not transitions');

  await db.exec('RESET ROLE');
  await db.query('UPDATE public.report_cases SET reporter=$1 WHERE id=$2', [outsider, caseId]);
  assert.deepEqual(await epochs(db), [['clear', 2], ['held', 2], ['held', 1]], 'a reassignment moves the losing and the gaining owner');

  await addCase(db, quiet, owner, peer);
  await db.query('UPDATE public.report_cases SET reported_uid=$1 WHERE id=$2', [outsider, quiet]);
  assert.deepEqual(await epochs(db), [['clear', 2], ['held', 2], ['held', 1]], 'a case carrying no hold never moves anyone');

  await db.query('UPDATE public.report_evidence_holds SET hold_ref=$1 WHERE case_id=$2', [randomUUID(), caseId]);
  assert.deepEqual(await epochs(db), [['clear', 2], ['held', 3], ['held', 2]], 'rotating the opaque hold reference is a transition');
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [caseId]);
  assert.deepEqual(await epochs(db), [['clear', 2], ['clear', 4], ['clear', 3]], 'a delete moves exactly the current mapping');
});

test('IR3: the pre-fix snapshot was blind, the upgrade is idempotent and fails closed, and an invalidated approval is recoverable only by explicit cancellation plus a fresh dry run and approval', async context => {
  const db = await base(context);
  await install(db, { preFix: true });
  const caseId = randomUUID(), holdRef = randomUUID();
  await addCase(db, caseId, peer, owner);
  const first = await cancelled(db);
  const blind = await prepare(db, first);
  await confirm(db, blind, randomUUID());
  assert.equal(Object.hasOwn(await holdState(db), 'report_hold_version'), false, 'pre-fix hold state carries no report epoch');
  await setHold(db, caseId, holdRef, true);
  await assert.rejects(deleteObject(db, first.stored.id), { code: 'PT409' }, 'pre-fix code did block a currently active hold');
  await setHold(db, caseId, holdRef, false);
  assert.deepEqual(await holdState(db), { hold_status: 'clear', hold_version: 0 });
  assert.equal(await deleteObject(db, first.stored.id), 1,
    'F2 reproduced on the pre-fix schema: an add/remove flicker left the old approval executable');

  const second = await cancelled(db), carriedApproval = randomUUID();
  const carried = await prepare(db, second);
  await confirm(db, carried, carriedApproval);
  await upgrade(db);
  await upgrade(db);
  await upgrade(db);
  assert.deepEqual(await holdState(db), { hold_status: 'clear', hold_version: 0, report_hold_version: 0 });
  await assert.rejects(confirm(db, carried, carriedApproval), { code: 'PT409' },
    'an approval taken under the old shape fails closed after the upgrade, with no hold change at all');
  await assert.rejects(deleteObject(db, second.stored.id), { code: 'PT409' });

  await setHold(db, caseId, holdRef, true);
  await setHold(db, caseId, holdRef, false);
  const earned = await epochs(db);
  assert.deepEqual(earned, [['clear', 2], ['clear', 2], ['clear', 0]]);
  await upgrade(db);
  await upgrade(db);
  assert.deepEqual(await epochs(db), earned, 'reinstalling never rewinds recorded epochs');
  await db.exec('RESET ROLE');
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM pg_trigger
    WHERE tgfoid='public.account_rights_report_hold_transition()'::regprocedure AND NOT tgisinternal`)).rows[0].count, 4,
    'exactly the four guards survive repeated installs');

  await assert.rejects(prepare(db, second), { code: 'PT409' }, 'a new dry run for the same object is refused while the dead approval is live');
  await db.exec('RESET ROLE');
  await db.query(`UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',
    expires_at=now()-interval '1 minute' WHERE id=$1`, [carried.plan_id]);
  await assert.rejects(prepare(db, second), { code: 'PT409' }, 'expiring the dead approval does not release the object either');
  const replay = await prepare(db, second, [second.stored.id], carried.operation_id);
  assert.equal(replay.plan_id, carried.plan_id, 'the original operation only returns the same dead plan');
  await assert.rejects(confirm(db, carried, carriedApproval), { code: 'PT409' });
  assert.equal(await objectCount(db, second.stored.id), 1, 'the object is retained, not orphaned');
  assert.deepEqual(await intentRows(db, carried.plan_id), [{ state: 'claimed', cancelled_at: null }],
    'the durable intent stays inventoried for operator review');

  // R-1 is no longer a permanent wedge: recovery is explicit, service-only and non-destructive.
  const cancellation = randomUUID();
  const retired = await cancel(db, carried, cancellation);
  assert.equal(retired.plan_id, carried.plan_id);
  assert.equal(retired.cancellation_ref, cancellation);
  assert.equal(retired.approval_ref, carriedApproval, 'the retired plan keeps its original approval audit');
  assert.equal(retired.dry_run, false);
  assert.equal(retired.storage_delete_authorized, false);
  assert.equal(await objectCount(db, second.stored.id), 1, 'retiring an untouched plan deletes nothing');
  const retiredIntents = await intentRows(db, carried.plan_id);
  assert.equal(retiredIntents.length, 1);
  assert.equal(retiredIntents[0].state, 'claimed', 'the intent keeps its state and is retained, not erased');
  assert.notEqual(retiredIntents[0].cancelled_at, null);
  await assert.rejects(confirm(db, carried, carriedApproval), { code: 'PT409' }, 'the retired plan is still dead');
  await assert.rejects(deleteObject(db, second.stored.id), { code: 'PT403' },
    'with no live plan the object falls back to the immutable default rather than a stale-plan refusal');

  const revived = await prepare(db, second);
  assert.notEqual(revived.plan_id, carried.plan_id);
  assert.notEqual(revived.snapshot_sha256, carried.snapshot_sha256, 'the fresh snapshot pins the current report hold epoch');
  assert.equal(revived.dry_run, true);
  assert.equal(revived.approval_ref, null);
  await assert.rejects(confirm(db, revived, carriedApproval), { code: 'PT409' }, 'the retired approval reference cannot be re-spent');
  assert.equal((await confirm(db, revived, randomUUID())).storage_delete_authorized, true,
    'only an exact fresh snapshot with a fresh independent approval restores delete authority');
  assert.equal(await objectCount(db, second.stored.id), 1, 'recovery restored authority without deleting anything yet');

  for (const drift of [
    'ALTER TABLE public.report_evidence_holds RENAME COLUMN hold_ref TO unknown_hold',
    'ALTER TABLE public.report_evidence_holds DISABLE TRIGGER account_rights_report_hold_transition'
  ]) {
    await db.exec('RESET ROLE; BEGIN; ' + drift);
    const drifted = await holdState(db);
    assert.equal(drifted.hold_status, 'unknown', drift);
    assert.equal(drifted.report_hold_version, null, drift);
    await assert.rejects(prepare(db, second), error => error.code === 'PT409' && /evidence holds block cleanup/i.test(error.message), drift);
    await db.exec('ROLLBACK');
  }
  assert.deepEqual(await epochs(db), earned);
});
