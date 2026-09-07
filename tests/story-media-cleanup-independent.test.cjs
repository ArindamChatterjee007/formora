'use strict';
// ---------------------------------------------------------------------------
// INDEPENDENT RETEST of the T-111 R-4 / N-1 cleanup follow-up. 2026-09-07.
//
// Written by the reviewer, not by the fix owner. Nothing outside this file and
// tests/story-media-independent.test.cjs was written during this pass: the
// product SQL, the deployed cleanup handler, its deno.json, both verification
// scripts, every other test, office/story-media-rollout.json and
// office/board.json were read-only and hash-checked before and after.
//
// These probes attack the cleanup slice only. They are deliberately NOT a rerun
// of the core media/parser/browser fleet. Passing them is not release approval,
// is not hosted acceptance, and is not proof of physical erasure.
//
// The original review characterized F-1 and F-2 with defect assertions.
// Fix-owner update, 2026-09-07: C-4/C-5 cover exact authorized-delete leases and
// require F-1 refusal with retained inventory.
// Maintainer test-only update, 2026-09-07 (NOT the original reviewer's work, and
// not a second independent review): C-2 previously pinned the F-2 defect and now
// pins the shipped repair instead, so it fails if the old behaviour returns.
// Original findings:
//   F-1 finish_story_media_cleanup_object accepts storage_api_deleted in a lease
//       that was never authorized to delete, so a conservatively labelled
//       backend-unknown intent can be upgraded to completed with no new Storage
//       DELETE, and it then disappears from preview_story_media_cleanup.
//   F-2 account_rights_hold_state.hold_version counted only account-rights hold
//       actions, so a report evidence hold that appeared and was removed between
//       approval and execution left the snapshot byte-identical and the original
//       approval resumed without a fresh dry run. Now journalled as
//       report_hold_version; C-2 requires the refusal.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, reserve, upload, approve, owner, peer, policy, hash } = require('./story-media-sql.test.cjs');

const root = path.join(__dirname, '..');
const service = (db) => identity(db, null, 'service_role');
const superuser = (db) => db.exec('RESET ROLE');

async function rights(db) {
  await db.exec(`RESET ROLE;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,deleted_at timestamptz,is_anonymous boolean DEFAULT false);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid,reported_uid text);
    CREATE TABLE public.report_evidence_holds(case_id uuid REFERENCES public.report_cases(id),hold_ref uuid);`);
  for (const actor of [owner, peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, actor + '@example.invalid']);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/account-rights.sql'), 'utf8'));
  // The report tables exist before the migration, so the private installer is invoked explicitly under
  // the superuser role rather than trusting install order, and the journal is proved live before any probe.
  await db.exec('RESET ROLE');
  await db.query('SELECT public.account_rights_install_report_hold_history()');
  assert.equal((await db.query('SELECT public.account_rights_report_hold_history_ready() AS ready')).rows[0].ready, true,
    'the report hold journal must be installed before these probes can mean anything');
  await db.exec('RESET ROLE; UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');
}

// An inactive reservation with exactly one retained private object.
async function retired(db, actor = owner) {
  await identity(db, actor);
  const reservation = await rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 500]);
  const stored = await upload(db, reservation, actor);
  await identity(db, actor);
  await rpc(db, 'cancel_story_media', [reservation.request_id]);
  await superuser(db);
  const row = (await db.query('SELECT epoch,media_url FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  return { ...reservation, epoch: row.epoch, media_url: row.media_url, stored };
}

// A published-then-tombstoned reservation with a private and a public object.
async function tombstoned(db) {
  const reservation = await reserve(db);
  const stored = await upload(db, reservation);
  await approve(db, reservation);
  await identity(db, owner);
  const story = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  await rpc(db, 'delete_story', [story.id, randomUUID()]);
  await superuser(db);
  const row = (await db.query('SELECT epoch,media_url,public_object_id FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  return { ...reservation, epoch: row.epoch, media_url: row.media_url, stored, publicObjectId: row.public_object_id, story };
}

const prepare = async (db, subject, ids, operation = randomUUID()) => {
  await service(db);
  return rpc(db, 'prepare_story_media_cleanup', [operation, subject.reservation_id, subject.epoch, ids || [subject.stored.id], policy]);
};
const confirm = async (db, plan, approval = randomUUID()) => {
  await service(db);
  return rpc(db, 'confirm_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, approval]);
};
const claimWorker = async (db, operation, claimId = null) => {
  await service(db);
  return rpc(db, 'claim_story_media_cleanup', [operation, claimId]);
};
const requestObject = async (db, claim, intentId) => {
  await service(db);
  return rpc(db, 'request_story_media_cleanup_object', [claim.operation_id, claim.claim_id, intentId, claim.lease_token]);
};
const finishObject = async (db, claim, intentId, result, deleteStatus, ack, getStatus) => {
  await service(db);
  return (await db.query(`SELECT public.finish_story_media_cleanup_object($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::integer,$7::jsonb,$8::integer) AS result`,
    [claim.operation_id, claim.claim_id, intentId, claim.lease_token, result, deleteStatus,
      ack === null || ack === undefined ? null : JSON.stringify(ack), getStatus])).rows[0].result;
};
const inventory = async (db) => { await service(db); return rpc(db, 'preview_story_media_cleanup', [null, 50]); };
const holdState = async (db, actor) => { await superuser(db); return (await db.query('SELECT public.account_rights_hold_state($1) AS state', [actor])).rows[0].state; };
const eligible = async (db, subject) => {
  await superuser(db);
  return (await db.query('SELECT public._story_media_cleanup_eligible(reservation.*) AS ok FROM public.story_media_reservations AS reservation WHERE id=$1',
    [subject.reservation_id])).rows[0].ok;
};
const planRow = async (db, planId) => { await superuser(db); return (await db.query('SELECT * FROM public.story_media_cleanup_plans WHERE id=$1', [planId])).rows[0]; };
const cancelPlan = async (db, plan, reference) => {
  await service(db);
  return rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]);
};
const objectCount = async (db, id) => {
  await superuser(db);
  return (await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE id=$1', [id])).rows[0].count;
};
const expireLeases = async (db) => db.exec(`RESET ROLE; UPDATE public.story_media_cleanup_plans
  SET worker_lease_until = pg_catalog.clock_timestamp() - interval '1 second'`);
// The publication gate is what stops a peer minting this reference in the first place;
// disabling it only long enough to seed the row models a legacy or flag-off row.
async function foreignReference(db, url, storyId = randomUUID()) {
  await db.exec('RESET ROLE; ALTER TABLE public.story_content DISABLE TRIGGER story_media_publication_gate');
  await db.query(`INSERT INTO public.stories_v2(id,owner,kind,audience,created_at,expires_at)
    VALUES($1,$2,'photo','authenticated',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp()+interval '24 hours')`, [storyId, peer]);
  await db.query('INSERT INTO public.story_content(story_id,media_url) VALUES($1,$2)', [storyId, url]);
  await db.exec('ALTER TABLE public.story_content ENABLE TRIGGER story_media_publication_gate');
  return storyId;
}

test('C-1 an approved cleanup can never widen across accounts, and a foreign Story reference blocks it at plan time and again at delete time', async context => {
  const db = await database(context);
  await rights(db);
  const mine = await retired(db);
  const theirs = await retired(db, peer);

  await assert.rejects(prepare(db, mine, [theirs.stored.id]), { code: 'PT409' }, 'another account object cannot be cleaned under my reservation');
  await assert.rejects(prepare(db, mine, [mine.stored.id, theirs.stored.id]), { code: 'PT409' }, 'a two-object plan cannot mix accounts');
  await assert.rejects(prepare(db, theirs, [mine.stored.id]), { code: 'PT409' });

  const subject = await tombstoned(db);
  assert.equal(await eligible(db, subject), true);
  const foreign = await foreignReference(db, subject.media_url);
  assert.equal(await eligible(db, subject), false, 'a peer Story pointing at the same media blocks eligibility');
  await assert.rejects(prepare(db, subject, [subject.stored.id]), { code: 'PT409' });
  await superuser(db);
  await db.query('UPDATE public.stories_v2 SET deleted_at = pg_catalog.clock_timestamp() WHERE id=$1', [foreign]);
  assert.equal(await eligible(db, subject), false, 'a tombstoned peer reference still blocks: any foreign owner is disqualifying');

  await superuser(db);
  await db.query('DELETE FROM public.story_content WHERE story_id=$1', [foreign]);
  await db.query('DELETE FROM public.stories_v2 WHERE id=$1', [foreign]);
  assert.equal(await eligible(db, subject), true);
  const plan = await prepare(db, subject, [subject.stored.id, subject.publicObjectId]);
  const approval = randomUUID();
  const claimed = await confirm(db, plan, approval);
  assert.equal(claimed.storage_delete_authorized, true);
  assert.equal(claimed.objects.length, 2);

  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [theirs.stored.id]), { code: 'PT403' },
    'the approved lease authorizes nothing owned by another account');
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [mine.stored.id]), { code: 'PT403' },
    'the approved lease authorizes nothing outside its own snapshot');

  await foreignReference(db, subject.media_url);
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [subject.stored.id]),
    error => error.code === 'PT409' || error.code === 'PT403', 'a foreign reference appearing after approval still blocks the catalog delete');
  await assert.rejects(claimWorker(db, plan.operation_id), { code: 'PT409' });

  await superuser(db);
  const survivors = (await db.query("SELECT id::text AS id FROM storage.objects WHERE bucket_id LIKE 'story-media-%' ORDER BY id")).rows.map(row => row.id);
  assert.equal(survivors.length, 4, 'nothing was deleted while the reference existed');
  for (const id of [mine.stored.id, theirs.stored.id, subject.stored.id, subject.publicObjectId]) assert.ok(survivors.includes(id));
});

test('C-2 F-2 repaired: a report evidence hold flicker is journalled, the original approval can never resume, and recovery needs an explicit cancellation plus a fresh dry run and a fresh approval', async context => {
  const db = await database(context);
  await rights(db);
  const subject = await retired(db);
  const baseline = await holdState(db, owner);
  assert.equal(baseline.hold_status, 'clear');
  assert.equal(baseline.report_hold_version, 0, 'the report hold journal is live, so a missing bump would be a real defect');

  const peerCase = randomUUID();
  await superuser(db);
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [peerCase, peer, peer]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [peerCase, randomUUID()]);
  assert.deepEqual(await holdState(db, owner), baseline, 'another account hold never touches this owner');
  const held = await holdState(db, peer);
  assert.equal(held.hold_status, 'held');
  assert.equal(held.report_hold_version, 1, 'the held account is the only one whose epoch moved');

  const plan = await prepare(db, subject);
  const approval = randomUUID();
  assert.equal((await confirm(db, plan, approval)).storage_delete_authorized, true,
    'baseline control: before any flicker this approval really did authorize deletion');

  const ownerCase = randomUUID();
  await superuser(db);
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [ownerCase, peer, owner]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [ownerCase, randomUUID()]);
  assert.equal((await holdState(db, owner)).hold_status, 'held');
  await assert.rejects(claimWorker(db, plan.operation_id), /evidence holds block cleanup/);
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [subject.stored.id]), { code: 'PT409' });

  await superuser(db);
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [ownerCase]);
  const released = await holdState(db, owner);
  assert.equal(released.hold_status, 'clear');
  assert.equal(released.hold_version, baseline.hold_version, 'the rights journal is not what moved');
  assert.equal(released.report_hold_version, baseline.report_hold_version + 2,
    'F-2 repaired: both the add and the remove are recorded, so the released snapshot is not byte-identical');
  assert.notDeepEqual(released, baseline);
  await assert.rejects(claimWorker(db, plan.operation_id), /Evidence hold state changed/,
    'F-2 repaired: the original approval cannot resume after a flicker');
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' }, 'and it cannot be re-approved in place either');
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [subject.stored.id]), { code: 'PT409' });
  assert.equal(await objectCount(db, subject.stored.id), 1, 'nothing was deleted under the stale approval');
  await assert.rejects(prepare(db, subject), error => error.code === 'PT409' && /already exists/.test(error.message),
    'the invalidated plan still holds the object, so recovery is not implicit');

  // Recovery: the untouched plan is retired explicitly, then only an exact fresh snapshot with a fresh approval proceeds.
  const cancellation = randomUUID();
  const superseded = await cancelPlan(db, plan, cancellation);
  assert.equal(superseded.plan_id, plan.plan_id);
  assert.equal(superseded.cancellation_ref, cancellation);
  assert.equal(superseded.approval_ref, approval, 'the retired plan keeps its audit');
  assert.equal(superseded.storage_delete_authorized, false);
  assert.equal(superseded.dry_run, false);
  assert.equal(await objectCount(db, subject.stored.id), 1, 'cancellation deletes nothing');
  const fresh = await prepare(db, subject);
  assert.notEqual(fresh.plan_id, plan.plan_id);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256, 'the new snapshot pins the advanced report hold epoch');
  await assert.rejects(confirm(db, fresh, approval), { code: 'PT409' }, 'the retired approval reference cannot be re-spent');
  assert.equal((await confirm(db, fresh, randomUUID())).storage_delete_authorized, true,
    'only a genuinely fresh independent approval restores delete authority');

  // Contrast on the live replacement plan: the rights journal is a separate counter and fences the same way.
  const request = randomUUID();
  await superuser(db);
  await db.query(`INSERT INTO public.account_rights_requests(id,owner_id,request_id,kind,payload) VALUES($1,$2,$3,'erasure','{}'::jsonb)`,
    [request, owner, randomUUID()]);
  await db.query('INSERT INTO public.account_rights_holds(request_ref,hold_ref) VALUES($1,$2)', [request, randomUUID()]);
  await db.query(`INSERT INTO public.account_rights_actions(operation_id,request_ref,actor_role,action,previous_version,to_status)
    VALUES($1,$2,'service_role','hold',1,'held')`, [randomUUID(), request]);
  assert.equal((await holdState(db, owner)).hold_status, 'held');
  await assert.rejects(claimWorker(db, fresh.operation_id), /evidence holds block cleanup/);
  await superuser(db);
  await db.query('DELETE FROM public.account_rights_holds WHERE request_ref=$1', [request]);
  const rightsReleased = await holdState(db, owner);
  assert.equal(rightsReleased.hold_status, 'clear');
  assert.equal(rightsReleased.hold_version, released.hold_version + 1, 'a rights hold survives release as a version bump');
  assert.equal(rightsReleased.report_hold_version, released.report_hold_version, 'the two journals count independently');
  await assert.rejects(claimWorker(db, fresh.operation_id), /Evidence hold state changed/,
    'the versioned rights half forces a fresh dry run for the replacement plan too');
});

test('C-3 the durable journal survives catalog deletion, plan expiry and lease expiry under its original identity, and no plan object can vanish unaudited', async context => {
  const db = await database(context);
  await rights(db);
  const subject = await tombstoned(db);
  const operation = randomUUID();
  const plan = await prepare(db, subject, [subject.stored.id, subject.publicObjectId], operation);
  const approval = randomUUID();
  await confirm(db, plan, approval);
  const claim = await claimWorker(db, operation);
  assert.equal(claim.schema_version, 1);
  assert.equal(claim.owner, owner);
  assert.equal(claim.objects.length, 2);
  const target = claim.objects.find(entry => entry.object_id === subject.stored.id);
  const untouched = claim.objects.find(entry => entry.object_id === subject.publicObjectId);

  const authorized = await requestObject(db, claim, target.intent_id);
  assert.equal(authorized.delete_allowed, true);
  await service(db);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [target.object_id])).rows.length, 1);

  await db.exec(`RESET ROLE; UPDATE public.story_media_cleanup_plans
    SET created_at = pg_catalog.clock_timestamp() - interval '9 minutes', expires_at = pg_catalog.clock_timestamp() - interval '4 minutes',
      lease_until = pg_catalog.clock_timestamp() - interval '4 minutes', worker_lease_until = pg_catalog.clock_timestamp() - interval '1 second'`);
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [untouched.object_id]), { code: 'PT403' },
    'once the approved confirmation lease lapses no plan object can be deleted without its own durable worker request');

  const audit = await planRow(db, plan.plan_id);
  assert.equal(audit.approval_ref, approval);
  assert.equal(audit.deleted_objects.length, 1);
  assert.equal(audit.deleted_objects[0].object_id, target.object_id);
  assert.equal(audit.deleted_objects[0].object_version, target.object_version);
  assert.equal(audit.deleted_objects[0].physical_delete_confirmed, false);
  assert.ok(audit.deleted_objects[0].storage_metadata_deleted_at, 'the metadata delete is timestamped in the plan audit');

  const listed = await inventory(db);
  const item = listed.items.find(entry => entry.reservation_id === subject.reservation_id);
  assert.ok(item, 'the reservation stays inventoried after its catalog row is gone and its dry run expired');
  assert.equal(listed.physical_delete_allowed, false);
  assert.equal(item.pending_intents.length, 2);
  const journal = item.pending_intents.find(entry => entry.object_id === target.object_id);
  assert.equal(journal.operation_id, operation);
  assert.equal(journal.claim_id, plan.plan_id);
  assert.equal(journal.intent_id, target.intent_id);
  assert.equal(journal.object_key, target.object_key);
  assert.equal(journal.object_version, target.object_version);
  assert.equal(journal.bucket, 'story-media-quarantine-v3');
  assert.equal(journal.state, 'object_delete_requested');
  assert.equal(journal.outcome, 'pending');
  assert.equal(journal.delete_attempts, 1);
  assert.ok(journal.metadata_deleted_at);
  assert.equal(journal.physical_delete_confirmed, false);

  await assert.rejects(prepare(db, subject, [subject.stored.id]), { code: 'PT409' },
    'a fresh operation cannot mint a new identity for retained work');
  await assert.rejects(prepare(db, subject, [subject.publicObjectId]), { code: 'PT409' });
  const replay = await prepare(db, subject, [subject.stored.id, subject.publicObjectId], operation);
  assert.equal(replay.plan_id, plan.plan_id);
  assert.equal(replay.snapshot_sha256, plan.snapshot_sha256);
  assert.equal(replay.approval_ref, approval);
  assert.equal(replay.storage_delete_authorized, false, 'the expired confirmation lease is not silently extended');
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' }, 'an expired dry run cannot be re-approved');

  const second = await claimWorker(db, operation, plan.plan_id);
  assert.equal(second.claim_id, plan.plan_id);
  assert.equal(second.approval_ref, approval);
  assert.notEqual(second.lease_token, claim.lease_token);
  assert.deepEqual(second.objects.map(entry => [entry.object_id, entry.object_key, entry.object_version]).sort(),
    claim.objects.map(entry => [entry.object_id, entry.object_key, entry.object_version]).sort(),
    'the retained target identity is byte-identical across leases');
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [untouched.object_id]), { code: 'PT403' },
    'a fresh worker lease still authorizes nothing until that exact object is durably requested');
  await superuser(db);
  assert.equal((await db.query('SELECT worker_attempts FROM public.story_media_cleanup_plans WHERE id=$1', [plan.plan_id])).rows[0].worker_attempts, 2);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id LIKE 'story-media-%'")).rows[0].count, 1);
});

test('C-4 only an exact owned delete audit plus an exact remove acknowledgement and an authenticated 404 can complete an intent', async context => {
  const db = await database(context);
  await rights(db);
  const subject = await retired(db);
  const plan = await prepare(db, subject);
  await confirm(db, plan);
  const claim = await claimWorker(db, plan.operation_id);
  const intent = claim.objects[0];
  const ack = { name: intent.object_key, id: intent.object_id, bucket_id: intent.bucket };
  assert.equal((await requestObject(db, claim, intent.intent_id)).delete_allowed, true);
  assert.equal((await requestObject(db, claim, intent.intent_id)).delete_allowed, false,
    'a duplicate request does not authorize a second delete or revoke the original attempt');

  for (const attempt of [['storage_api_deleted', 200, ack, 404], ['storage_api_absent_backend_unknown', 0, null, 404]]) {
    await assert.rejects(finishObject(db, claim, intent.intent_id, ...attempt), { code: 'PT409' },
      'nothing completes while the object is still in the catalog');
  }
  await service(db);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [subject.stored.id])).rows.length, 1);

  const refused = [
    ['storage_api_deleted', 200, null, 404],
    ['storage_api_deleted', 204, ack, 404],
    ['storage_api_deleted', 200, ack, 200],
    ['storage_api_deleted', 200, { ...ack, name: 'stories/' + peer + '/forged.jpg' }, 404],
    ['storage_api_deleted', 200, { ...ack, id: randomUUID() }, 404],
    ['storage_api_deleted', 200, { ...ack, bucket_id: 'story-media-public-v3' }, 404],
    ['storage_api_deleted', 200, { ...ack, owner: owner }, 404],
    ['storage_api_absent_backend_unknown', 200, ack, 404],
    ['storage_api_absent_backend_unknown', 500, null, 404],
    ['account_deleted', 200, ack, 404],
    ['storage_api_deleted', 700, ack, 404],
  ];
  for (const attempt of refused) {
    await assert.rejects(finishObject(db, claim, intent.intent_id, ...attempt), error => error.code === 'PT409' || error.code === '22023',
      'refused observation: ' + JSON.stringify(attempt));
  }
  await superuser(db);
  assert.equal((await db.query('SELECT state,outcome FROM public.story_media_cleanup_intents WHERE id=$1', [intent.intent_id])).rows[0].outcome, 'pending');

  const unacknowledged = await finishObject(db, claim, intent.intent_id, 'unknown', 200, null, 0);
  assert.equal(unacknowledged.objects[0].state, 'unknown');
  const completed = await finishObject(db, claim, intent.intent_id, 'storage_api_deleted', 200, ack, 404);
  const finished = completed.objects[0];
  assert.equal(finished.state, 'completed', 'an exact acknowledgement can resolve the original authorized attempt');
  assert.equal(finished.outcome, 'storage_api_deleted');
  assert.equal(completed.physical_delete_confirmed, false);
  assert.equal(completed.account_deleted, false);
  assert.deepEqual(await finishObject(db, claim, intent.intent_id, 'storage_api_deleted', 200, ack, 404), completed, 'an identical replay is idempotent');
  await assert.rejects(finishObject(db, claim, intent.intent_id, 'unknown', 0, null, 0), { code: 'PT409' }, 'a completed observation is immutable');
  await assert.rejects(finishObject(db, claim, intent.intent_id, 'storage_api_deleted', 200, { ...ack, id: randomUUID() }, 404), { code: 'PT409' });

  await superuser(db);
  const row = (await db.query('SELECT * FROM public.story_media_cleanup_intents WHERE id=$1', [intent.intent_id])).rows[0];
  assert.equal(row.delete_http_status, 200);
  assert.equal(row.absence_http_status, 404);
  assert.deepEqual(row.api_ack, ack);
  assert.equal(JSON.stringify(completed).includes('physical_delete_confirmed":true'), false);
  assert.equal(JSON.stringify(completed).includes('account_deleted":true'), false);
});

test('C-5 F-1 regression: an unauthorized retry lease cannot complete an earlier delete audit or remove backend-unknown inventory', async context => {
  const db = await database(context);
  await rights(db);
  const subject = await retired(db);
  const plan = await prepare(db, subject);
  const first = await claimWorker(db, (await confirm(db, plan)).operation_id);
  const intent = first.objects[0];
  assert.equal((await requestObject(db, first, intent.intent_id)).delete_allowed, true);
  await service(db);
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id=$1 RETURNING id', [subject.stored.id])).rows.length, 1);
  const lost = await finishObject(db, first, intent.intent_id, 'unknown', 200, null, 0);
  assert.equal(lost.objects[0].state, 'unknown');
  assert.equal(lost.objects[0].outcome, 'unknown');
  assert.equal(lost.objects[0].delete_attempts, 1);

  await expireLeases(db);
  const second = await claimWorker(db, plan.operation_id);
  assert.equal(second.claim_id, plan.plan_id);
  const retryTarget = second.objects[0];
  assert.equal(retryTarget.intent_id, intent.intent_id);
  assert.equal(retryTarget.object_id, intent.object_id);
  assert.equal(retryTarget.object_key, intent.object_key);
  assert.equal(retryTarget.object_version, intent.object_version);
  const retry = await requestObject(db, second, intent.intent_id);
  assert.equal(retry.delete_allowed, false, 'an already-audited catalog delete is never re-authorized');
  assert.equal(retry.objects[0].delete_attempts, 1, 'the retry consumes no delete budget');
  assert.equal(retry.objects[0].metadata_deleted, true);

  const ack = { name: intent.object_key, id: intent.object_id, bucket_id: intent.bucket };
  await assert.rejects(finishObject(db, second, intent.intent_id, 'storage_api_deleted', 200, ack, 404), { code: 'PT409' },
    'a current readback-only lease cannot reuse an earlier delete audit before recording absence');
  const readback = await finishObject(db, second, intent.intent_id, 'storage_api_absent_backend_unknown', 0, null, 404);
  assert.equal(readback.objects[0].outcome, 'storage_api_absent_backend_unknown');
  assert.equal(readback.objects[0].state, 'unknown', 'authenticated absence alone is service visibility, never completion');
  assert.equal(readback.physical_delete_confirmed, false);
  assert.equal(readback.account_deleted, false);
  const pending = await inventory(db);
  assert.equal(pending.items.find(entry => entry.reservation_id === subject.reservation_id).pending_intents.length, 1,
    'backend-unknown work stays inventoried for operator reconciliation');

  await assert.rejects(finishObject(db, second, intent.intent_id, 'storage_api_deleted', 200, ack, 404), { code: 'PT409' },
    'F-1: a lease never authorized to delete cannot upgrade backend-unknown to completed');
  const after = await inventory(db);
  assert.deepEqual(after, pending, 'refused completion preserves the pending backend-unknown inventory and delete budget');
});

test('C-6 the deployed cleanup handler has one fixed destination set, no caller-supplied path, no secret or identity in any response, and finite bodies and deadlines', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/cleanup-story-media/index.ts'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/cleanup-story-media/deno.json'), 'utf8'));

  assert.deepEqual([...source.matchAll(/read\("([A-Z_]+)"\)/g)].map(match => match[1]).sort(),
    ['STORY_MEDIA_CLEANUP_ENABLED', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL']);
  assert.match(source, /read\("STORY_MEDIA_CLEANUP_ENABLED"\) === "true"/);
  assert.match(source, /config\.enabled !== true[\s\S]{0,200}cleanup_disabled/);
  assert.match(source, /\^https:\\\/\\\/\[a-z0-9-\]\+\\\.supabase\\\.co\$/, 'the origin is pinned to one canonical https project host');
  assert.equal(/const url = config\.origin \+ route;/.test(source), true, 'every request is built from the configured origin');
  assert.equal([...source.matchAll(/fetcher\(/g)].length, 1, 'exactly one outbound call site');
  assert.match(source, /redirect: "error"/);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /response\.redirected \|\| \(response\.url && response\.url !== url\)/);
  assert.match(source, /timingSafeEqual\(candidate, expected\)/);
  assert.match(source, /candidate\.length !== expected\.length/);
  assert.equal(/atob|decodeJwt|jwt|Authorization: "Bearer " \+ provided/.test(source), false, 'no bearer or JWT identity path');
  assert.match(source, /incoming\.search \|\| incoming\.hash \|\| incoming\.username \|\| incoming\.password/);

  // Destinations: three fixed RPC names, two fixed buckets, keys rebuilt from validated fields only.
  assert.deepEqual([...source.matchAll(/"(claim_story_media_cleanup|request_story_media_cleanup_object|finish_story_media_cleanup_object)"/g)]
    .map(match => match[1]).filter((value, index, all) => all.indexOf(value) === index).sort(),
    ['claim_story_media_cleanup', 'finish_story_media_cleanup_object', 'request_story_media_cleanup_object']);
  assert.deepEqual([...source.matchAll(/"story-media-(quarantine|public)-v3"/g)].map(match => match[1])
    .filter((value, index, all) => all.indexOf(value) === index).sort(), ['public', 'quarantine']);
  assert.match(source, /object\.object_key !== key\) fail\(\)/, 'the claim object key must equal the server-rebuilt key');
  assert.match(source, /uuid = \/\^\[a-f0-9\]\{8\}/);
  assert.match(source, /digest = \/\^\[a-f0-9\]\{64\}\$\//);
  assert.equal(/\.\.\/|%2e|decodeURIComponent/.test(source.split('\n').filter(line => line.includes('/storage/v1/')).join('\n')), false,
    'no traversal or decoding in a Storage path');
  for (const forbidden of ['auth/v1', 'billing', 'notifications', 'messages', 'account_rights', '/storage/v1/bucket']) {
    assert.equal(source.includes(forbidden), false, 'the executor must have no ' + forbidden + ' surface');
  }

  // Bounded bodies, deadlines and cancellation.
  assert.match(source, /objects: 2, requestBytes: 512, jsonBytes: 8192, ackBytes: 4096/);
  assert.match(source, /stepMs: 5000, aggregateMs: 20000, requests: 10/);
  assert.match(source, /\+\+calls > cleanupLimits\.requests\) fail\("cleanup_budget", 429\)/);
  assert.match(source, /setTimeout\(abort, aggregateMs\)/);
  assert.match(source, /setTimeout\(abort, stepMs\)/);
  assert.match(source, /\+\+reads > 128 \|\| used \+ chunk\.value\.byteLength > maximum/);
  assert.match(source, /range: "bytes=0-0"/, 'the absence read never streams a body');
  assert.match(source, /controller\.signal\.addEventListener\("abort", cancel, \{ once: true \}\)/);
  assert.match(source, /if \(active\) return reply\(\{ error: "cleanup_busy" \}, 429\)/);

  // Response and error surface.
  const receipt = source.match(/function safeReceipt[\s\S]+?\n}/)[0];
  for (const leaked of ['owner', 'object_key', 'object_version', 'lease_token', 'serviceKey', 'snapshot_sha256', 'approval_ref', 'bucket']) {
    assert.equal(receipt.includes(leaked), false, 'safeReceipt must not expose ' + leaked);
  }
  assert.match(receipt, /physical_delete_confirmed: false, account_deleted: false/);
  assert.match(source, /reply\(\{ error: failure\.code, physical_delete_confirmed: false, account_deleted: false \}/);
  assert.equal(/console\.|Deno\.stdout|Deno\.stderr/.test(source), false, 'the handler logs nothing at all');
  assert.equal(/physical_delete_confirmed: true|account_deleted: true/.test(source), false);
  assert.equal(config.lock, false);
  assert.equal(config.nodeModulesDir, 'none');
  assert.deepEqual([...source.matchAll(/^import .*from "([^"]+)";$/gm)].map(match => match[1]), ['node:crypto'],
    'no third-party or remote dependency reaches the executor');
});

test('C-7 both activation flags default off and the whole cleanup surface stays deny-by-default outside service_role', async context => {
  assert.match(fs.readFileSync(path.join(root, 'js/config.js'), 'utf8'), /window\.STORY_MEDIA_VALIDATION\s*=\s*false;/);
  const sql = fs.readFileSync(path.join(root, 'supabase/story-media.sql'), 'utf8');
  assert.match(sql, /cleanup_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /cleanup_min_age_seconds integer NOT NULL DEFAULT 86400/);

  const db = await database(context);
  await superuser(db);
  const settings = (await db.query('SELECT cleanup_enabled,retention_approved,storage_policy_approved FROM public.story_media_settings')).rows[0];
  assert.equal(settings.cleanup_enabled, false, 'applying the migration never enables cleanup');

  const routines = ['claim_story_media_cleanup(uuid,uuid)', 'request_story_media_cleanup_object(uuid,uuid,uuid,uuid)',
    'finish_story_media_cleanup_object(uuid,uuid,uuid,uuid,text,integer,jsonb,integer)',
    'prepare_story_media_cleanup(uuid,uuid,integer,uuid[],uuid)', 'confirm_story_media_cleanup(uuid,text,uuid)',
    'preview_story_media_cleanup(uuid,integer)'];
  for (const routine of routines) {
    const signature = 'public.' + routine;
    const acl = (await db.query(`SELECT coalesce((SELECT string_agg(entry::text,'|' ORDER BY entry::text)
      FROM unnest(proacl) AS entry),'') AS acl FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure`, [signature])).rows[0].acl;
    assert.equal(acl.split('|').some(entry => entry.startsWith('=')), false, signature + ' must hold no PUBLIC grant');
    for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_anon']) {
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) AS held', [role, signature, 'EXECUTE'])).rows[0].held, false,
        role + ' must not execute ' + signature);
    }
    assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) AS held', ['service_role', signature, 'EXECUTE'])).rows[0].held, true);
  }
  for (const table of ['story_media_cleanup_plans', 'story_media_cleanup_intents']) {
    const row = (await db.query(`SELECT relrowsecurity AS rls,(SELECT count(*)::int FROM pg_catalog.pg_policy WHERE polrelid = class.oid) AS policies
      FROM pg_catalog.pg_class AS class WHERE class.oid = ('public.' || $1)::regclass`, [table])).rows[0];
    assert.equal(row.rls, true);
    assert.equal(row.policies, 0);
    for (const role of ['anon', 'authenticated', 'service_role', 'inherited_member']) {
      assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS held',
        [role, 'public.' + table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'])).rows[0].held, false,
        role + ' must hold no privilege on ' + table);
    }
  }

  // With cleanup disabled, service_role gets nothing but a dry-run inventory and no delete path.
  const subject = await retired(db);
  await assert.rejects(prepare(db, subject), { code: 'PT503' });
  await service(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [subject.stored.id]), { code: 'PT403' });
  const listed = await inventory(db);
  assert.equal(listed.dry_run, true);
  assert.equal(listed.physical_delete_allowed, false);
  await superuser(db);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_cleanup_plans')).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_cleanup_intents')).rows[0].count, 0);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id LIKE 'story-media-%'")).rows[0].count, 1);
});
