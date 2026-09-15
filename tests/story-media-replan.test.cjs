'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, reserve, upload, approve, owner, hash } = require('./story-media-sql.test.cjs');
const { holdsFixture, cancelled, prepare, confirm } = require('./story-media-cleanup.test.cjs');

async function cancelPlan(db, plan, reference = randomUUID()) {
  await identity(db, null, 'service_role');
  return rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]);
}

async function records(db) {
  await db.exec('RESET ROLE');
  return (await db.query(`SELECT jsonb_build_object(
    'plans',(SELECT jsonb_agg(plan ORDER BY id) FROM public.story_media_cleanup_plans AS plan),
    'intents',(SELECT jsonb_agg(intent ORDER BY id) FROM public.story_media_cleanup_intents AS intent),
    'objects',(SELECT jsonb_agg(stored ORDER BY id) FROM storage.objects AS stored),
    'reservations',(SELECT jsonb_agg(reservation ORDER BY id) FROM public.story_media_reservations AS reservation)
  ) AS result`)).rows[0].result;
}

async function rejectMutation(db, plan, mutation, parameters = []) {
  await db.exec('RESET ROLE; BEGIN');
  try {
    await db.query(mutation, parameters);
    const before = await records(db);
    await db.exec('SAVEPOINT cancellation_call');
    await assert.rejects(cancelPlan(db, plan), { code: 'PT409' }, mutation);
    await db.exec('ROLLBACK TO SAVEPOINT cancellation_call');
    assert.deepEqual(await records(db), before, mutation);
  } finally {
    await db.exec('ROLLBACK; RESET ROLE');
  }
}

test('R1: a report hold cycle requires safe supersession and a separately approved fresh cleanup plan', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation), approval = randomUUID();
  await confirm(db, plan, approval);
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  const workerArgs = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
  const before = await records(db), report = randomUUID(), hold = randomUUID();
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [report, owner, owner]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [report, hold]);
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', workerArgs), { code: 'PT409' });
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [report]);
  const holds = await rpc(db, 'account_rights_hold_state', [owner]);
  assert.equal(holds.hold_status, 'clear');
  assert.ok(Number(holds.report_hold_version) > Number(before.plans[0].holds.report_hold_version));
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });

  const reference = randomUUID(), retired = await cancelPlan(db, plan, reference);
  assert.ok(retired.superseded_at);
  assert.equal(retired.cancellation_ref, reference);
  assert.equal(retired.storage_delete_authorized, false);
  assert.equal(retired.physical_delete_confirmed, false);
  assert.deepEqual(await cancelPlan(db, plan, reference), retired);
  const after = await records(db);
  assert.deepEqual(after.objects, before.objects);
  assert.deepEqual(after.reservations, before.reservations);
  assert.deepEqual(after.plans, before.plans.map(previous => ({
    ...previous, superseded_at: retired.superseded_at, cancellation_ref: reference
  })));
  assert.deepEqual(after.intents, before.intents.map(previous => ({ ...previous, cancelled_at: retired.superseded_at })));

  const fresh = await prepare(db, reservation);
  assert.notEqual(fresh.plan_id, plan.plan_id);
  assert.notEqual(fresh.operation_id, plan.operation_id);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256);
  assert.equal(fresh.dry_run, true);
  assert.equal(fresh.approval_ref, null);
  assert.equal(fresh.lease_token, null);
  assert.equal(fresh.storage_delete_authorized, false);
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', workerArgs), { code: 'PT409' });
  await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...workerArgs, 'unknown', 0, null, 0]), { code: 'PT409' });
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });
  await assert.rejects(confirm(db, fresh, approval), { code: 'PT409' });
  const next = await confirm(db, fresh);
  assert.equal(next.storage_delete_authorized, true);
  assert.notEqual(next.approval_ref, approval);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', workerArgs), { code: 'PT409' });
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 10]);
  assert.equal(inventory.items[0].pending_intents.length, 1);
  assert.equal(inventory.items[0].pending_intents[0].claim_id, fresh.plan_id);
  assert.deepEqual((await records(db)).objects, before.objects);
});

test('R1: expired untouched approvals recover without resurrecting their still-valid worker token', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation), approval = randomUUID();
  await confirm(db, plan, approval);
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [plan.plan_id]);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  const retired = await cancelPlan(db, plan);
  assert.deepEqual(await prepare(db, reservation, undefined, plan.operation_id), retired);
  const fresh = await prepare(db, reservation);
  assert.equal(fresh.snapshot_sha256, plan.snapshot_sha256);
  await assert.rejects(confirm(db, fresh, approval), { code: 'PT409' });
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  const args = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', args), { code: 'PT409' });
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });
  await confirm(db, fresh);
  const next = await rpc(db, 'claim_story_media_cleanup', [fresh.operation_id, fresh.plan_id]);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', args), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [next.operation_id, next.claim_id, next.objects[0].intent_id, worker.lease_token]), { code: 'PT409' });
});

test('R1: planned cancellation may mark an active hold but cannot replan or delete while it remains held', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation), report = randomUUID();
  const before = await records(db);
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [report, owner, owner]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [report, randomUUID()]);
  const retired = await cancelPlan(db, plan);
  assert.equal(retired.dry_run, false);
  assert.equal(retired.storage_delete_authorized, false);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 10]);
  assert.equal(inventory.items[0].pending_intents.length, 0);
  assert.deepEqual((await records(db)).objects, before.objects);
  assert.equal((await db.query('SELECT * FROM public.report_evidence_holds')).rows.length, 1);
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [report]);
  assert.equal((await prepare(db, reservation)).dry_run, true);
});

test('R1: cancellation requires exact service role, snapshot and an immutable idempotency reference', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation), reference = randomUUID(), before = await records(db);
  for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_service']) {
    await identity(db, null, role);
    await assert.rejects(rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]), { code: '42501' });
    await assert.rejects(db.query('UPDATE public.story_media_cleanup_intents SET cancelled_at=now() WHERE plan_id=$1', [plan.plan_id]), { code: '42501' });
  }
  await db.exec('RESET ROLE');
  await assert.rejects(rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]), { code: '42501' });
  await identity(db, null, 'service_role');
  for (const args of [[randomUUID(), plan.snapshot_sha256, reference], [plan.plan_id, null, reference],
    [plan.plan_id, 'b'.repeat(64), reference], [plan.plan_id, plan.snapshot_sha256, null]]) {
    await assert.rejects(rpc(db, 'cancel_story_media_cleanup', args), { code: 'PT409' });
  }
  assert.deepEqual(await records(db), before);
  const retired = await cancelPlan(db, plan, reference);
  assert.deepEqual(await cancelPlan(db, plan, reference), retired);
  await assert.rejects(cancelPlan(db, plan, randomUUID()), { code: 'PT409' });
  await identity(db, null, 'service_role');
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_plans SET superseded_at=NULL,cancellation_ref=NULL WHERE id=$1', [plan.plan_id]), { code: '42501' });
});

test('R1: every attempted-delete or uncertain evidence field forbids supersession without changing inventory', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation);
  await confirm(db, plan);
  const mutations = ["state='object_delete_requested'", "state='unknown'", "outcome='unknown'",
    'delete_attempts=1', 'delete_requested_at=now()', 'metadata_deleted_at=now()', 'request_lease_token=gen_random_uuid()',
    'authorized_delete_lease_token=gen_random_uuid()', 'delete_http_status=0', 'absence_http_status=404', "api_ack='{}'", 'observed_at=now()'];
  for (const mutation of mutations) {
    await rejectMutation(db, plan, `UPDATE public.story_media_cleanup_intents SET ${mutation} WHERE plan_id=$1`, [plan.plan_id]);
  }
  await rejectMutation(db, plan, "UPDATE public.story_media_cleanup_plans SET deleted_objects=jsonb_build_array(jsonb_build_object('object_id',$2::text)) WHERE id=$1",
    [plan.plan_id, reservation.stored.id]);
  await identity(db, null, 'service_role');
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  const args = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
  await rpc(db, 'request_story_media_cleanup_object', args);
  await rpc(db, 'finish_story_media_cleanup_object', [...args, 'unknown', 0, null, 0]);
  const before = await records(db);
  await assert.rejects(cancelPlan(db, plan), { code: 'PT409' });
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  const pending = (await rpc(db, 'preview_story_media_cleanup', [null, 10])).items[0].pending_intents[0];
  assert.equal(pending.claim_id, plan.plan_id);
  assert.equal(pending.state, 'unknown');
  assert.equal(pending.delete_attempts, 1);
  assert.deepEqual(await records(db), before);
});

test('R1: two-object cancellation requires complete exact mapping and refuses partial attempted work atomically', async context => {
  const db = await database(context), reservation = await reserve(db), stored = await upload(db, reservation);
  await approve(db, reservation);
  await identity(db);
  const story = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  await rpc(db, 'delete_story', [story.id, randomUUID()]);
  await holdsFixture(db);
  await db.exec('RESET ROLE');
  const { epoch } = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  const target = { ...reservation, stored, epoch }, ids = [stored.id, reservation.public_object_id];
  const plan = await prepare(db, target, ids), approval = randomUUID();
  const approved = await confirm(db, plan, approval);
  const previousWorker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  const previousArgs = [previousWorker.operation_id, previousWorker.claim_id, previousWorker.objects[0].intent_id, previousWorker.lease_token];
  const object = plan.objects[1];
  await rejectMutation(db, plan, 'DELETE FROM public.story_media_cleanup_intents WHERE plan_id=$1 AND object_id=$2', [plan.plan_id, object.object_id]);
  for (const mutation of ["object_version='wrong-version'", 'owner=gen_random_uuid()', "state='unknown'"]) {
    await rejectMutation(db, plan, `UPDATE public.story_media_cleanup_intents SET ${mutation} WHERE plan_id=$1 AND object_id=$2`, [plan.plan_id, object.object_id]);
  }
  await rejectMutation(db, plan, 'UPDATE public.story_media_cleanup_plans SET objects=jsonb_build_array(objects->0,objects->0) WHERE id=$1', [plan.plan_id]);
  await db.exec('RESET ROLE');
  const { epoch: nextEpoch } = (await db.query('UPDATE public.story_media_reservations SET epoch=epoch+1 WHERE id=$1 RETURNING epoch', [reservation.reservation_id])).rows[0];
  await assert.rejects(confirm(db, plan, approval),
    error => error.code === 'PT409' && /Cleanup request changed/.test(error.message));
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', previousArgs), { code: 'PT409' });
  for (const objectId of ids) {
    await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [objectId]),
      error => error.code === 'PT409' && /Cleanup request changed/.test(error.message));
  }
  for (const mutation of ['owner=gen_random_uuid()', 'request_id=gen_random_uuid()', 'object_id=gen_random_uuid()', 'public_object_id=gen_random_uuid()']) {
    await rejectMutation(db, plan, `UPDATE public.story_media_reservations SET ${mutation} WHERE id=$1`, [reservation.reservation_id]);
  }
  const before = await records(db), retired = await cancelPlan(db, plan);
  const after = await records(db);
  assert.ok(retired.superseded_at);
  assert.equal(retired.storage_delete_authorized, false);
  assert.equal(retired.physical_delete_confirmed, false);
  assert.equal(after.intents.length, 2);
  assert.ok(after.intents.every(intent => intent.cancelled_at === retired.superseded_at));
  assert.deepEqual(after.intents, before.intents.map(intent => ({ ...intent, cancelled_at: retired.superseded_at })));
  assert.deepEqual(after.plans, before.plans.map(previous => ({
    ...previous, superseded_at: retired.superseded_at, cancellation_ref: retired.cancellation_ref
  })));
  assert.deepEqual(after.objects, before.objects);
  assert.deepEqual(after.reservations, before.reservations);
  await assert.rejects(prepare(db, target, ids), { code: 'PT409' });
  const fresh = await prepare(db, { ...target, epoch: nextEpoch }, ids);
  assert.notEqual(fresh.plan_id, plan.plan_id);
  assert.notEqual(fresh.operation_id, plan.operation_id);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256);
  assert.equal(fresh.reservation_epoch, nextEpoch);
  assert.deepEqual(fresh.objects, plan.objects);
  assert.equal(fresh.dry_run, true);
  assert.equal(fresh.approval_ref, null);
  assert.equal(fresh.lease_token, null);
  assert.equal(fresh.storage_delete_authorized, false);
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', previousArgs), { code: 'PT409' });
  await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...previousArgs, 'unknown', 0, null, 0]), { code: 'PT409' });
  for (const objectId of ids) await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [objectId]), { code: 'PT403' });
  await assert.rejects(confirm(db, fresh, approval),
    error => error.code === 'PT409' && /Fresh independent cleanup approval reference required/.test(error.message));
  const next = await confirm(db, fresh);
  assert.equal(next.storage_delete_authorized, true);
  assert.notEqual(next.approval_ref, approval);
  assert.notEqual(next.lease_token, approved.lease_token);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', previousArgs), { code: 'PT409' });
  const worker = await rpc(db, 'claim_story_media_cleanup', [fresh.operation_id, fresh.plan_id]);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, previousWorker.lease_token]), { code: 'PT409' });
  const requested = await rpc(db, 'request_story_media_cleanup_object', [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token]);
  assert.equal(requested.delete_allowed, true);
  const attempted = await records(db);
  assert.deepEqual(attempted.objects, before.objects);
  await assert.rejects(cancelPlan(db, fresh), { code: 'PT409' });
  assert.deepEqual(await records(db), attempted);
});

test('R1: additive recovery upgrade is repeatable and preserves completed, unknown and F1 exact-lease evidence', async context => {
  const db = await database(context);
  await holdsFixture(db);
  const plans = [];
  for (const result of ['storage_api_deleted', 'storage_api_absent_backend_unknown']) {
    const reservation = await cancelled(db), plan = await prepare(db, reservation);
    await confirm(db, plan);
    const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
    const object = worker.objects[0], args = [worker.operation_id, worker.claim_id, object.intent_id, worker.lease_token];
    await rpc(db, 'request_story_media_cleanup_object', args);
    await db.query('DELETE FROM storage.objects WHERE id=$1', [object.object_id]);
    const ack = { name: object.object_key, id: object.object_id, bucket_id: object.bucket };
    if (result === 'storage_api_deleted') {
      await rpc(db, 'finish_story_media_cleanup_object', [...args, result, 200, ack, 404]);
    } else {
      await db.exec('RESET ROLE');
      await db.query("UPDATE public.story_media_cleanup_plans SET worker_lease_until=now()-interval '1 second' WHERE id=$1", [plan.plan_id]);
      await identity(db, null, 'service_role');
      const next = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
      const nextArgs = [...args.slice(0, 3), next.lease_token];
      assert.equal((await rpc(db, 'request_story_media_cleanup_object', nextArgs)).delete_allowed, false);
      await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...nextArgs, 'storage_api_deleted', 200, ack, 404]),
        error => error.code === 'PT409' && /this exact worker lease/.test(error.message));
      await rpc(db, 'finish_story_media_cleanup_object', [...nextArgs, result, 0, null, 404]);
    }
    plans.push({ plan, reservation });
  }
  const before = await records(db);
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/story-media.sql'), 'utf8');
  const schema = sql.match(/DO \$cleanup_recovery_schema\$[\s\S]*?\$cleanup_recovery_schema\$;/);
  assert.ok(schema);
  const routines = ['_story_media_cleanup_receipt', '_story_media_cleanup_policy_check', 'cancel_story_media_cleanup',
    'prepare_story_media_cleanup', 'confirm_story_media_cleanup', '_story_media_cleanup_delete', 'preview_story_media_cleanup'];
  const definitions = routines.map(name => {
    const definition = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`));
    assert.ok(definition, name);
    return definition[0];
  });
  const grants = sql.slice(sql.indexOf('DO $grants$'), sql.lastIndexOf('COMMIT;'));
  const upgrade = ['BEGIN;', schema[0], ...definitions, grants, 'COMMIT;'].join('\n');
  await db.exec(`ALTER TABLE public.story_media_cleanup_intents DROP COLUMN cancelled_at;
    ALTER TABLE public.story_media_cleanup_plans DROP COLUMN cancellation_ref,DROP COLUMN superseded_at;`);
  await db.exec(upgrade);
  assert.deepEqual(await records(db), before);
  const reservation = await cancelled(db), plan = await prepare(db, reservation), reference = randomUUID();
  const retired = await cancelPlan(db, plan, reference), withCancellation = await records(db);
  await db.exec(upgrade);
  assert.deepEqual(await records(db), withCancellation);
  assert.deepEqual(await cancelPlan(db, plan, reference), retired);
  for (const previous of plans) {
    await assert.rejects(cancelPlan(db, previous.plan), { code: 'PT409' });
    await assert.rejects(prepare(db, previous.reservation), { code: 'PT409' });
  }
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 10]);
  const pending = inventory.items.flatMap(item => item.pending_intents);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].claim_id, plans[1].plan.plan_id);
  assert.equal(pending[0].outcome, 'storage_api_absent_backend_unknown');
  assert.deepEqual(await records(db), withCancellation);
  await identity(db, null, 'anon');
  await assert.rejects(rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]), { code: '42501' });
});