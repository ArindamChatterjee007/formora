'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, reserve, upload, approve, owner, policy, hash } = require('./story-media-sql.test.cjs');

async function holdsFixture(db) {
  await db.exec(`RESET ROLE;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,deleted_at timestamptz,is_anonymous boolean DEFAULT false);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid,reported_uid text);
    CREATE TABLE public.report_evidence_holds(case_id uuid REFERENCES public.report_cases(id),hold_ref uuid);
    CREATE TABLE public.billing_events(id text PRIMARY KEY,receipt text);
    INSERT INTO public.billing_events VALUES('synthetic-preservation-sentinel','must remain');`);
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [owner, 'synthetic@example.invalid']);
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/account-rights.sql'), 'utf8'));
  await identity(db, null, 'service_role');
  await db.exec('UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
}
async function cancelled(db) {
  const reservation = await reserve(db), stored = await upload(db, reservation);
  await rpc(db, 'cancel_story_media', [reservation.request_id]);
  await db.exec('RESET ROLE');
  const row = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  return { ...reservation, epoch: row.epoch, stored };
}
async function prepare(db, reservation, ids = [reservation.stored.id], operation = randomUUID()) {
  await identity(db, null, 'service_role');
  return rpc(db, 'prepare_story_media_cleanup', [operation, reservation.reservation_id, reservation.epoch, ids, policy]);
}
async function confirm(db, plan, approval = randomUUID()) {
  await identity(db, null, 'service_role');
  return rpc(db, 'confirm_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, approval]);
}

module.exports = { holdsFixture, cancelled, prepare, confirm };

if (require.main === module) {
test('cleanup defaults off and missing or unknown hold mapping cannot create a plan or erase metadata', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await assert.rejects(prepare(db, reservation), { code: 'PT503' });
  await db.exec('UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT * FROM public.story_media_cleanup_plans')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 1);
});

test('cleanup dry run binds exact IDs versions owner epoch and policy but never authorizes deletion', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  for (const ids of [[], [reservation.stored.id, reservation.stored.id], [randomUUID(), randomUUID(), randomUUID()]]) {
    await assert.rejects(prepare(db, reservation, ids), { code: '22023' });
  }
  await assert.rejects(prepare(db, reservation, [randomUUID()]), { code: 'PT409' });
  await assert.rejects(prepare(db, { ...reservation, epoch: reservation.epoch + 1 }), { code: 'PT409' });
  const operation = randomUUID(), plan = await prepare(db, reservation, undefined, operation);
  assert.equal(plan.dry_run, true); assert.equal(plan.storage_delete_authorized, false); assert.equal(plan.physical_delete_confirmed, false);
  assert.equal(plan.objects.length, 1); assert.equal(plan.objects[0].object_version, reservation.stored.version);
  assert.equal(plan.objects[0].object_id, reservation.stored.id); assert.equal(plan.retention_policy_ref, policy);
  assert.deepEqual(await prepare(db, reservation, undefined, operation), plan);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
  await db.exec("SELECT set_config('app.story_media_cleanup','pretend-approved',false)");
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });
  await assert.rejects(rpc(db, 'confirm_story_media_cleanup', [plan.plan_id, 'b'.repeat(64), randomUUID()]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'confirm_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, null]), { code: 'PT409' });
});

test('only confirmed exact service cleanup can delete synthetic metadata and audit never claims physical erasure', async context => {
  const db = await database(context), target = await cancelled(db), untouched = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, target), approval = randomUUID(), claimed = await confirm(db, plan, approval);
  assert.equal(claimed.storage_delete_authorized, true); assert.ok(claimed.lease_token);
  assert.deepEqual(await confirm(db, plan, approval), claimed);
  await identity(db, null, 'inherited_service');
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [target.stored.id]), { code: 'PT403' });
  await identity(db, null, 'service_role');
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [untouched.stored.id]), { code: 'PT403' });
  await assert.rejects(db.query('UPDATE storage.objects SET version=$1 WHERE id=$2', ['forged-version', target.stored.id]), { code: 'PT403' });
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [target.stored.id])).rows.length, 1);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [target.stored.id])).rows.length, 0);
  const replay = await confirm(db, plan, approval);
  assert.equal(replay.status, 'metadata_deleted'); assert.equal(replay.storage_delete_authorized, false); assert.equal(replay.physical_delete_confirmed, false);
  assert.equal(replay.lease_token, claimed.lease_token); assert.equal(replay.lease_until, claimed.lease_until);
  await assert.rejects(confirm(db, plan, randomUUID()), { code: 'PT409' });
  await assert.rejects(db.exec("UPDATE public.story_media_cleanup_plans SET status='claimed'"), { code: '42501' });
  await db.exec('RESET ROLE');
  const audit = (await db.query('SELECT * FROM public.story_media_cleanup_plans WHERE id=$1', [plan.plan_id])).rows[0];
  assert.equal(audit.status, 'metadata_deleted'); assert.equal(audit.approval_ref, approval);
  assert.equal(audit.deleted_objects.length, 1); assert.equal(audit.deleted_objects[0].physical_delete_confirmed, false);
  assert.equal((await db.query('SELECT receipt FROM public.billing_events')).rows[0].receipt, 'must remain');
  assert.equal((await db.query('SELECT * FROM public.story_media_reservations')).rows.length, 2);
  assert.equal((await db.query('SELECT * FROM storage.objects')).rows[0].id, untouched.stored.id);
});

test('N1: pending cleanup survives committed metadata deletion and plan expiry under its original operation', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const operation = randomUUID(), plan = await prepare(db, reservation, undefined, operation);
  await confirm(db, plan);
  await db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [plan.plan_id]);
  await identity(db, null, 'service_role');
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 10]);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].reservation_id, reservation.reservation_id);
  const intent = inventory.items[0].pending_intents[0];
  assert.equal(intent.operation_id, operation);
  assert.equal(intent.object_id, reservation.stored.id);
  assert.equal(intent.object_version, reservation.stored.version);
  assert.equal(intent.state, 'object_delete_requested');
  assert.equal(intent.physical_delete_confirmed, false);
  const replay = await prepare(db, reservation, undefined, operation);
  assert.equal(replay.plan_id, plan.plan_id);
  assert.equal(replay.snapshot_sha256, plan.snapshot_sha256);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
});

test('rights and report evidence holds are rechecked at confirmation and at the exact DELETE', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation);
  await db.exec('RESET ROLE');
  const rightsId = randomUUID(), reportId = randomUUID();
  await db.query("INSERT INTO public.account_rights_requests(id,owner_id,request_id,kind,payload) VALUES($1,$2,$3,'erasure','{}')", [rightsId, owner, randomUUID()]);
  await db.query('INSERT INTO public.account_rights_holds(request_ref,hold_ref) VALUES($1,$2)', [rightsId, randomUUID()]);
  await assert.rejects(confirm(db, plan), { code: 'PT409' });
  await db.exec('RESET ROLE');
  await db.query('DELETE FROM public.account_rights_holds WHERE request_ref=$1', [rightsId]);
  const claimed = await confirm(db, plan);
  await db.exec('RESET ROLE');
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [reportId, owner, owner]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [reportId, randomUUID()]);
  await identity(db, null, 'service_role');
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT409' });
  await db.exec('RESET ROLE');
  const before = JSON.stringify((await db.query('SELECT * FROM public.account_rights_requests')).rows);
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [reportId]);
  await identity(db, null, 'service_role');
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [reservation.stored.id])).rows.length, 1);
  await db.exec('RESET ROLE');
  assert.equal(JSON.stringify((await db.query('SELECT * FROM public.account_rights_requests')).rows), before);
  assert.ok(claimed.lease_token);
});

test('published active Stories must tombstone before a bounded two-object cleanup claim', async context => {
  const db = await database(context), reservation = await reserve(db), stored = await upload(db, reservation);
  await approve(db, reservation); await identity(db);
  const published = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  await holdsFixture(db); await db.exec('RESET ROLE');
  const row = (await db.query('SELECT epoch,public_object_id FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  const exact = { ...reservation, epoch: row.epoch, stored }, ids = [stored.id, row.public_object_id];
  await assert.rejects(prepare(db, exact, ids), { code: 'PT409' });
  await identity(db); await rpc(db, 'delete_story', [published.id, randomUUID()]);
  const plan = await prepare(db, exact, ids); assert.equal(plan.objects.length, 2);
  const approval = randomUUID(), claimed = await confirm(db, plan, approval);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [ids[0]])).rows.length, 1);
  const partial = await confirm(db, plan, approval); assert.equal(partial.deleted_objects.length, 1);
  assert.equal(partial.lease_until, claimed.lease_until); assert.equal(partial.lease_token, claimed.lease_token);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [ids[1]])).rows.length, 1);
  await db.exec('RESET ROLE');
  assert.ok((await db.query('SELECT deleted_at FROM public.stories_v2 WHERE id=$1', [published.id])).rows[0].deleted_at);
  assert.equal((await db.query('SELECT sha256 FROM public.story_media_reservations')).rows[0].sha256, hash);
  assert.equal((await db.query('SELECT deleted_objects FROM public.story_media_cleanup_plans')).rows[0].deleted_objects.length, 2);
});

test('cleanup policy changes, expired leases and unknown report schemas prevent stale approvals', async context => {
  for (const change of ['policy', 'lease', 'schema']) {
    const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
    const plan = await prepare(db, reservation); await confirm(db, plan);
    if (change === 'policy') await db.exec('UPDATE public.story_media_settings SET cleanup_min_age_seconds=1');
    else {
      await db.exec('RESET ROLE');
      if (change === 'lease') await db.query("UPDATE public.story_media_cleanup_plans SET lease_until=now()-interval '1 second' WHERE id=$1", [plan.plan_id]);
      else await db.exec('ALTER TABLE public.report_cases RENAME COLUMN reported_uid TO unknown_subject');
    }
    await identity(db, null, 'service_role');
    await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: change === 'lease' ? 'PT403' : 'PT409' });
    assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 1);
  }
});
test('real rights hold and release actions invalidate a prior clear snapshot and their audit survives cleanup', async context => {
  const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
  await db.exec('RESET ROLE');
  const rightsId = randomUUID(), holdRef = randomUUID();
  await db.query("INSERT INTO public.account_rights_requests(id,owner_id,request_id,kind,payload) VALUES($1,$2,$3,'erasure','{}')", [rightsId, owner, randomUUID()]);
  const plan = await prepare(db, reservation);
  const held = await rpc(db, 'review_account_rights_request', [rightsId, owner, 1, 'hold', randomUUID(), holdRef, null]);
  await assert.rejects(confirm(db, plan), { code: 'PT409' });
  const released = await rpc(db, 'review_account_rights_request', [rightsId, owner, held.version, 'release_hold', randomUUID(), holdRef, null]);
  assert.equal(released.hold_status, 'clear'); assert.equal(Number(released.hold_version), 2);
  await assert.rejects(confirm(db, plan), { code: 'PT409' });
  await db.exec('RESET ROLE');
  const audit = JSON.stringify((await db.query('SELECT * FROM public.account_rights_actions ORDER BY previous_version')).rows);
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [plan.plan_id]);
  const fresh = await prepare(db, reservation); await confirm(db, fresh);
  await db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]);
  await db.exec('RESET ROLE');
  assert.equal(JSON.stringify((await db.query('SELECT * FROM public.account_rights_actions ORDER BY previous_version')).rows), audit);
  assert.equal((await db.query('SELECT * FROM public.account_rights_requests')).rows.length, 1);
});

test('R4 worker requires explicit approval and fences exact operation, object intent, role and current lease', async context => {
  const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
  const plan = await prepare(db, reservation);
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  await confirm(db, plan);
  for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_service']) {
    await identity(db, owner, role);
    await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: '42501' });
    await assert.rejects(db.query('SELECT * FROM public.story_media_cleanup_intents'), { code: '42501' });
  }
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, randomUUID()]), { code: 'PT409' });
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  assert.equal(worker.objects.length, 1); assert.equal(worker.objects[0].state, 'claimed');
  const args = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [...args.slice(0, 3), randomUUID()]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [args[0], args[1], randomUUID(), args[3]]), { code: 'PT409' });
  const requested = await rpc(db, 'request_story_media_cleanup_object', args);
  assert.equal(requested.delete_allowed, true); assert.equal(requested.objects[0].delete_attempts, 1);
  const replay = await rpc(db, 'request_story_media_cleanup_object', args);
  assert.equal(replay.delete_allowed, false); assert.equal(replay.objects[0].delete_attempts, 1);
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
});

test('R4 completion requires exact API ACK plus authenticated absence and is idempotent without physical erasure claims', async context => {
  const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
  const plan = await prepare(db, reservation); await confirm(db, plan);
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  const object = worker.objects[0], args = [worker.operation_id, worker.claim_id, object.intent_id, worker.lease_token];
  await rpc(db, 'request_story_media_cleanup_object', args);
  const ack = { name: object.object_key, id: object.object_id, bucket_id: object.bucket };
  await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...args, 'storage_api_deleted', 200, ack, 404]), { code: 'PT409' });
  await db.query('DELETE FROM storage.objects WHERE id=$1', [object.object_id]);
  for (const [status, evidence, absence] of [[204, null, 404], [200, null, 404], [200, { ...ack, id: randomUUID() }, 404],
    [200, { ...ack, name: object.object_key + '/foreign' }, 404], [200, ack, 200]]) {
    await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...args, 'storage_api_deleted', status, evidence, absence]), { code: 'PT409' });
  }
  const completed = await rpc(db, 'finish_story_media_cleanup_object', [...args, 'storage_api_deleted', 200, ack, 404]);
  assert.equal(completed.objects[0].state, 'completed'); assert.equal(completed.objects[0].outcome, 'storage_api_deleted');
  assert.equal(completed.physical_delete_confirmed, false); assert.equal(completed.account_deleted, false);
  assert.deepEqual(await rpc(db, 'finish_story_media_cleanup_object', [...args, 'storage_api_deleted', 200, ack, 404]), completed);
  assert.deepEqual(await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), completed);
  await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...args, 'unknown', 0, null, 0]), { code: 'PT409' });
});

test('R4 expired approved operations recover only original intents and missing metadata stays backend-unknown', async context => {
  const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
  const plan = await prepare(db, reservation), approval = randomUUID(); await confirm(db, plan, approval);
  await db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_cleanup_plans SET created_at=now()-interval '1 day',expires_at=now()-interval '1 day'+interval '5 minutes',lease_until=now()-interval '1 hour' WHERE id=$1", [plan.plan_id]);
  await identity(db, null, 'service_role');
  const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  assert.equal(worker.claim_id, plan.plan_id); assert.equal(worker.approval_ref, approval);
  const args = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
  const request = await rpc(db, 'request_story_media_cleanup_object', args);
  assert.equal(request.delete_allowed, false); assert.equal(request.objects[0].metadata_deleted, true);
  const observed = await rpc(db, 'finish_story_media_cleanup_object', [...args, 'storage_api_absent_backend_unknown', 0, null, 404]);
  assert.equal(observed.objects[0].state, 'unknown'); assert.equal(observed.objects[0].delete_attempts, 0);
  const pending = (await rpc(db, 'preview_story_media_cleanup', [null, 10])).items[0].pending_intents;
  assert.equal(pending[0].outcome, 'storage_api_absent_backend_unknown'); assert.equal(pending[0].operation_id, plan.operation_id);
  await assert.rejects(prepare(db, reservation), { code: 'PT409' });
});

test('R4 each body-write authorization rechecks current holds and reservation owner or epoch', async context => {
  for (const mutation of ['hold', 'owner', 'epoch', 'version', 'missing']) {
    const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
    const plan = await prepare(db, reservation); await confirm(db, plan);
    const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
    await db.exec('RESET ROLE');
    if (mutation === 'hold') {
      const report = randomUUID(); await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [report, owner, owner]);
      await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [report, randomUUID()]);
    } else if (mutation === 'owner') await db.query('UPDATE public.story_media_reservations SET owner=$1 WHERE id=$2', [randomUUID(), reservation.reservation_id]);
    else if (mutation === 'epoch') await db.query('UPDATE public.story_media_reservations SET epoch=epoch+1 WHERE id=$1', [reservation.reservation_id]);
    else {
      await db.exec('ALTER TABLE storage.objects DISABLE TRIGGER story_media_storage_guard');
      if (mutation === 'version') await db.query("UPDATE storage.objects SET version='substituted' WHERE id=$1", [reservation.stored.id]);
      else await db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]);
      await db.exec('ALTER TABLE storage.objects ENABLE TRIGGER story_media_storage_guard');
    }
    await identity(db, null, 'service_role');
    await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token]), { code: 'PT409' });
  }
});

test('R4 retry budgets and replaced worker leases cannot erase or hide unfinished intents', async context => {
  const db = await database(context), reservation = await cancelled(db); await holdsFixture(db);
  const plan = await prepare(db, reservation); await confirm(db, plan);
  let previous;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const worker = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
    const args = [worker.operation_id, worker.claim_id, worker.objects[0].intent_id, worker.lease_token];
    if (previous) await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [...args.slice(0, 3), previous]), { code: 'PT409' });
    assert.equal((await rpc(db, 'request_story_media_cleanup_object', args)).objects[0].delete_attempts, attempt);
    await rpc(db, 'finish_story_media_cleanup_object', [...args, 'unknown', 0, null, 0]);
    previous = worker.lease_token;
    await db.exec('RESET ROLE');
    await db.query("UPDATE public.story_media_cleanup_plans SET worker_lease_until=now()-interval '1 second' WHERE id=$1", [plan.plan_id]);
    await identity(db, null, 'service_role');
  }
  const exhausted = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', [exhausted.operation_id, exhausted.claim_id, exhausted.objects[0].intent_id, exhausted.lease_token]), { code: 'PT429' });
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_cleanup_plans SET worker_attempts=10,worker_lease_until=now()-interval '1 second' WHERE id=$1", [plan.plan_id]);
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT429' });
  const pending = (await rpc(db, 'preview_story_media_cleanup', [null, 10])).items[0].pending_intents[0];
  assert.equal(pending.operation_id, plan.operation_id); assert.equal(pending.state, 'unknown'); assert.equal(pending.delete_attempts, 3);
  assert.equal((await db.query('SELECT id FROM storage.objects WHERE id=$1', [reservation.stored.id])).rows.length, 1);
});

test('R4 expired owned content is eligible but a foreign Story reference or owner always blocks cleanup', async context => {
  const db = await database(context), reservation = await reserve(db), stored = await upload(db, reservation);
  await approve(db, reservation); await identity(db);
  const story = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  await holdsFixture(db); await db.exec('RESET ROLE');
  await db.query("UPDATE public.stories_v2 SET created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [story.id]);
  await db.query("UPDATE public.story_media_reservations SET created_at=now()-interval '25 hours',expires_at=now()-interval '25 hours'+interval '15 minutes' WHERE id=$1", [reservation.reservation_id]);
  const row = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  const plan = await prepare(db, { ...reservation, epoch: row.epoch, stored }, [stored.id, reservation.public_object_id]);
  await db.exec('RESET ROLE');
  const foreign = randomUUID();
  await db.query('INSERT INTO public.stories_v2(id,owner,kind,audience,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval \'24 hours\')',
    [foreign, randomUUID(), 'photo', 'authenticated']);
  await db.exec('ALTER TABLE public.story_content DISABLE TRIGGER story_media_publication_gate');
  await db.query('INSERT INTO public.story_content(story_id,media_url) VALUES($1,$2)', [foreign, reservation.media_url]);
  await db.exec('ALTER TABLE public.story_content ENABLE TRIGGER story_media_publication_gate');
  await assert.rejects(confirm(db, plan), { code: 'PT409' });
  await db.exec('RESET ROLE'); await db.query('DELETE FROM public.story_content WHERE story_id=$1', [foreign]);
  await db.query('UPDATE public.stories_v2 SET owner=$1 WHERE id=$2', [randomUUID(), story.id]);
  await assert.rejects(confirm(db, plan), { code: 'PT409' });
});
}