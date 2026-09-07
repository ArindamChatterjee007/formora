'use strict';
// ---------------------------------------------------------------------------
// INDEPENDENT RETEST of the parent's exact-lease delete-authorization repair.
// 2026-09-07. Written by the retester, not by the fix owner.
//
// Why this file exists: the repair to public.finish_story_media_cleanup_object
// (supabase/story-media.sql) landed together with rewritten expectations in
// tests/story-media-cleanup-independent.test.cjs C-4/C-5. Those cases are now
// fix-owner-authored, so on their own they cannot serve as independent evidence
// that the guard holds. This file re-derives the three properties from the SQL
// text alone, in one PGlite database, in one serial case.
//
// Scope of what a pass here means:
//   - local PGlite semantics of the SQL in supabase/story-media.sql only;
//   - NOT hosted PostgREST/Storage behaviour, NOT real object erasure,
//     NOT release approval, NOT a rerun of any other suite.
// The parent's F-2 (report evidence holds leave no version trace) is NOT
// covered here and remains open; see the retest report.
//
// This file writes nothing outside itself and mutates no product source.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, upload, owner, peer, policy } = require('./story-media-sql.test.cjs');

const root = path.join(__dirname, '..');
const service = (db) => identity(db, null, 'service_role');
const superuser = (db) => db.exec('RESET ROLE');

// Minimal rights/report mapping: _story_media_cleanup_holds refuses to run without it.
async function mapping(db) {
  await db.exec(`RESET ROLE;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,deleted_at timestamptz,is_anonymous boolean DEFAULT false);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid,reported_uid text);
    CREATE TABLE public.report_evidence_holds(case_id uuid REFERENCES public.report_cases(id),hold_ref uuid);`);
  for (const actor of [owner, peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, actor + '@example.invalid']);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/account-rights.sql'), 'utf8'));
  await db.exec('RESET ROLE; UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
}

// One cancelled reservation holding exactly one retained private object.
async function subject(db) {
  await identity(db, owner);
  const reservation = await rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 500]);
  const stored = await upload(db, reservation, owner);
  await identity(db, owner);
  await rpc(db, 'cancel_story_media', [reservation.request_id]);
  await superuser(db);
  const row = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  return { ...reservation, epoch: row.epoch, stored };
}

// Drive a subject up to a live worker lease over its single object.
async function leased(db) {
  const target = await subject(db);
  const operation = randomUUID();
  await service(db);
  const plan = await rpc(db, 'prepare_story_media_cleanup', [operation, target.reservation_id, target.epoch, [target.stored.id], policy]);
  await service(db);
  await rpc(db, 'confirm_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, randomUUID()]);
  await service(db);
  const claim = await rpc(db, 'claim_story_media_cleanup', [operation, null]);
  return { target, operation, plan, claim, intent: claim.objects[0] };
}

const reclaim = async (db, operation, planId) => {
  await superuser(db);
  await db.query(`UPDATE public.story_media_cleanup_plans
    SET worker_lease_until = pg_catalog.clock_timestamp() - interval '1 second' WHERE id=$1`, [planId]);
  await service(db);
  return rpc(db, 'claim_story_media_cleanup', [operation, planId]);
};
const request = async (db, claim, intentId) => {
  await service(db);
  return rpc(db, 'request_story_media_cleanup_object', [claim.operation_id, claim.claim_id, intentId, claim.lease_token]);
};
const finish = async (db, claim, intentId, result, deleteStatus, ack, getStatus) => {
  await service(db);
  return (await db.query(`SELECT public.finish_story_media_cleanup_object($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::integer,$7::jsonb,$8::integer) AS result`,
    [claim.operation_id, claim.claim_id, intentId, claim.lease_token, result, deleteStatus,
      ack === null || ack === undefined ? null : JSON.stringify(ack), getStatus])).rows[0].result;
};
const purge = async (db, objectId) => {
  await service(db);
  return (await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [objectId])).rows.length;
};
const intentRow = async (db, id) => {
  await superuser(db);
  return (await db.query('SELECT * FROM public.story_media_cleanup_intents WHERE id=$1', [id])).rows[0];
};
const planAttempts = async (db, planId) => {
  await superuser(db);
  return (await db.query('SELECT worker_attempts,status FROM public.story_media_cleanup_plans WHERE id=$1', [planId])).rows[0];
};
const inventoryFor = async (db, reservationId) => {
  await service(db);
  const listed = await rpc(db, 'preview_story_media_cleanup', [null, 50]);
  return listed.items.find(entry => entry.reservation_id === reservationId) || null;
};
const ackFor = (intent) => ({ name: intent.object_key, id: intent.object_id, bucket_id: intent.bucket });

test('R-1 completion requires a delete authorized under the exact current worker lease; retry replay and a genuine re-authorized delete still work', async context => {
  const db = await database(context);
  await mapping(db);

  // -------------------------------------------------------------------------
  // A. The honest success path still completes, and its replay is idempotent.
  // -------------------------------------------------------------------------
  const good = await leased(db);
  const goodAck = ackFor(good.intent);
  assert.equal((await request(db, good.claim, good.intent.intent_id)).delete_allowed, true);
  assert.equal(await purge(db, good.target.stored.id), 1, 'the plan authorizes exactly one owned catalog delete');
  const completed = await finish(db, good.claim, good.intent.intent_id, 'storage_api_deleted', 200, goodAck, 404);
  assert.equal(completed.objects[0].state, 'completed');
  assert.equal(completed.objects[0].outcome, 'storage_api_deleted');
  assert.equal(completed.physical_delete_confirmed, false, 'completion is Storage API visibility only');
  assert.equal(completed.account_deleted, false);
  assert.deepEqual(await finish(db, good.claim, good.intent.intent_id, 'storage_api_deleted', 200, goodAck, 404), completed,
    'an identical replay under the same lease is idempotent');
  const goodRow = await intentRow(db, good.intent.intent_id);
  assert.equal(goodRow.authorized_delete_lease_token, good.claim.lease_token);
  assert.equal(goodRow.request_lease_token, good.claim.lease_token);
  assert.equal(goodRow.delete_attempts, 1);
  assert.equal((await inventoryFor(db, good.target.reservation_id)), null, 'a completed intent leaves the pending inventory');

  // A completed plan hands back its receipt without minting a new lease or spending worker budget.
  const before = await planAttempts(db, good.plan.plan_id);
  const settled = await reclaim(db, good.operation, good.plan.plan_id);
  assert.equal(settled.claim_id, good.plan.plan_id);
  assert.equal(settled.lease_token, good.claim.lease_token, 'no fresh authorization is issued for finished work');
  assert.deepEqual(await planAttempts(db, good.plan.plan_id), before, 'a settled plan consumes no worker attempt');

  // -------------------------------------------------------------------------
  // B. F-1: a later lease that was never authorized to delete cannot complete
  //    the earlier delete audit, and the pending record is preserved.
  // -------------------------------------------------------------------------
  const lost = await leased(db);
  const lostAck = ackFor(lost.intent);
  assert.equal((await request(db, lost.claim, lost.intent.intent_id)).delete_allowed, true);
  assert.equal(await purge(db, lost.target.stored.id), 1);
  // The worker's DELETE succeeded but its acknowledgement never arrived.
  assert.equal((await finish(db, lost.claim, lost.intent.intent_id, 'unknown', 200, null, 0)).objects[0].state, 'unknown');

  const retryClaim = await reclaim(db, lost.operation, lost.plan.plan_id);
  assert.notEqual(retryClaim.lease_token, lost.claim.lease_token, 'the retry runs under a different worker lease');
  const readback = await request(db, retryClaim, lost.intent.intent_id);
  assert.equal(readback.delete_allowed, false, 'an absent object is never re-authorized for deletion');
  assert.equal(readback.objects[0].delete_attempts, 1, 'the readback spends no delete budget');

  const pending = await inventoryFor(db, lost.target.reservation_id);
  assert.equal(pending.pending_intents.length, 1);
  await assert.rejects(finish(db, retryClaim, lost.intent.intent_id, 'storage_api_deleted', 200, lostAck, 404), { code: 'PT409' },
    'F-1: a readback-only lease cannot upgrade an unacknowledged delete to completed');
  assert.deepEqual(await inventoryFor(db, lost.target.reservation_id), pending,
    'the refusal preserves the pending inventory exactly');

  // The guard is keyed to the intent's authorization, not to the plan or the request lease.
  const lostRow = await intentRow(db, lost.intent.intent_id);
  assert.equal(lostRow.authorized_delete_lease_token, lost.claim.lease_token, 'authorization stays pinned to the lease that issued the DELETE');
  assert.equal(lostRow.request_lease_token, retryClaim.lease_token);
  assert.notEqual(lostRow.authorized_delete_lease_token, lostRow.request_lease_token);
  assert.equal(lostRow.state, 'unknown');
  assert.equal(lostRow.outcome, 'unknown');

  // Conservative labelling is still reachable, and it is not completion.
  const conservative = await finish(db, retryClaim, lost.intent.intent_id, 'storage_api_absent_backend_unknown', 0, null, 404);
  assert.equal(conservative.objects[0].outcome, 'storage_api_absent_backend_unknown');
  assert.equal(conservative.objects[0].state, 'unknown');
  await assert.rejects(finish(db, retryClaim, lost.intent.intent_id, 'storage_api_deleted', 200, lostAck, 404), { code: 'PT409' },
    'backend-unknown cannot be laundered into completion by a repeat call');
  assert.ok(await inventoryFor(db, lost.target.reservation_id), 'backend-unknown work stays inventoried for operator review');

  // Even the raw journal cannot be edited into completion from the service role.
  await service(db);
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_intents SET state=$1 WHERE id=$2', ['completed', lost.intent.intent_id]),
    { code: '42501' }, 'service_role has no direct write on the durable journal');

  // -------------------------------------------------------------------------
  // C. The guard is not over-strict: a retry that really re-authorizes and
  //    really deletes still completes, and spends a second delete attempt.
  // -------------------------------------------------------------------------
  const retried = await leased(db);
  const retriedAck = ackFor(retried.intent);
  assert.equal((await request(db, retried.claim, retried.intent.intent_id)).delete_allowed, true);
  // The DELETE never reached Storage; the object is still catalogued.
  assert.equal((await finish(db, retried.claim, retried.intent.intent_id, 'unknown', 0, null, 0)).objects[0].state, 'unknown');

  const secondClaim = await reclaim(db, retried.operation, retried.plan.plan_id);
  const reauthorized = await request(db, secondClaim, retried.intent.intent_id);
  assert.equal(reauthorized.delete_allowed, true, 'a still-present object may be re-authorized under the new lease');
  assert.equal(reauthorized.objects[0].delete_attempts, 2, 'the second authorization spends a second delete attempt');
  assert.equal(await purge(db, retried.target.stored.id), 1);
  const settledRetry = await finish(db, secondClaim, retried.intent.intent_id, 'storage_api_deleted', 200, retriedAck, 404);
  assert.equal(settledRetry.objects[0].state, 'completed');
  const retriedRow = await intentRow(db, retried.intent.intent_id);
  assert.equal(retriedRow.authorized_delete_lease_token, secondClaim.lease_token);
  assert.equal(retriedRow.request_lease_token, secondClaim.lease_token);
  assert.equal(retriedRow.delete_attempts, 2);
  assert.equal((await planAttempts(db, retried.plan.plan_id)).status, 'metadata_deleted');

  // Nothing in this pass ever claims physical erasure.
  await superuser(db);
  const audits = (await db.query('SELECT deleted_objects FROM public.story_media_cleanup_plans')).rows;
  for (const audit of audits) for (const entry of audit.deleted_objects) assert.equal(entry.physical_delete_confirmed, false);
});
