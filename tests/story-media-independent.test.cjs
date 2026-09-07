'use strict';
// Originally independent regressions, maintained by the repair owner for the new media contract.
// The original review JSON is unchanged; rerunning this file is not independent approval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash, webcrypto } = require('node:crypto');
const { database, identity, rpc, reserve, upload, claim, approve, owner, peer, policy, hash } = require('./story-media-sql.test.cjs');

const approvals = [
  `UPDATE public.story_settings SET enabled=true,permission_policy_approved=true,media_audience_approved=true,
     public_media_approved=true,retention_approved=true,operator_policy_ref=$1,
    media_origin='https://fixture.supabase.co',public_bucket='story-media-public-v3'`,
  `UPDATE public.story_media_settings SET enabled=true,publication_required=true,storage_policy_approved=true,
     quota_approved=true,retention_approved=true,storage_policy_ref=$1,quota_policy_ref=$1,retention_policy_ref=$1`,
];
const failedAttestation = (reservation, lease, code) =>
  [owner, reservation.request_id, lease.epoch, lease.lease_token, null, null, null, null, null, null, code];

test('activation keeps raw quarantine private and rejected bytes have no public object or unapproved cleanup path', async context => {
  const db = await database(context, false);
  for (const statement of approvals) await db.query(statement, [policy]);
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-quarantine-v3'")).rows[0].public, false);
  await assert.rejects(reserve(db), { code: 'PT503' }, 'final approved product media needs its public serving bucket');
  await db.exec("RESET ROLE; UPDATE storage.buckets SET public=true WHERE id='story-media-public-v3'");

  const reservation = await reserve(db);
  await upload(db, reservation);
  const lease = await claim(db, reservation);
  const rejected = await rpc(db, 'attest_story_media', failedAttestation(reservation, lease, 'invalid_media'));
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.sha256, null);

  await identity(db);
  assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='story-media-quarantine-v3' RETURNING id")).rows.length, 0);
  await identity(db, null, 'service_role');
  await assert.rejects(db.exec("DELETE FROM storage.objects WHERE bucket_id='story-media-quarantine-v3'"), { code: 'PT403' });
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 50]);
  assert.equal(inventory.physical_delete_allowed, false);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].status, 'failed');
  assert.equal(inventory.items[0].object_key, reservation.object_key);

  await db.exec('RESET ROLE');
  const stored = (await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='story-media-quarantine-v3'")).rows[0];
  assert.equal(stored.count, 1, 'raw bytes remain private until a separately approved cleanup');
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-quarantine-v3'")).rows[0].public, false);
  assert.equal((await db.query("SELECT id FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows.length, 0);
  await identity(db, null, 'anon');
  assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 0);
});

test('the media gate never blocks owner Story deletion, and cleanup after deletion stays a dry run', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  await upload(db, reservation);
  await approve(db, reservation);
  await identity(db);
  const published = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
  const removed = await rpc(db, 'delete_story', [published.id, randomUUID()]);
  assert.equal(removed.committed, true);
  assert.equal(removed.id, published.id);
  assert.ok(removed.deleted_at, 'owner deletion must not be fenced by the media publication trigger');

  await identity(db, null, 'service_role');
  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 50]);
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].status, 'published');
  assert.equal(inventory.physical_delete_allowed, false);
  await db.exec('RESET ROLE');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id IN ('story-media-quarantine-v3','story-media-public-v3')")).rows[0].count, 2,
    'Story deletion alone does not physically erase either object');
});

test('real policy changes fence old work but renew exact private requests without duplicate admission or false quota credits', async context => {
  const db = await database(context);
  const clip = await reserve(db, randomUUID(), 'video', 'video/mp4', 26214400);
  await upload(db, clip);
  const photo = await reserve(db);
  await identity(db, null, 'service_role');
  await db.exec('UPDATE public.story_media_settings SET video_ms=29999');

  for (const reservation of [clip, photo]) {
    await assert.rejects(rpc(db, 'claim_story_media_validation', [owner, reservation.request_id]), { code: 'PT409' });
  }
  await identity(db);
  const renewedClip = await rpc(db, 'reserve_story_media', [clip.request_id, 'video', 'video/mp4', 26214400]);
  const renewedPhoto = await rpc(db, 'reserve_story_media', [photo.request_id, 'photo', 'image/jpeg', 500]);
  assert.equal(renewedClip.reservation_id, clip.reservation_id); assert.equal(renewedClip.object_key, clip.object_key);
  assert.equal(renewedClip.uploaded, true); assert.equal(renewedClip.renewals, 1);
  assert.equal(renewedPhoto.reservation_id, photo.reservation_id); assert.equal(renewedPhoto.renewals, 1);
  await db.exec('RESET ROLE');
  const charged = (await db.query('SELECT count(*)::int AS count, sum(declared_bytes)::text AS bytes FROM public.story_media_reservations WHERE owner=$1', [owner])).rows[0];
  assert.equal(charged.count, 2);
  assert.equal(charged.bytes, String(26214400 + 500), 'renewal neither duplicates nor falsifies original usage charges');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='story-media-quarantine-v3'")).rows[0].count, 1,
    'the exact immutable private upload is retained for revalidation');
});

test('a terminal validation failure is not retryable under the same request UUID and keeps its charge', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  await upload(db, reservation);
  const lease = await claim(db, reservation);
  assert.equal((await rpc(db, 'attest_story_media', failedAttestation(reservation, lease, 'size_mismatch'))).status, 'failed');

  await identity(db);
  await assert.rejects(rpc(db, 'reserve_story_media', [reservation.request_id, 'photo', 'image/jpeg', 500]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]), { code: 'PT409' });
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'claim_story_media_validation', [owner, reservation.request_id]), { code: 'PT409' });

  const fresh = await reserve(db);
  assert.equal(fresh.status, 'reserved', 'a failure releases the pending slot');
  await db.exec('RESET ROLE');
  const totals = (await db.query('SELECT count(*)::int AS count, sum(declared_bytes)::text AS bytes FROM public.story_media_reservations WHERE owner=$1', [owner])).rows[0];
  assert.equal(totals.count, 2);
  assert.equal(totals.bytes, '1000', 'the failed attempt still consumes the daily byte budget');
});

test('the same request UUID on a second account mints an independent reservation and leaks nothing', async context => {
  const db = await database(context);
  const request = randomUUID();
  const mine = await reserve(db, request);
  await identity(db, peer);
  const theirs = await rpc(db, 'reserve_story_media', [request, 'photo', 'image/jpeg', 500]);
  assert.equal(theirs.owner, peer);
  assert.notEqual(theirs.reservation_id, mine.reservation_id);
  assert.notEqual(theirs.public_key_id, mine.public_key_id);
  assert.equal(theirs.media_url, null); assert.equal(mine.media_url, null);
  assert.equal(theirs.object_key, `stories/${peer}/${theirs.reservation_id}.jpg`);
  assert.equal(await rpc(db, '_story_media_storage_insert', [mine.bucket, mine.object_key, peer]), false);
  assert.equal(await rpc(db, '_story_media_storage_insert', [mine.bucket, mine.object_key, mine.owner]), false);

  await identity(db, peer, 'inherited_member');
  assert.equal(await rpc(db, '_story_media_storage_insert', [mine.bucket, mine.object_key, mine.owner]), false);
  await identity(db, null, 'anon');
  assert.equal(await rpc(db, '_story_media_storage_insert', [mine.bucket, mine.object_key, mine.owner]), false,
    'the anon-callable Storage predicate answers only for the current authenticated caller');

  await identity(db, owner);
  assert.deepEqual(await rpc(db, 'reserve_story_media', [request, 'photo', 'image/jpeg', 500]), mine);
});

test('no PUBLIC, anon or inherited grant reaches the new media tables or routines', async context => {
  const db = await database(context);
  await db.exec('RESET ROLE');
  const anyTablePrivilege = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';
  const tables = (await db.query(`SELECT class.relname AS name, class.relrowsecurity AS rls,
      (SELECT count(*)::int FROM pg_catalog.pg_policy WHERE polrelid = class.oid) AS policies,
      coalesce((SELECT string_agg(entry::text, '|' ORDER BY entry::text) FROM unnest(class.relacl) AS entry), '') AS acl
    FROM pg_catalog.pg_class AS class
    WHERE class.relnamespace = 'public'::regnamespace AND class.relkind = 'r' AND class.relname LIKE 'story\\_media%' ORDER BY 1`)).rows;
  assert.deepEqual(tables.map(row => row.name), ['story_media_cleanup_intents', 'story_media_cleanup_plans', 'story_media_publish_intents', 'story_media_reservations', 'story_media_settings']);
  for (const table of tables) {
    assert.equal(table.rls, true, table.name + ' must have RLS enabled');
    assert.equal(table.policies, 0, table.name + ' must stay deny-by-default with no policy');
    assert.equal(table.acl.split('|').some(entry => entry.startsWith('=')), false, table.name + ' must hold no PUBLIC grant');
    for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_anon']) {
      assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS held', [role, 'public.' + table.name, anyTablePrivilege])).rows[0].held,
        false, role + ' must hold no privilege on ' + table.name);
    }
    assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS held', ['service_role', 'public.' + table.name, 'SELECT,UPDATE'])).rows[0].held,
      table.name === 'story_media_settings', 'service_role reads settings only');
    assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS held', ['service_role', 'public.' + table.name, 'INSERT,DELETE,TRUNCATE'])).rows[0].held,
      false, 'service_role must never write ' + table.name + ' directly');
  }

  const callers = {
    reserve_story_media: ['authenticated'], cancel_story_media: ['authenticated'], publish_validated_story: ['authenticated'],
    _story_media_storage_insert: ['anon', 'authenticated'],
    claim_story_media_validation: ['service_role'], attest_story_media: ['service_role'], preview_story_media_cleanup: ['service_role'],
    claim_story_media_promotion: ['service_role'], finalize_story_media: ['service_role'],
    prepare_story_media_cleanup: ['service_role'], confirm_story_media_cleanup: ['service_role'],
    cancel_story_media_cleanup: ['service_role'],
    claim_story_media_cleanup: ['service_role'], request_story_media_cleanup_object: ['service_role'], finish_story_media_cleanup_object: ['service_role'],
    _story_media_settings_epoch: [], _story_media_ready: [], _story_media_receipt: [], _story_media_storage_guard: [],
    _story_media_storage_bound: [], _story_media_publication_gate: [],
    _story_media_bucket_guard: [], _story_media_guards_present: [], _story_media_cleanup_holds: [], _story_media_cleanup_eligible: [],
    _story_media_cleanup_receipt: [], _story_media_cleanup_check: [], _story_media_cleanup_delete: [],
    _story_media_cleanup_policy_check: [], _story_media_cleanup_object_check: [], _story_media_cleanup_worker_receipt: [], _story_media_cleanup_worker_check: [],
  };
  const routines = (await db.query(`SELECT routine.proname AS name, routine.oid::regprocedure::text AS signature,
      coalesce((SELECT string_agg(entry::text, '|' ORDER BY entry::text) FROM unnest(routine.proacl) AS entry), '') AS acl
    FROM pg_catalog.pg_proc AS routine WHERE routine.pronamespace = 'public'::regnamespace
      AND (routine.proname LIKE '%story\\_media%' OR routine.proname = 'publish_validated_story') ORDER BY 1`)).rows;
  assert.deepEqual(routines.map(row => row.name).sort(), Object.keys(callers).sort(), 'the candidate routine surface is exactly as declared');
  const held = async (role, signature) => (await db.query('SELECT has_function_privilege($1,$2,$3) AS held', [role, signature, 'EXECUTE'])).rows[0].held;
  for (const routine of routines) {
    const expected = callers[routine.name];
    assert.equal(routine.acl.split('|').some(entry => entry.startsWith('=')), false, routine.signature + ' must hold no PUBLIC grant');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await held(role, routine.signature), expected.includes(role), role + ' -> ' + routine.signature);
    }
    assert.equal(await held('inherited_member', routine.signature), expected.includes('authenticated'), 'inherited_member -> ' + routine.signature);
    assert.equal(await held('inherited_anon', routine.signature), expected.includes('anon'), 'inherited_anon -> ' + routine.signature);
  }
  const cancellation = routines.find(routine => routine.name === 'cancel_story_media_cleanup');
  assert.ok(cancellation);
  assert.equal(await held('inherited_service', cancellation.signature), true, 'inherited EXECUTE must still be fenced by the exact service-role guard');
  const cancellationArgs = [randomUUID(), 'a'.repeat(64), randomUUID()];
  for (const role of ['anon', 'authenticated', 'inherited_member', 'inherited_anon', 'inherited_service']) {
    await identity(db, null, role);
    await assert.rejects(rpc(db, 'cancel_story_media_cleanup', cancellationArgs), { code: '42501' }, role + ' cannot cancel cleanup');
  }
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'cancel_story_media_cleanup', cancellationArgs),
    error => error.code === 'PT409' && /Exact cleanup snapshot and cancellation reference required/.test(error.message));
});

// ---------------------------------------------------------------------------
// Independent retest 2026-09-07 (P-1..P-6). Written by the reviewer against the
// repaired contract; they attack the private -> public promotion state machine,
// not the pre-repair behaviour. Passing these is not release approval.
// ---------------------------------------------------------------------------

const publicMetadata = (reservation, lease, promotion, digest = hash) => ({
  reservation_id: reservation.reservation_id, owner: reservation.owner, sha256: digest,
  epoch: lease.epoch, lease_token: lease.lease_token, promotion_token: promotion?.promotion_token || randomUUID(),
});
const attestOk = (db, reservation, lease, digest = hash) => rpc(db, 'attest_story_media',
  [reservation.owner, reservation.request_id, lease.epoch, lease.lease_token, digest, reservation.declared_bytes,
    reservation.content_type, 16, 16, reservation.kind === 'video' ? 1000 : null, null]);
const promote = (db, reservation, key, metadata) =>
  upload(db, reservation, null, 'service_role', { bucket: reservation.public_bucket, key, userMetadata: metadata });

test('P-1 rejected and un-promoted bytes produce zero public objects, and promotion mints exactly one separate hash-bound key', async context => {
  const db = await database(context);
  const rejected = await reserve(db);
  await upload(db, rejected);
  const rejectedLease = await claim(db, rejected);
  assert.equal((await rpc(db, 'attest_story_media', failedAttestation(rejected, rejectedLease, 'invalid_media'))).status, 'failed');
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'claim_story_media_promotion', [owner, rejected.request_id, rejectedLease.epoch, rejectedLease.lease_token]),
    { code: 'PT409' }, 'a rejected reservation can never be claimed for promotion');
  await assert.rejects(promote(db, rejected, `stories/${owner}/${rejected.public_key_id}_${hash}.jpg`,
    publicMetadata(rejected, rejectedLease, null)), { code: 'PT403' }, 'rejected bytes cannot be hand-written into the public bucket');

  const good = await reserve(db);
  await upload(db, good);
  const lease = await claim(db, good);
  const attested = await attestOk(db, good, lease);
  assert.equal(attested.status, 'attested');
  assert.equal(attested.public_key, `stories/${owner}/${good.public_key_id}_${hash}.jpg`);
  assert.notEqual(attested.public_key, good.object_key);
  assert.equal(attested.public_object_id, null);
  await assert.rejects(promote(db, good, attested.public_key, publicMetadata(good, lease, null)),
    { code: 'PT403' }, 'attested is not promoting: no public write before the promotion claim');

  const promotion = await rpc(db, 'claim_story_media_promotion', [owner, good.request_id, lease.epoch, lease.lease_token]);
  assert.equal(promotion.write_allowed, true);
  const metadata = publicMetadata(good, lease, promotion);
  await assert.rejects(promote(db, good, attested.public_key, { ...metadata, sha256: 'b'.repeat(64) }), { code: 'PT403' });
  const stored = await promote(db, good, attested.public_key, metadata);
  await assert.rejects(promote(db, good, attested.public_key, metadata), { code: 'PT403' }, 'a second promotion PUT is refused, never an overwrite');

  await db.exec('RESET ROLE');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='story-media-quarantine-v3'")).rows[0].count, 2);
  const publicRows = (await db.query("SELECT id::text AS id,name FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows;
  assert.deepEqual(publicRows.map(row => row.name), [attested.public_key]);
  assert.equal(publicRows[0].id, stored.id);
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-quarantine-v3'")).rows[0].public, false);
});

test('P-2 finalization demands the exact stored public object, and an unknown ACK reconciles instead of repeating the upload', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  await upload(db, reservation);
  const lease = await claim(db, reservation);
  const attested = await attestOk(db, reservation, lease);
  const promotion = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  const stored = await promote(db, reservation, attested.public_key, publicMetadata(reservation, lease, promotion));

  await identity(db, null, 'service_role');
  const reconciled = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  assert.equal(reconciled.write_allowed, false, 'an unknown ACK must never re-authorize a PUT');
  assert.equal(reconciled.promotion_token, promotion.promotion_token);
  assert.equal(reconciled.public_object_id, stored.id);
  assert.equal(reconciled.public_object_version, stored.version);
  assert.equal(reconciled.sha256, hash);
  assert.equal(reconciled.public_key, attested.public_key);

  const finalize = (id, version, digest = hash) =>
    rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, digest, id, version]);
  for (const [id, version, digest] of [[randomUUID(), stored.version, hash], [stored.id, 'forged-version', hash],
    [stored.id, stored.version, 'c'.repeat(64)], [null, stored.version, hash], [stored.id, null, hash]]) {
    await assert.rejects(finalize(id, version, digest), { code: 'PT409' });
  }
  const approved = await finalize(stored.id, stored.version);
  assert.equal(approved.status, 'approved');
  assert.deepEqual(await finalize(stored.id, stored.version), approved, 'finalization replay is idempotent, not a second promotion');

  await db.exec('RESET ROLE');
  const row = (await db.query(`SELECT public_object_id::text AS id,public_object_version AS version,public_sha256 AS digest,
    promotion_token::text AS token FROM public.story_media_reservations WHERE request_id=$1`, [reservation.request_id])).rows[0];
  assert.deepEqual(row, { id: stored.id, version: stored.version, digest: hash, token: promotion.promotion_token });
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows[0].count, 1);
});

test('P-3 no BYPASSRLS, inherited, anon or peer path escapes the Storage triggers, policies or the private quarantine', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  await upload(db, reservation);
  const lease = await claim(db, reservation);
  const attested = await attestOk(db, reservation, lease);
  const promotion = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  const metadata = publicMetadata(reservation, lease, promotion);

  await assert.rejects(upload(db, reservation, null, 'inherited_service', { bucket: reservation.public_bucket, key: attested.public_key, userMetadata: metadata }),
    { code: 'PT403' }, 'a BYPASSRLS role that merely inherits service_role is not the service writer');
  const stored = await promote(db, reservation, attested.public_key, metadata);
  await rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, stored.id, stored.version]);

  for (const role of ['service_role', 'inherited_service']) {
    await identity(db, null, role);
    for (const bucket of ['story-media-quarantine-v3', 'story-media-public-v3']) {
      await assert.rejects(db.query("UPDATE storage.objects SET version='rotated' WHERE bucket_id=$1", [bucket]),
        { code: 'PT403' }, role + ' bypasses RLS but must still meet the trigger on ' + bucket);
    }
  }
  for (const role of ['authenticated', 'inherited_member']) {
    await identity(db, owner, role);
    for (const bucket of ['story-media-quarantine-v3', 'story-media-public-v3']) {
      assert.equal((await db.query("UPDATE storage.objects SET version='rotated' WHERE bucket_id=$1 RETURNING id", [bucket])).rows.length, 0,
        role + ' must reach no candidate row in ' + bucket);
    }
  }
  for (const role of ['service_role', 'inherited_service', 'authenticated', 'inherited_member']) {
    await identity(db, role.includes('service') ? null : owner, role);
    await assert.rejects(db.query("UPDATE storage.buckets SET public=true WHERE id='story-media-quarantine-v3'"),
      error => error.code === 'PT403' || error.code === '42501', role + ' must not publish the quarantine');
  }
  await identity(db, null, 'inherited_service');
  await assert.rejects(db.exec("DELETE FROM storage.objects WHERE bucket_id LIKE 'story-media-%'"), { code: 'PT403' });
  await identity(db, peer);
  await assert.rejects(upload(db, reservation, peer, 'authenticated', {}), { code: 'PT403' });
  for (const [actor, role] of [[peer, 'authenticated'], [owner, 'inherited_member'], [null, 'anon'], [null, 'inherited_anon']]) {
    await identity(db, actor, role);
    const visible = (await db.query("SELECT id FROM storage.objects WHERE bucket_id LIKE 'story-media-%'")).rows.length;
    assert.equal(visible, role === 'inherited_member' ? 2 : 0, role + ' visibility of candidate objects');
  }

  await db.exec('RESET ROLE');
  const objects = (await db.query("SELECT bucket_id,version FROM storage.objects WHERE bucket_id LIKE 'story-media-%' ORDER BY bucket_id")).rows;
  assert.equal(objects.length, 2);
  assert.equal(objects.some(object => object.version === 'rotated'), false);
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-quarantine-v3'")).rows[0].public, false);
});

test('P-4 SQL publication stays the boundary for foreign, legacy, cross-request and cross-owner media', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  await upload(db, reservation);
  const approved = await approve(db, reservation);
  const legacy = 'https://fixture.supabase.co/storage/v1/object/public/media/stories/' + owner + '/legacy.jpg';

  await identity(db, peer);
  await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, approved.reservation_id, hash]), { code: 'PT409' });
  await identity(db, owner);
  await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, approved.reservation_id, 'c'.repeat(64)]), { code: 'PT409' });
  await assert.rejects(rpc(db, 'publish_validated_story', [randomUUID(), approved.reservation_id, hash]), { code: 'PT409' });
  for (const [url, code] of [[approved.media_url, 'PT403'], [legacy, '22023']]) {
    await assert.rejects(rpc(db, 'publish_story', [randomUUID(), url, 'photo', 'authenticated']), { code },
      'the legacy publisher cannot mint a Story around the validated path');
  }

  const published = await rpc(db, 'publish_validated_story', [reservation.request_id, approved.reservation_id, hash]);
  assert.equal((await rpc(db, 'publish_validated_story', [reservation.request_id, approved.reservation_id, hash])).id, published.id,
    'an owner retry of the same request is idempotent, never a second Story');
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT media_url FROM public.story_content')).rows, [{ media_url: approved.media_url }]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.stories_v2')).rows[0].count, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_publish_intents')).rows[0].count, 0);
  const row = (await db.query('SELECT status,published_story_id::text AS story FROM public.story_media_reservations WHERE request_id=$1', [reservation.request_id])).rows[0];
  assert.deepEqual(row, { status: 'published', story: published.id });
});

test('P-5 the client trusts no server JSON, no foreign media source, and abandons on cancel or account change', async context => {
  const createStories = require('../js/mod/stories.js');
  const origin = 'https://fixture.supabase.co';
  const digest = createHash('sha256').update('independent probe bytes').digest('hex');
  const build = handler => {
    const state = { calls: [], owner, late: false };
    const file = new File(['independent probe bytes'], 'p.jpg', { type: 'image/jpeg' });
    const request = randomUUID(), reservationId = randomUUID(), publicKeyId = randomUUID();
    const objectKey = `stories/${owner}/${reservationId}.jpg`;
    const publicKey = `stories/${owner}/${publicKeyId}_${digest}.jpg`;
    const base = { schema_version: 2, owner, request_id: request, reservation_id: reservationId,
      bucket: 'story-media-quarantine-v3', object_key: objectKey, media_url: null,
      public_bucket: 'story-media-public-v3', public_key_id: publicKeyId, public_key: null,
      public_object_id: null, public_object_version: null, content_type: 'image/jpeg', kind: 'photo',
      declared_bytes: file.size, expires_at: new Date(Date.now() + 900000).toISOString(),
      policy_epoch: 1, status: 'reserved', uploaded: false };
    const receipt = { ...base, status: 'approved', uploaded: true, actual_bytes: file.size, width: 16, height: 16,
      duration_ms: null, duration_verified: false, sha256: digest, public_key: publicKey,
      public_object_id: randomUUID(), public_object_version: 'stored-public-version',
      media_url: `${origin}/storage/v1/object/public/story-media-public-v3/${publicKey}` };
    const host = { USE_SUPABASE_AUTH: true, SUPABASE_URL: origin, SUPABASE_ANON_KEY: 'probe-public',
      STORY_INTERACTIONS: true, STORY_MEDIA_VALIDATION: true };
    const auth = { active: () => true, uid: () => state.owner, token: async () => 'probe-token', _authEpoch: 1 };
    const context_ = vm.createContext({ window: host, SupaAuth: auth, File, Blob, Response, URL, Uint8Array,
      TextDecoder, TextEncoder, crypto: webcrypto, atob, AbortController, setTimeout, clearTimeout,
      fetch: async (url, init) => { state.calls.push(url); return handler(url, init, { state, base, receipt }); } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cloud.js'), 'utf8') + '\nglobalThis.cloud=Cloud;', context_);
    const cloud = context_.cloud;
    cloud.me = owner; cloud.key = 'probe-public'; cloud.base = origin + '/rest/v1';
    return { state, host, auth, cloud, receipt, run: () => cloud.uploadMedia(file, 'stories', { requestId: request, current: () => !state.late }) };
  };
  const storageAck = (url, base) => Response.json({ Key: 'story-media-quarantine-v3/' + base.object_key, Id: randomUUID() });

  const oversize = build((url, init, { state, base, receipt }) => {
    if (url.endsWith('/reserve_story_media')) return Response.json(base);
    if (url.includes('/storage/')) { state.uploaded = true; return storageAck(url, base); }
    return Response.json({ ...receipt, filler: 'x'.repeat(40000) });
  });
  await assert.rejects(oversize.run(), error => error.status === 502, 'an unbounded validation body is not parsed');

  for (const foreign of ['https://evil.example.invalid/storage/v1/object/public/story-media-public-v3/x.jpg',
    origin + '/storage/v1/object/public/media/stories/' + owner + '/x.jpg']) {
    const probe = build((url, init, { state, base, receipt }) => {
      if (url.endsWith('/reserve_story_media')) return Response.json(base);
      if (url.includes('/storage/')) { state.uploaded = true; return storageAck(url, base); }
      return Response.json({ ...receipt, media_url: foreign });
    });
    await assert.rejects(probe.run(), error => error.status === 502, 'a foreign media source is never accepted: ' + foreign);
  }

  const cancelled = build((url, init, { state, base }) => {
    if (url.endsWith('/reserve_story_media')) { state.late = true; return Response.json(base); }
    return storageAck(url, base);
  });
  await assert.rejects(cancelled.run(), error => error.status === 401);
  assert.deepEqual(cancelled.state.calls, [origin + '/rest/v1/rpc/reserve_story_media'], 'a cancelled draft uploads nothing');

  const switched = build((url, init, { state, base }) => {
    if (url.endsWith('/reserve_story_media')) { state.owner = peer; return Response.json(base); }
    return storageAck(url, base);
  });
  await assert.rejects(switched.run(), error => error.status === 401);
  assert.equal(switched.state.calls.length, 1, 'an account change abandons the reservation before any byte leaves');

  const api = createStories({ host: { STORY_MEDIA_VALIDATION: true }, mediaOrigin: origin, publicBucket: 'story-media-public-v3' });
  const canonical = `${origin}/storage/v1/object/public/story-media-public-v3/stories/${owner}/${randomUUID()}_${digest}.jpg`;
  assert.equal(api._media(canonical, 'photo', owner), true);
  for (const bad of [canonical.replace(digest, 'z'.repeat(64)), canonical.replace('_', '-'),
    canonical.replace(/[a-f0-9-]{36}_/, 'not-a-uuid_'), canonical.replace(owner, peer),
    `${origin}/storage/v1/object/public/story-media-quarantine-v3/stories/${owner}/${randomUUID()}_${digest}.jpg`]) {
    assert.equal(api._media(bad, 'photo', owner), false, 'non-canonical public media must not render: ' + bad);
  }
});

test('P-6 approved metadata deletion preserves pending cleanup and never claims physical or account erasure', async context => {
  const db = await database(context);
  const reservation = await reserve(db);
  const quarantine = await upload(db, reservation);
  const approved = await approve(db, reservation);
  await identity(db, owner);
  const published = await rpc(db, 'publish_validated_story', [reservation.request_id, approved.reservation_id, hash]);
  const untouched = await reserve(db);
  const untouchedObject = await upload(db, untouched);

  await db.exec(`RESET ROLE;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,deleted_at timestamptz,is_anonymous boolean DEFAULT false);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE public.report_cases(id uuid PRIMARY KEY,reporter uuid,reported_uid text);
    CREATE TABLE public.report_evidence_holds(case_id uuid REFERENCES public.report_cases(id),hold_ref uuid);`);
  for (const actor of [owner, peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, actor + '@example.invalid']);
  await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/account-rights.sql'), 'utf8'));
  await db.exec('RESET ROLE; UPDATE public.story_media_settings SET cleanup_enabled=true,cleanup_min_age_seconds=0');

  const publicObject = (await db.query("SELECT id::text AS id FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows[0];
  const epoch = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [approved.reservation_id])).rows[0].epoch;
  const plan = () => rpc(db, 'prepare_story_media_cleanup', [randomUUID(), approved.reservation_id, epoch, [quarantine.id, publicObject.id], policy]);
  await identity(db, null, 'service_role');
  await assert.rejects(plan(), { code: 'PT409' }, 'a live published Story needs a tombstone before any cleanup plan');

  await identity(db, owner);
  await rpc(db, 'delete_story', [published.id, randomUUID()]);
  await identity(db, null, 'service_role');
  const dryRun = await plan();
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.storage_delete_authorized, false);
  assert.equal(dryRun.physical_delete_confirmed, false);
  assert.equal(dryRun.account_deleted, false);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [quarantine.id]), { code: 'PT403' }, 'a dry run authorizes nothing');
  await assert.rejects(rpc(db, 'confirm_story_media_cleanup', [dryRun.plan_id, 'd'.repeat(64), randomUUID()]), { code: 'PT409' });

  const confirmed = await rpc(db, 'confirm_story_media_cleanup', [dryRun.plan_id, dryRun.snapshot_sha256, randomUUID()]);
  assert.equal(confirmed.storage_delete_authorized, true);
  assert.equal(confirmed.physical_delete_confirmed, false);
  assert.equal(confirmed.account_deleted, false);
  await assert.rejects(db.query('DELETE FROM storage.objects WHERE id=$1', [untouchedObject.id]),
    { code: 'PT403' }, 'an approved claim never widens to another object of the same owner');
  assert.equal((await db.query('DELETE FROM storage.objects WHERE id = ANY($1) RETURNING id',
    [[quarantine.id, publicObject.id]])).rows.length, 2);
  const closed = await rpc(db, 'confirm_story_media_cleanup', [dryRun.plan_id, dryRun.snapshot_sha256, confirmed.approval_ref]);
  assert.equal(closed.status, 'metadata_deleted');
  assert.equal(closed.physical_delete_confirmed, false);
  assert.equal(closed.account_deleted, false);
  assert.equal(closed.deleted_objects.length, 2);
  assert.equal(closed.deleted_objects.every(entry => entry.physical_delete_confirmed === false), true);

  const inventory = await rpc(db, 'preview_story_media_cleanup', [null, 50]);
  const retained = inventory.items.find(item => item.reservation_id === approved.reservation_id);
  assert.ok(retained, 'metadata deletion must not hide unfinished Storage cleanup');
  assert.equal(retained.pending_intents.length, 2);
  assert.deepEqual(retained.pending_intents.map(intent => intent.object_id).sort(), [quarantine.id, publicObject.id].sort());
  for (const intent of retained.pending_intents) {
    assert.equal(intent.claim_id, dryRun.plan_id);
    assert.equal(intent.operation_id, dryRun.operation_id);
    assert.equal(intent.state, 'object_delete_requested');
    assert.equal(intent.physical_delete_confirmed, false);
    assert.ok(intent.metadata_deleted_at, 'the retained intent records when its catalog row was removed');
    assert.match(intent.object_key, new RegExp('^stories/' + owner + '/'));
    assert.ok(intent.object_version, 'the retained intent keeps the exact object version it was approved against');
  }
  // Read the durable journal itself, not just the absence of a failure: the plan audit must
  // still name both objects and must never upgrade to a physical-erasure claim.
  await db.exec('RESET ROLE');
  const audit = (await db.query('SELECT status,approval_ref,deleted_objects FROM public.story_media_cleanup_plans WHERE id=$1', [dryRun.plan_id])).rows[0];
  assert.equal(audit.status, 'metadata_deleted');
  assert.equal(audit.approval_ref, confirmed.approval_ref);
  assert.deepEqual(audit.deleted_objects.map(entry => entry.object_id).sort(), [quarantine.id, publicObject.id].sort());
  assert.equal(audit.deleted_objects.every(entry => entry.physical_delete_confirmed === false && entry.storage_metadata_deleted_at), true);
  const journal = (await db.query(`SELECT object_id::text AS object_id,object_version,state,outcome,delete_attempts
    FROM public.story_media_cleanup_intents WHERE plan_id=$1 ORDER BY object_id`, [dryRun.plan_id])).rows;
  assert.equal(journal.length, 2);
  assert.equal(journal.every(row => row.state === 'object_delete_requested' && row.outcome === 'pending'), true,
    'retained work stays explicitly pending, it is never quietly marked done or dropped');
  await identity(db, null, 'service_role');
  await assert.rejects(rpc(db, 'prepare_story_media_cleanup', [randomUUID(), approved.reservation_id, epoch, [quarantine.id], policy]),
    { code: 'PT409' }, 'a fresh operation cannot mint a new identity for work that is still journalled');

  await db.exec('RESET ROLE');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id LIKE 'story-media-%'")).rows[0].count, 1,
    'the object outside the approved plan survives');
  assert.equal((await db.query('SELECT id FROM storage.objects WHERE id=$1', [untouchedObject.id])).rows.length, 1);

  const executor = [];
  for (const file of ['supabase/functions/validate-story-media/index.ts', 'scripts/verify-story-media-runtime.ts',
    'scripts/verify-story-media-runtime.cjs', 'js/cloud.js', 'js/mod/stories.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (let at = source.indexOf('DELETE'); at >= 0; at = source.indexOf('DELETE', at + 1)) {
      if (source.slice(Math.max(0, at - 300), at + 300).includes('storage/v1/object')) executor.push(file + '@' + at);
    }
  }
  assert.deepEqual(executor, [], 'validation and client components do not execute Storage cleanup');
});
