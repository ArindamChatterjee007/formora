'use strict';
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
assert.ok(historyOffset > 0);
const historyUpgrade = 'BEGIN;\n' + rightsSql.slice(historyOffset);
const legacyRightsSql = rightsSql.slice(0, historyOffset) + rightsSql.slice(rightsSql.indexOf('DO $permissions$', historyOffset));
const unrelated = '44444444-4444-4444-8444-444444444444';

async function fixture(context, moderationFirst = true, legacy = false) {
  const db = await database(context);
  await db.exec(`CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid NOT NULL,reported_uid text,
      status text NOT NULL DEFAULT 'received',updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.report_case_actions(id uuid PRIMARY KEY,case_id uuid REFERENCES public.report_cases(id));`);
  const rights = legacy ? legacyRightsSql : rightsSql;
  await db.exec(moderationFirst ? moderationSql : rights);
  if (!moderationFirst && !legacy) assert.equal((await rpc(db, 'account_rights_hold_state', [owner])).hold_status, 'unknown');
  await db.exec(moderationFirst ? rights : moderationSql);
  await identity(db, null, 'service_role');
  await db.exec('UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
  return db;
}

async function holdState(db, account = owner) {
  await db.exec('RESET ROLE');
  return rpc(db, 'account_rights_hold_state', [account]);
}

async function setHold(db, caseId, holdRef, held) {
  await identity(db, null, 'service_role');
  return rpc(db, 'set_report_evidence_hold', [caseId, holdRef, held]);
}

test('F2: a report hold on/off cycle fences approved cleanup and permits fresh same-owner work', async context => {
  const db = await fixture(context), reservation = await cancelled(db);
  const caseId = randomUUID(), holdRef = randomUUID(), approval = randomUUID();
  await db.query('INSERT INTO public.report_cases(id,reporter,reported_uid) VALUES($1,$2,$3)', [caseId, peer, owner]);
  const before = await holdState(db);
  const plan = await prepare(db, reservation);
  await confirm(db, plan, approval);
  assert.equal((await rpc(db, 'set_report_evidence_hold', [caseId, holdRef, true])).held, true);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT409' });
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  assert.equal((await rpc(db, 'set_report_evidence_hold', [caseId, holdRef, false])).held, false);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT409' });
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  const after = await holdState(db);
  assert.equal(after.hold_status, 'clear');
  assert.equal(after.hold_version, before.hold_version);
  assert.equal(after.report_hold_version, before.report_hold_version + 2);
  assert.equal((await holdState(db, peer)).report_hold_version, 2);
  assert.equal((await holdState(db, unrelated)).report_hold_version, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE id=$1', [reservation.stored.id])).rows[0].count, 1);
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [plan.plan_id]);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  const nextReservation = await cancelled(db), fresh = await prepare(db, nextReservation);
  assert.notEqual(fresh.plan_id, plan.plan_id);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256);
  await confirm(db, fresh);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [nextReservation.stored.id])).rows.length, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE id=$1', [reservation.stored.id])).rows[0].count, 1);
});

test('F2: rights-first bridge tracks real owner, case and hold identity changes but not no-ops', async context => {
  const db = await fixture(context, false), caseId = randomUUID(), otherCase = randomUUID(), holdRef = randomUUID();
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO public.report_cases(id,reporter,reported_uid) VALUES($1,$2,$3),($4,$5,$6)',
    [caseId, owner, peer, otherCase, unrelated, 'synthetic_legacy_subject']);
  const versions = async expected => {
    const states = [];
    for (const account of [owner, peer, unrelated]) states.push(await holdState(db, account));
    assert.deepEqual(states.map(state => state.report_hold_version), expected);
    assert.ok(states.every(state => state.hold_version === 0));
    return states;
  };
  await db.query('UPDATE public.report_cases SET reporter=$1,reported_uid=$2 WHERE id=$3', [peer, owner, otherCase]);
  await versions([0, 0, 0]);
  await db.query('UPDATE public.report_cases SET reporter=$1,reported_uid=$2 WHERE id=$3', [unrelated, 'synthetic_legacy_subject', otherCase]);
  await db.query('INSERT INTO public.report_evidence_holds(case_id,hold_ref) VALUES($1,$2)', [caseId, holdRef]);
  await versions([1, 1, 0]);
  await setHold(db, caseId, holdRef, true);
  await setHold(db, caseId, randomUUID(), false);
  await db.exec('RESET ROLE');
  await db.query('UPDATE public.report_evidence_holds SET case_id=case_id,hold_ref=hold_ref,created_at=clock_timestamp() WHERE case_id=$1', [caseId]);
  await db.query("UPDATE public.report_cases SET reporter=reporter,reported_uid=reported_uid,status='under_review' WHERE id=$1", [caseId]);
  await versions([1, 1, 0]);
  await db.query('UPDATE public.report_cases SET reporter=$1 WHERE id=$2', [peer, caseId]);
  assert.equal((await versions([2, 2, 0]))[0].hold_status, 'clear');
  await db.query('UPDATE public.report_cases SET reported_uid=$1 WHERE id=$2', [owner, caseId]);
  assert.equal((await versions([3, 3, 0]))[0].hold_status, 'held');
  await db.query('UPDATE public.report_cases SET reporter=$1,reported_uid=$2 WHERE id=$3', [owner, peer, caseId]);
  await versions([4, 4, 0]);
  await assert.rejects(db.query('UPDATE public.report_cases SET reporter=NULL WHERE id=$1', [caseId]), { code: 'PT409' });
  await assert.rejects(db.query('UPDATE public.report_cases SET id=$1 WHERE id=$2', [randomUUID(), caseId]), { code: '23503' });
  await versions([4, 4, 0]);
  await db.query('UPDATE public.report_evidence_holds SET case_id=$1 WHERE case_id=$2', [otherCase, caseId]);
  assert.deepEqual((await versions([5, 5, 1])).map(state => state.hold_status), ['clear', 'clear', 'held']);
  await db.query('UPDATE public.report_evidence_holds SET case_id=$1 WHERE case_id=$2', [caseId, otherCase]);
  await versions([6, 6, 2]);
  const changedRef = randomUUID();
  await db.query('UPDATE public.report_evidence_holds SET hold_ref=$1 WHERE case_id=$2', [changedRef, caseId]);
  await versions([7, 7, 2]);
  await db.query('UPDATE public.report_evidence_holds SET hold_ref=$1 WHERE case_id=$2', [holdRef, caseId]);
  await versions([8, 8, 2]);
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [caseId]);
  await db.query('DELETE FROM public.report_cases WHERE id=$1', [caseId]);
  assert.ok((await versions([9, 9, 2])).every(state => state.hold_status === 'clear'));
});

test('F2: history upgrade preserves existing holds and epochs, denies raw mutation and fails closed on unknown mappings', async context => {
  const db = await fixture(context, true, true), reservation = await cancelled(db);
  const plan = await prepare(db, reservation), approval = randomUUID();
  await confirm(db, plan, approval);
  assert.equal(Object.hasOwn(await holdState(db), 'report_hold_version'), false);
  const caseId = randomUUID(), holdRef = randomUUID();
  await db.query('INSERT INTO public.report_cases(id,reporter,reported_uid) VALUES($1,$2,$3)', [caseId, peer, owner]);
  await setHold(db, caseId, holdRef, true);
  await db.exec('RESET ROLE');
  await db.exec(historyUpgrade);
  assert.deepEqual(await holdState(db), { hold_status: 'held', hold_version: 0, report_hold_version: 0 });
  await setHold(db, caseId, holdRef, false);
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  const released = await holdState(db);
  assert.equal(released.report_hold_version, 1);
  await db.exec(historyUpgrade);
  await db.exec(historyUpgrade);
  assert.deepEqual(await holdState(db), released);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgfoid='public.account_rights_report_hold_transition()'::regprocedure")).rows[0].count, 4);
  for (const role of ['anon', 'authenticated', 'service_role', 'inherited_service']) {
    await identity(db, owner, role);
    for (const command of [
      'SELECT * FROM public.account_rights_report_hold_epochs',
      `INSERT INTO public.account_rights_report_hold_epochs(owner_id,version) VALUES('${owner}',1)`,
      'UPDATE public.account_rights_report_hold_epochs SET version=1',
      'DELETE FROM public.account_rights_report_hold_epochs',
      'TRUNCATE public.account_rights_report_hold_epochs',
      'SELECT public.account_rights_report_hold_transition()',
      'SELECT public.account_rights_install_report_hold_history()'
    ]) await assert.rejects(db.exec(command), { code: '42501' });
  }
  assert.deepEqual(await holdState(db), released);
  await assert.rejects(db.exec('TRUNCATE public.report_evidence_holds'), { code: 'PT409' });
  assert.equal((await holdState(db, null)).hold_status, 'unknown');
  for (const change of [
    'ALTER TABLE public.report_cases RENAME COLUMN reported_uid TO unknown_subject',
    'ALTER TABLE public.report_evidence_holds RENAME COLUMN hold_ref TO unknown_hold',
    'ALTER TABLE public.report_evidence_holds DISABLE TRIGGER account_rights_report_hold_transition',
    'ALTER TABLE public.report_cases DISABLE TRIGGER account_rights_report_hold_mapping'
  ]) {
    await db.exec('RESET ROLE; BEGIN; ' + change);
    const unknown = await holdState(db);
    assert.equal(unknown.hold_status, 'unknown');
    assert.equal(unknown.report_hold_version, null);
    await assert.rejects(prepare(db, reservation), error => error.code === 'PT409' && /unknown evidence holds/i.test(error.message));
    await db.exec('ROLLBACK');
  }
  assert.deepEqual(await holdState(db), released);
});

test('F2: an expired unapproved dry run can be replaced for the same object with a new hold-bound digest and approval', async context => {
  const db = await fixture(context), reservation = await cancelled(db), caseId = randomUUID(), holdRef = randomUUID();
  await db.query('INSERT INTO public.report_cases(id,reporter,reported_uid) VALUES($1,$2,$3)', [caseId, owner, peer]);
  const old = await prepare(db, reservation);
  await setHold(db, caseId, holdRef, true);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  await setHold(db, caseId, holdRef, false);
  await assert.rejects(confirm(db, old), { code: 'PT409' });
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [old.plan_id]);
  const fresh = await prepare(db, reservation);
  assert.notEqual(fresh.snapshot_sha256, old.snapshot_sha256);
  assert.deepEqual(fresh.objects, old.objects);
  assert.equal(fresh.reservation_id, old.reservation_id);
  await confirm(db, fresh);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [reservation.stored.id])).rows.length, 1);
});