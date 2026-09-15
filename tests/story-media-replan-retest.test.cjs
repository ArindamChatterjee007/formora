'use strict';
// INDEPENDENT RETEST (reviewer-owned) of the cancel_story_media_cleanup / stale-plan recovery slice
// added to supabase/story-media.sql. This file is the ONLY file this review owns: no product, office,
// report, CI or existing-test file is modified. Claims are re-derived from the SQL, not copied from
// tests/story-media-replan.test.cjs; refusals are driven through the real RPC flow wherever the state
// is reachable that way instead of through synthetic column mutations.
// Scope: local PGlite only. NOT hosted PostgREST/Storage, not real object erasure, not release approval.
// Note: this file joins the tests/*.test.cjs glob in scripts/run-functional-checks.cjs and therefore
// changes sourceFingerprint for any later candidate run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, reserve, upload, approve, owner, hash } = require('./story-media-sql.test.cjs');
const { holdsFixture, cancelled, prepare, confirm } = require('./story-media-cleanup.test.cjs');

const CANCEL = 'public.cancel_story_media_cleanup(uuid,text,uuid)';

async function cancel(db, plan, reference) {
  await identity(db, null, 'service_role');
  return rpc(db, 'cancel_story_media_cleanup', [plan.plan_id, plan.snapshot_sha256, reference]);
}
async function asService(db) { await identity(db, null, 'service_role'); }
async function root(db) { await db.exec('RESET ROLE'); }

// Independent whole-table row-image digests. Row text (not a hand-listed column set) so an added or
// silently rewritten column cannot slip past the comparison.
const digestOf = (table, alias) =>
  `md5(coalesce((SELECT string_agg(item::text,'|') FROM (SELECT ${alias} FROM ${table} AS ${alias} ORDER BY ${alias}.id) AS captured(item)),''))`;
async function fingerprint(db) {
  await root(db);
  return (await db.query(`SELECT ${digestOf('storage.objects', 'o')} AS objects,
    ${digestOf('public.story_media_reservations', 'r')} AS reservations,
    ${digestOf('public.story_media_cleanup_plans', 'p')} AS plans,
    ${digestOf('public.story_media_cleanup_intents', 'i')} AS intents`)).rows[0];
}
async function planRow(db, id) {
  await root(db);
  return (await db.query('SELECT * FROM public.story_media_cleanup_plans WHERE id=$1', [id])).rows[0];
}
async function intentRows(db, planId) {
  await root(db);
  return (await db.query('SELECT * FROM public.story_media_cleanup_intents WHERE plan_id=$1 ORDER BY object_id', [planId])).rows;
}
// The reviewer computes which columns moved rather than asserting a pre-agreed shape.
function changedColumns(before, after) {
  const columns = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...columns].filter(column => JSON.stringify(before[column]) !== JSON.stringify(after[column])).sort();
}
async function workerArgs(db, plan) {
  await asService(db);
  const claim = await rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]);
  return { claim, args: [claim.operation_id, claim.claim_id, claim.objects[0].intent_id, claim.lease_token] };
}
async function epochOf(db, reservation) {
  await root(db);
  return (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0].epoch;
}

test('IR-1: a hold flicker wedges an approved plan, cancellation retires it without touching evidence, and only then can a fresh dry run be independently approved', async context => {
  const db = await database(context), reservation = await cancelled(db);
  await holdsFixture(db);
  const plan = await prepare(db, reservation), approval = randomUUID();
  const claimed = await confirm(db, plan, approval);
  assert.equal(claimed.storage_delete_authorized, true, 'baseline control: the approval really did authorize deletion');
  const stale = await workerArgs(db, plan);

  // Hold appears and disappears again: the object never leaves the owner and nothing is deleted.
  const report = randomUUID();
  await root(db);
  await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [report, owner, owner]);
  await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [report, randomUUID()]);
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' }, 'held plan must not replay');
  await root(db);
  await db.query('DELETE FROM public.report_evidence_holds WHERE case_id=$1', [report]);
  assert.equal((await rpc(db, 'account_rights_hold_state', [owner])).hold_status, 'clear');

  const wedgedPlan = await planRow(db, plan.plan_id), wedgedIntents = await intentRows(db, plan.plan_id);
  const wedgedDigest = await fingerprint(db);
  // Dead in every direction BEFORE recovery exists: this is the defect the change is meant to repair.
  await assert.rejects(confirm(db, plan, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', stale.args), { code: 'PT409' });
  await assert.rejects(prepare(db, reservation), error => error.code === 'PT409' && /already exists/.test(error.message));
  assert.deepEqual(await fingerprint(db), wedgedDigest, 'a wedged plan changes nothing');

  const reference = randomUUID(), retired = await cancel(db, plan, reference);
  assert.ok(retired.superseded_at, 'receipt carries the supersession stamp');
  assert.equal(retired.cancellation_ref, reference);
  assert.equal(retired.dry_run, false);
  assert.equal(retired.storage_delete_authorized, false);
  assert.equal(retired.physical_delete_confirmed, false);
  assert.equal(retired.account_deleted, false);
  // Identity + audit survive: same plan, same operation, same approval and the same (now inert) lease.
  assert.equal(retired.plan_id, plan.plan_id);
  assert.equal(retired.operation_id, plan.operation_id);
  assert.equal(retired.snapshot_sha256, plan.snapshot_sha256);
  assert.equal(retired.approval_ref, approval);
  assert.equal(retired.lease_token, claimed.lease_token);
  assert.equal(retired.status, 'claimed');
  assert.deepEqual(retired.objects, plan.objects);

  const retiredPlan = await planRow(db, plan.plan_id), retiredIntents = await intentRows(db, plan.plan_id);
  assert.deepEqual(changedColumns(wedgedPlan, retiredPlan), ['cancellation_ref', 'superseded_at'],
    'cancellation rewrites exactly two plan columns');
  assert.equal(retiredIntents.length, wedgedIntents.length);
  for (const [index, after] of retiredIntents.entries()) {
    assert.deepEqual(changedColumns(wedgedIntents[index], after), ['cancelled_at'], 'intents keep their identity and audit');
  }
  await root(db);
  const aligned = (await db.query(`SELECT count(*) AS total,
    count(*) FILTER (WHERE intent.cancelled_at IS NOT DISTINCT FROM plan.superseded_at) AS matched
    FROM public.story_media_cleanup_intents AS intent JOIN public.story_media_cleanup_plans AS plan ON plan.id=intent.plan_id
    WHERE intent.plan_id=$1`, [plan.plan_id])).rows[0];
  assert.equal(aligned.total, aligned.matched, 'every intent is stamped with the plan supersession instant');
  const afterCancel = await fingerprint(db);
  assert.equal(afterCancel.objects, wedgedDigest.objects, 'stored objects byte-identical');
  assert.equal(afterCancel.reservations, wedgedDigest.reservations, 'reservation rows byte-identical');

  // Idempotency is reference-bound, and a replay must not re-stamp anything.
  assert.deepEqual(await cancel(db, plan, reference), retired);
  assert.deepEqual(await fingerprint(db), afterCancel, 'replayed cancellation is a true no-op');
  await assert.rejects(cancel(db, plan, randomUUID()), { code: 'PT409' });
  await assert.rejects(cancel(db, plan, null), { code: 'PT409' });
  await assert.rejects(cancel(db, { ...plan, snapshot_sha256: 'b'.repeat(64) }, reference), { code: 'PT409' });
  assert.deepEqual(await fingerprint(db), afterCancel);

  // The retired plan's tokens are inert, including the physical delete boundary.
  await asService(db);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object', stale.args), { code: 'PT409' });
  await assert.rejects(rpc(db, 'finish_story_media_cleanup_object', [...stale.args, 'unknown', 0, null, 0]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [plan.operation_id, plan.plan_id]), { code: 'PT409' });
  await asService(db);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [reservation.stored.id]), { code: 'PT403' });

  // The object is retired from the pending queue but never orphaned out of the inventory.
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 10]);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].object_id, reservation.stored.id);
  assert.deepEqual(inventory.items[0].pending_intents, []);

  const fresh = await prepare(db, reservation);
  assert.notEqual(fresh.plan_id, plan.plan_id);
  assert.notEqual(fresh.operation_id, plan.operation_id);
  assert.notEqual(fresh.snapshot_sha256, plan.snapshot_sha256, 'the new snapshot pins the new hold version');
  assert.equal(fresh.dry_run, true);
  assert.equal(fresh.status, 'dry_run');
  assert.equal(fresh.approval_ref, null);
  assert.equal(fresh.lease_token, null);
  assert.equal(fresh.storage_delete_authorized, false);
  await assert.rejects(confirm(db, fresh, approval), { code: 'PT409' }, 'the retired approval reference cannot be re-spent');
  const reapproved = await confirm(db, fresh, randomUUID());
  assert.equal(reapproved.storage_delete_authorized, true, 'a genuinely fresh approval restores authority');
  const next = await workerArgs(db, fresh);
  await assert.rejects(rpc(db, 'request_story_media_cleanup_object',
    [next.claim.operation_id, next.claim.claim_id, next.claim.objects[0].intent_id, stale.claim.lease_token]), { code: 'PT409' },
    'the old worker lease cannot be carried into the new plan');
  await root(db);
  const ledger = (await db.query(`SELECT count(*) AS total, count(*) FILTER (WHERE cancelled_at IS NULL) AS live
    FROM public.story_media_cleanup_intents WHERE reservation_id=$1`, [reservation.reservation_id])).rows[0];
  assert.equal(Number(ledger.total), 2, 'the retired intent is retained alongside the new one');
  assert.equal(Number(ledger.live), 1, 'exactly one live intent per object');

  // Authorization: the grant is service-only and the guard is the effective role name, not the privilege.
  const acl = (await db.query(`SELECT proc.prosecdef, pg_catalog.array_to_string(proc.proconfig,',') AS config,
    proc.proacl::text AS acl, pg_catalog.has_function_privilege('anon',proc.oid,'EXECUTE') AS anon,
    pg_catalog.has_function_privilege('authenticated',proc.oid,'EXECUTE') AS authenticated,
    pg_catalog.has_function_privilege('service_role',proc.oid,'EXECUTE') AS service_role,
    pg_catalog.has_function_privilege('inherited_service',proc.oid,'EXECUTE') AS inherited_service,
    pg_catalog.has_table_privilege('service_role','public.story_media_cleanup_plans','UPDATE') AS plan_update,
    pg_catalog.has_table_privilege('service_role','public.story_media_cleanup_intents','UPDATE') AS intent_update
    FROM pg_catalog.pg_proc AS proc WHERE proc.oid = '${CANCEL}'::regprocedure`)).rows[0];
  assert.equal(acl.prosecdef, true);
  assert.match(acl.config, /search_path=/);
  assert.equal(acl.anon, false);
  assert.equal(acl.authenticated, false);
  assert.equal(acl.service_role, true);
  assert.equal(acl.inherited_service, true, 'privilege is inherited');
  assert.equal(acl.plan_update, false);
  assert.equal(acl.intent_update, false);
  assert.doesNotMatch(acl.acl, /(^|,)=[a-zA-Z]*X/, 'never executable by PUBLIC');
  for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_anon', 'inherited_service']) {
    await identity(db, null, role);
    await assert.rejects(rpc(db, 'cancel_story_media_cleanup', [fresh.plan_id, fresh.snapshot_sha256, randomUUID()]),
      { code: '42501' }, role + ' must not cancel');
  }
  await root(db);
  await assert.rejects(rpc(db, 'cancel_story_media_cleanup', [fresh.plan_id, fresh.snapshot_sha256, randomUUID()]),
    { code: '42501' }, 'an unset role is not the service role');
  await asService(db);
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_plans SET superseded_at=NULL WHERE id=$1', [plan.plan_id]), { code: '42501' });
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_intents SET cancelled_at=NULL WHERE plan_id=$1', [plan.plan_id]), { code: '42501' });
  assert.equal((await fingerprint(db)).objects, wedgedDigest.objects);
});

test('IR-2: any attempted, uncertain or completed deletion permanently forbids supersession, enforced by the schema as well as the routine', async context => {
  const db = await database(context);
  const requested = await cancelled(db), uncertain = await cancelled(db), erased = await cancelled(db), finished = await cancelled(db);
  await holdsFixture(db);
  const built = {};
  for (const [label, reservation] of Object.entries({ requested, uncertain, erased, finished })) {
    const plan = await prepare(db, reservation);
    await confirm(db, plan);
    const worker = await workerArgs(db, plan);
    await rpc(db, 'request_story_media_cleanup_object', worker.args);
    if (label === 'uncertain') {
      await rpc(db, 'finish_story_media_cleanup_object', [...worker.args, 'unknown', 0, null, 0]);
    } else if (label !== 'requested') {
      const object = worker.claim.objects[0];
      await asService(db);
      await db.query('DELETE FROM storage.objects WHERE id=$1', [object.object_id]);
      if (label === 'finished') {
        await rpc(db, 'finish_story_media_cleanup_object', [...worker.args, 'storage_api_deleted', 200,
          { name: object.object_key, id: object.object_id, bucket_id: object.bucket }, 404]);
      }
    }
    built[label] = { plan, reservation };
  }
  await root(db);
  const states = (await db.query(`SELECT intent.state, intent.outcome, intent.delete_attempts,
    plan.status, pg_catalog.jsonb_array_length(plan.deleted_objects) AS deleted
    FROM public.story_media_cleanup_intents AS intent JOIN public.story_media_cleanup_plans AS plan ON plan.id=intent.plan_id
    ORDER BY intent.created_at`)).rows;
  assert.deepEqual(states.map(row => [row.state, row.outcome, Number(row.deleted)]), [
    ['object_delete_requested', 'pending', 0], ['unknown', 'unknown', 0],
    ['object_delete_requested', 'pending', 1], ['completed', 'storage_api_deleted', 1]
  ], 'four genuinely reachable non-cancellable states were reached through the real worker flow');

  const before = await fingerprint(db);
  const expected = {
    requested: /Only untouched cleanup intents/, uncertain: /Only untouched cleanup intents/,
    erased: /Delete evidence forbids/, finished: /Delete evidence forbids/
  };
  for (const [label, target] of Object.entries(built)) {
    await assert.rejects(cancel(db, target.plan, randomUUID()),
      error => error.code === 'PT409' && expected[label].test(error.message), label + ' must not be cancellable');
    await assert.rejects(prepare(db, target.reservation), { code: 'PT409' }, label + ' must not be replanned');
  }
  assert.deepEqual(await fingerprint(db), before, 'every refusal is a complete no-op');

  // Schema backstop: even a superuser cannot hand-stamp a cancellation over attempted or completed work.
  await root(db);
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_intents SET cancelled_at=now() WHERE plan_id=$1',
    [built.finished.plan.plan_id]), { code: '23514' });
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_intents SET cancelled_at=now() WHERE plan_id=$1',
    [built.uncertain.plan.plan_id]), { code: '23514' });
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_plans SET superseded_at=now(),cancellation_ref=gen_random_uuid() WHERE id=$1',
    [built.erased.plan.plan_id]), { code: '23514' });
  await assert.rejects(db.query('UPDATE public.story_media_cleanup_plans SET superseded_at=now() WHERE id=$1',
    [built.requested.plan.plan_id]), { code: '23514' }, 'a supersession stamp without a cancellation reference is rejected');
  assert.deepEqual(await fingerprint(db), before);

  // The stuck work stays visible for operator review rather than being silently dropped.
  await asService(db);
  const pending = (await rpc(db, 'preview_story_media_cleanup', [null, 50])).items.flatMap(item => item.pending_intents);
  assert.equal(pending.length, 3, 'completed work leaves the queue, attempted and uncertain work does not');
  assert.deepEqual(pending.map(item => item.state).sort(), ['object_delete_requested', 'object_delete_requested', 'unknown']);
  assert.ok(pending.every(item => item.physical_delete_confirmed === false));
});

test('IR-3: multi-object cancellation is atomic and untouched stale-epoch plans can be retired without deletion', async context => {
  const db = await database(context);
  const reservation = await reserve(db), stored = await upload(db, reservation);
  await approve(db, reservation);
  await identity(db);
  const story = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  await rpc(db, 'delete_story', [story.id, randomUUID()]);
  const wedgeTarget = await cancelled(db);
  await holdsFixture(db);
  const pair = { ...reservation, stored, epoch: await epochOf(db, reservation) };
  const ids = [stored.id, reservation.public_object_id];

  const plan = await prepare(db, pair, ids);
  await confirm(db, plan);
  assert.equal((await intentRows(db, plan.plan_id)).length, 2);
  const beforeClean = await fingerprint(db), reference = randomUUID();
  const retired = await cancel(db, plan, reference);
  assert.equal(retired.cancellation_ref, reference);
  const cancelledPair = await intentRows(db, plan.plan_id);
  assert.equal(cancelledPair.length, 2);
  assert.equal(new Set(cancelledPair.map(intent => String(intent.cancelled_at))).size, 1, 'both objects retire at one instant');
  assert.ok(cancelledPair.every(intent => intent.cancelled_at !== null));
  assert.notDeepEqual(cancelledPair.map(intent => intent.object_id).sort(), []);
  assert.deepEqual(cancelledPair.map(intent => intent.bucket).sort(), ['story-media-public-v3', 'story-media-quarantine-v3']);
  const afterClean = await fingerprint(db);
  assert.equal(afterClean.objects, beforeClean.objects, 'neither object was touched');
  assert.equal(afterClean.reservations, beforeClean.reservations);

  // A second plan over the same pair: touch exactly one object, then prove the refusal is atomic.
  const replan = await prepare(db, pair, ids);
  await confirm(db, replan);
  await asService(db);
  const claim = await rpc(db, 'claim_story_media_cleanup', [replan.operation_id, replan.plan_id]);
  const touched = claim.objects[0], untouched = claim.objects[1];
  await rpc(db, 'request_story_media_cleanup_object', [claim.operation_id, claim.claim_id, touched.intent_id, claim.lease_token]);
  const beforePartial = await fingerprint(db), partialIntents = await intentRows(db, replan.plan_id);
  await assert.rejects(cancel(db, replan, randomUUID()),
    error => error.code === 'PT409' && /Only untouched cleanup intents/.test(error.message));
  const afterPartial = await intentRows(db, replan.plan_id);
  assert.deepEqual(await fingerprint(db), beforePartial, 'the partial plan is left exactly as it was');
  for (const [index, after] of afterPartial.entries()) assert.deepEqual(changedColumns(partialIntents[index], after), []);
  await root(db);
  const survivor = (await db.query('SELECT cancelled_at,state FROM public.story_media_cleanup_intents WHERE plan_id=$1 AND id=$2',
    [replan.plan_id, untouched.intent_id])).rows[0];
  assert.equal(survivor.cancelled_at, null, 'the untouched sibling is never half-cancelled');
  assert.equal(survivor.state, 'claimed');
  await assert.rejects(prepare(db, pair, ids), { code: 'PT409' });

  // Reachability probe: an ordinary member repeating cancel_story_media bumps the live reservation epoch.
  const wedged = await prepare(db, wedgeTarget), approval = randomUUID();
  await confirm(db, wedged, approval);
  await identity(db);
  const first = await epochOf(db, wedgeTarget);
  await identity(db);
  await rpc(db, 'cancel_story_media', [wedgeTarget.request_id]);
  const bumped = await epochOf(db, wedgeTarget);
  assert.equal(bumped, first + 1, 'a member-callable retry moves the reservation epoch under an approved plan');
  const epochRetirement = await cancel(db, wedged, randomUUID());
  assert.equal(epochRetirement.storage_delete_authorized, false);
  await assert.rejects(confirm(db, wedged, approval), { code: 'PT409' });
  await assert.rejects(rpc(db, 'claim_story_media_cleanup', [wedged.operation_id, wedged.plan_id]), { code: 'PT409' });
  const epochReplacement = await prepare(db, { ...wedgeTarget, epoch: bumped });
  assert.notEqual(epochReplacement.plan_id, wedged.plan_id);
  assert.equal(epochReplacement.storage_delete_authorized, false);
  assert.equal(epochReplacement.approval_ref, null);
  await assert.rejects(confirm(db, epochReplacement, approval), { code: 'PT409' });
  assert.equal((await confirm(db, epochReplacement, randomUUID())).storage_delete_authorized, true);
  await asService(db);
  const stuck = (await rpc(db, 'preview_story_media_cleanup', [null, 50])).items
    .find(item => item.reservation_id === wedgeTarget.reservation_id);
  assert.equal(stuck.pending_intents.length, 1, 'only the fresh exact plan remains pending; no object was deleted');
  assert.equal(stuck.pending_intents[0].state, 'claimed');
});
