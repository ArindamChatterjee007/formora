'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const root = path.join(__dirname, '..');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const policy = '33333333-3333-4333-8333-333333333333';
const hash = 'a'.repeat(64);

async function identity(db, actor = owner, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor || '']);
  await db.exec('SET ROLE ' + role);
}
async function rpc(db, name, parameters = []) {
  return (await db.query(`SELECT public.${name}(${parameters.map((_, index) => '$' + (index + 1)).join(',')}) AS result`, parameters)).rows[0].result;
}
async function database(context, enabled = true, applyMedia = true) {
  const db = new PGlite();
  context?.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE inherited_service INHERIT BYPASSRLS; GRANT service_role TO inherited_service;
    CREATE ROLE inherited_member INHERIT; GRANT authenticated TO inherited_member;
    CREATE ROLE inherited_anon INHERIT; GRANT anon TO inherited_anon;
    CREATE SCHEMA auth; CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA public,auth,storage TO PUBLIC;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.profiles(uid text PRIMARY KEY,data jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE public.requests(id text PRIMARY KEY,from_uid text,to_uid text,status text);
    CREATE TABLE public.messages(id text PRIMARY KEY,from_uid text,to_uid text,body text,ts timestamptz);
    CREATE TABLE public.stories(id text PRIMARY KEY,author text,photo text,kind text,ts timestamptz);
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),
      name text NOT NULL,owner uuid,owner_id text,version text DEFAULT gen_random_uuid()::text,metadata jsonb,user_metadata jsonb,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(bucket_id,name));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON storage.objects TO PUBLIC;
    CREATE POLICY inherited_legacy_all ON storage.objects FOR ALL TO PUBLIC USING(true) WITH CHECK(true);
    INSERT INTO storage.buckets VALUES('media','media',true,157286400,NULL);`);
  await db.exec(fs.readFileSync(path.join(root, 'supabase/story-interactions.sql'), 'utf8'));
  if (applyMedia) await db.exec(fs.readFileSync(path.join(root, 'supabase/story-media.sql'), 'utf8'));
  for (const actor of [owner, peer]) await db.query('INSERT INTO public.profiles VALUES($1,$2)', [actor, { name: 'Synthetic fixture', privacy: 'public' }]);
  if (enabled && applyMedia) {
    await db.query(`UPDATE public.story_settings SET enabled=true,permission_policy_approved=true,media_audience_approved=true,
      public_media_approved=true,retention_approved=true,operator_policy_ref=$1,media_origin='https://fixture.supabase.co',public_bucket='story-media-public-v3'`, [policy]);
    await db.query(`UPDATE public.story_media_settings SET enabled=true,publication_required=true,storage_policy_approved=true,
      quota_approved=true,retention_approved=true,storage_policy_ref=$1,quota_policy_ref=$1,retention_policy_ref=$1`, [policy]);
    await db.exec("UPDATE storage.buckets SET public=true WHERE id='story-media-public-v3'");
  }
  return db;
}
async function reserve(db, request = randomUUID(), kind = 'photo', mime = 'image/jpeg', bytes = 500) {
  await identity(db);
  return rpc(db, 'reserve_story_media', [request, kind, mime, bytes]);
}
async function upload(db, reservation, actor = owner, role = 'authenticated', overrides = {}) {
  await identity(db, actor, role);
  const metadata = overrides.metadata || { size: reservation.declared_bytes, mimetype: reservation.content_type };
  return (await db.query(`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version`,
    [overrides.bucket || reservation.bucket, overrides.key || reservation.object_key, overrides.owner || actor,
      overrides.ownerId || actor, metadata, overrides.userMetadata || null])).rows[0];
}
async function claim(db, reservation) {
  await identity(db, null, 'service_role');
  return rpc(db, 'claim_story_media_validation', [reservation.owner, reservation.request_id]);
}
async function approve(db, reservation, overrides = {}) {
  const lease = await claim(db, reservation);
  const attested = await rpc(db, 'attest_story_media', [reservation.owner, reservation.request_id, lease.epoch, lease.lease_token,
    overrides.sha256 || hash, reservation.declared_bytes, reservation.content_type, 16, 16,
    reservation.kind === 'video' ? 1000 : null, null]);
  const promotion = await rpc(db, 'claim_story_media_promotion', [reservation.owner, reservation.request_id, lease.epoch, lease.lease_token]);
  const stored = await upload(db, reservation, null, 'service_role', { bucket: promotion.public_bucket, key: promotion.public_key,
    userMetadata: { reservation_id: reservation.reservation_id, owner: reservation.owner, sha256: attested.sha256,
      epoch: lease.epoch, lease_token: lease.lease_token, promotion_token: promotion.promotion_token } });
  const final = await rpc(db, 'finalize_story_media', [reservation.owner, reservation.request_id, lease.epoch, lease.lease_token,
    attested.sha256, stored.id, stored.version]);
  Object.assign(reservation, final);
  return final;
}

module.exports = { database, identity, rpc, reserve, upload, claim, approve, owner, peer, policy, hash };

if (require.main === module) {
  test('Storage DDL refuses existing candidate bucket adoption and insufficient ownership without privilege overrides', async context => {
    for (const condition of ['story-media-quarantine-v3', 'story-media-public-v3', 'limited-role', 'missing-column']) {
      const db = await database(context, false, false);
      if (condition === 'limited-role') await db.exec(`CREATE ROLE limited_media_migrator;
        GRANT CREATE ON SCHEMA public TO limited_media_migrator; GRANT SELECT ON storage.buckets TO limited_media_migrator;
        SET ROLE limited_media_migrator;`);
      else if (condition === 'missing-column') await db.exec('ALTER TABLE storage.objects DROP COLUMN user_metadata');
      else await db.query('INSERT INTO storage.buckets(id,name,public) VALUES($1,$1,false)', [condition]);
      await assert.rejects(db.exec(fs.readFileSync(path.join(root, 'supabase/story-media.sql'), 'utf8')),
        error => /automatic adoption is forbidden|Storage DDL ownership/.test(error.message));
      await db.exec('ROLLBACK; RESET ROLE');
      assert.equal((await db.query("SELECT to_regclass('public.story_media_settings') AS relation")).rows[0].relation, null);
    }
  });
  test('missing or disabled Storage guards and schema drift fail closed before any new reservation', async context => {
    const db = await database(context);
    for (const [table, trigger] of [['storage.objects', 'story_media_storage_guard'], ['storage.objects', 'story_media_storage_bound'],
      ['storage.buckets', 'story_media_bucket_guard'], ['public.story_content', 'story_media_publication_gate']]) {
      await db.exec('RESET ROLE; ALTER TABLE ' + table + ' DISABLE TRIGGER ' + trigger);
      await assert.rejects(reserve(db), { code: 'PT503' });
      await db.exec('RESET ROLE; ALTER TABLE ' + table + ' ENABLE TRIGGER ' + trigger);
    }
    await db.exec('ALTER TABLE storage.objects RENAME COLUMN user_metadata TO unsupported_metadata');
    await assert.rejects(reserve(db), { code: 'PT503' });
  });
  test('expired renewal cannot exceed the pending-owner cap or reset the original daily charge', async context => {
    const db = await database(context), expired = await reserve(db);
    await db.exec('RESET ROLE');
    await db.query("UPDATE public.story_media_reservations SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [expired.reservation_id]);
    for (let count = 0; count < 3; count++) await reserve(db);
    const result = await reserve(db, expired.request_id);
    assert.equal(result.status, 'cancelled'); assert.equal(result.failure_code, 'reservation_expired');
    await db.exec('RESET ROLE');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM public.story_media_reservations WHERE status='reserved'")).rows[0].count, 3);
    assert.equal((await db.query('SELECT sum(declared_bytes)::int AS bytes FROM public.story_media_reservations')).rows[0].bytes, 2000);
  });
  test('renewal count is bounded and cannot become an unlimited fresh-request quota bypass', async context => {
    const db = await database(context), reservation = await reserve(db);
    for (let renewal = 1; renewal <= 4; renewal++) {
      await identity(db, null, 'service_role');
      await db.query('UPDATE public.story_media_settings SET video_ms=$1', [30000 - renewal]);
      const result = await reserve(db, reservation.request_id);
      assert.equal(result.renewals, Math.min(renewal, 3)); assert.equal(result.status, renewal <= 3 ? 'reserved' : 'cancelled');
    }
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_reservations')).rows[0].count, 1);
  });
  test('settings epochs only track actual policy changes and no-op or direct epoch writes stay stable', async context => {
    const db = await database(context), reservation = await reserve(db);
    await identity(db, null, 'service_role');
    await db.exec('UPDATE public.story_media_settings SET video_ms=video_ms,retention_policy_ref=retention_policy_ref,policy_epoch=999');
    assert.equal((await db.query('SELECT policy_epoch FROM public.story_media_settings')).rows[0].policy_epoch, reservation.policy_epoch);
    await db.exec('UPDATE public.story_media_settings SET video_ms=29999');
    assert.equal((await db.query('SELECT policy_epoch FROM public.story_media_settings')).rows[0].policy_epoch, reservation.policy_epoch + 1);
    await db.exec('UPDATE public.story_media_settings SET video_ms=29999');
    assert.equal((await db.query('SELECT policy_epoch FROM public.story_media_settings')).rows[0].policy_epoch, reservation.policy_epoch + 1);
  });
  test('same-owner policy renewal preserves immutable request and upload without resetting charges or attempt cap', async context => {
    const db = await database(context), reservation = await reserve(db);
    const stored = await upload(db, reservation), lease = await claim(db, reservation);
    await db.exec('UPDATE public.story_media_settings SET video_ms=29999');
    await assert.rejects(rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]), { code: 'PT409' });
    const renewed = await reserve(db, reservation.request_id);
    assert.equal(renewed.reservation_id, reservation.reservation_id); assert.equal(renewed.object_key, reservation.object_key);
    assert.equal(renewed.public_key_id, reservation.public_key_id); assert.equal(renewed.uploaded, true); assert.equal(renewed.renewals, 1);
    await assert.rejects(upload(db, renewed), { code: 'PT403' });
    await assert.rejects(reserve(db, reservation.request_id, 'photo', 'image/png'), { code: 'PT409' });
    const next = await claim(db, renewed); assert.notEqual(next.lease_token, lease.lease_token);
    await db.exec('RESET ROLE');
    const rows = (await db.query('SELECT *,sum(declared_bytes) OVER() AS charged FROM public.story_media_reservations')).rows;
    assert.equal(rows.length, 1); assert.equal(Number(rows[0].charged), 500); assert.equal(rows[0].attempts, 2);
    assert.equal(rows[0].object_id, stored.id); assert.equal(rows[0].object_version, stored.version);
  });
  test('uncertain promotion or incompatible tightening returns explicit cancellation without renewing an unsafe binding', async context => {
    for (const mode of ['promotion', 'incompatible']) {
      const db = await database(context), reservation = await reserve(db); await upload(db, reservation);
      if (mode === 'promotion') {
        const lease = await claim(db, reservation);
        await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]);
        await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
      }
      await identity(db, null, 'service_role');
      await db.exec(mode === 'promotion' ? 'UPDATE public.story_media_settings SET video_ms=29999' : 'UPDATE public.story_media_settings SET photo_bytes=499');
      const cancelled = await reserve(db, reservation.request_id);
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.failure_code, mode === 'promotion' ? 'promotion_review_required' : 'policy_changed');
      assert.deepEqual(await reserve(db, reservation.request_id), cancelled); assert.equal(cancelled.renewals, 0);
      await db.exec('RESET ROLE');
      const rows = (await db.query('SELECT declared_bytes,attempts FROM public.story_media_reservations')).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].declared_bytes, 500);
      assert.equal((await db.query("SELECT id FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows.length, 0);
    }
  });
  test('infrastructure attestations release the lease without terminal invalidity and retain the three-attempt cap', async context => {
    const db = await database(context), reservation = await reserve(db); await upload(db, reservation);
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease = await claim(db, reservation);
      const retry = await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token,
        null, null, null, null, null, null, 'storage_unavailable']);
      assert.equal(retry.status, 'reserved'); assert.equal(retry.sha256, null); assert.equal(retry.public_key, null);
      assert.equal((await reserve(db, reservation.request_id)).reservation_id, reservation.reservation_id);
    }
    await assert.rejects(claim(db, reservation), { code: 'PT429' });
    assert.equal((await db.query("SELECT id FROM storage.objects WHERE bucket_id='story-media-public-v3'")).rows.length, 0);
  });
  test('quarantine is permanently private, anonymous reads deny and rejected bytes create zero public objects', async context => {
    const db = await database(context), reservation = await reserve(db);
    assert.equal(reservation.schema_version, 2); assert.equal(reservation.bucket, 'story-media-quarantine-v3');
    assert.equal(reservation.media_url, null); assert.equal(reservation.public_key, null);
    await upload(db, reservation);
    await identity(db, null, 'anon');
    assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 0);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT public FROM storage.buckets WHERE id=$1', [reservation.bucket])).rows[0].public, false);
    await assert.rejects(db.query('UPDATE storage.buckets SET public=true WHERE id=$1', [reservation.bucket]), { code: 'PT403' });
    const lease = await claim(db, reservation);
    const failed = await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token,
      null, null, null, null, null, null, 'invalid_media']);
    assert.equal(failed.status, 'failed'); assert.equal(failed.media_url, null);
    await assert.rejects(rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]), { code: 'PT409' });
    assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id=$1', [reservation.public_bucket])).rows[0].count, 0);
    for (const role of ['service_role', 'inherited_service']) {
      await identity(db, null, role);
      await assert.rejects(db.exec('UPDATE storage.objects SET owner_id=NULL'), { code: 'PT403' });
      await assert.rejects(db.exec('DELETE FROM storage.objects'), { code: 'PT403' });
    }
  });
  test('promotion accepts only exact service-leased attested key and hash, finalizes stored version and never repeats an INSERT', async context => {
    const db = await database(context), reservation = await reserve(db);
    await upload(db, reservation);
    await assert.rejects(upload(db, reservation, null, 'service_role', { bucket: reservation.public_bucket }), { code: 'PT403' });
    const lease = await claim(db, reservation);
    await assert.rejects(rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]), { code: 'PT409' });
    const attested = await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]);
    assert.equal(attested.status, 'attested'); assert.notEqual(attested.public_key_id, reservation.reservation_id);
    assert.equal(attested.public_key, `stories/${owner}/${reservation.public_key_id}_${hash}.jpg`);
    await identity(db);
    await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]), { code: 'PT409' });
    await identity(db, null, 'service_role');
    const promotion = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
    assert.equal(promotion.write_allowed, true);
    const exact = { bucket: promotion.public_bucket, key: promotion.public_key, userMetadata: { reservation_id: reservation.reservation_id,
      owner, sha256: hash, epoch: lease.epoch, lease_token: lease.lease_token, promotion_token: promotion.promotion_token } };
    for (const altered of [{ sha256: 'b'.repeat(64) }, { owner: peer }, { lease_token: randomUUID() }, { promotion_token: randomUUID() }]) {
      await assert.rejects(upload(db, reservation, null, 'service_role', { ...exact, userMetadata: { ...exact.userMetadata, ...altered } }), { code: 'PT403' });
    }
    for (const role of ['authenticated', 'inherited_service']) await assert.rejects(upload(db, reservation, owner, role, exact), { code: 'PT403' });
    const stored = await upload(db, reservation, null, 'service_role', exact);
    await assert.rejects(upload(db, reservation, null, 'service_role', exact), { code: 'PT403' });
    const replay = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
    assert.equal(replay.write_allowed, false); assert.equal(replay.public_object_id, stored.id); assert.equal(replay.public_object_version, stored.version);
    await assert.rejects(rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, stored.id, 'wrong-version']), { code: 'PT409' });
    assert.equal((await rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, stored.id, stored.version])).status, 'approved');
    assert.equal((await rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, stored.id, stored.version])).status, 'approved');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects WHERE bucket_id=$1', [promotion.public_bucket])).rows[0].count, 1);
    await identity(db);
    const published = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
    assert.equal((await rpc(db, 'get_story', [published.id])).photo, attested.media_url);
  });
  test('candidate DDL compiles after the real predecessor and defaults off without approvals', async context => {
    const db = await database(context, false);
    const settings = (await db.query('SELECT * FROM public.story_media_settings')).rows[0];
    for (const key of ['enabled', 'publication_required', 'storage_policy_approved', 'quota_approved', 'retention_approved']) assert.equal(settings[key], false);
    for (const key of ['storage_policy_ref', 'quota_policy_ref', 'retention_policy_ref']) assert.equal(settings[key], null);
    assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-quarantine-v3'")).rows[0].public, false);
    assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='story-media-public-v3'")).rows[0].public, false);
    await assert.rejects(db.exec('UPDATE public.story_media_settings SET enabled=true'), { code: '23514' });
    await assert.rejects(reserve(db), { code: 'PT503' });
  });
  test('reservation identity and payload are server-bound and the private tables deny inherited raw access', async context => {
    const db = await database(context), request = randomUUID(), reservation = await reserve(db, request);
    assert.equal(reservation.owner, owner);
    assert.equal(reservation.object_key, `stories/${owner}/${reservation.reservation_id}.jpg`);
    assert.deepEqual(await reserve(db, request), reservation);
    await assert.rejects(reserve(db, request, 'photo', 'image/png'), { code: 'PT409' });
    await identity(db, owner, 'inherited_member');
    for (const table of ['story_media_settings', 'story_media_reservations', 'story_media_publish_intents']) {
      await assert.rejects(db.query('SELECT * FROM public.' + table), { code: '42501' });
    }
    await assert.rejects(rpc(db, 'claim_story_media_validation', [owner, request]), { code: '42501' });
    await identity(db, owner, 'inherited_anon');
    await assert.rejects(rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 50]), { code: '42501' });
  });
  test('exact owned Storage insert is allowed once even with a broad inherited legacy policy', async context => {
    const db = await database(context), reservation = await reserve(db);
    await assert.rejects(upload(db, reservation, peer), { code: 'PT403' });
    await assert.rejects(upload(db, reservation, owner, 'inherited_member', { ownerId: peer }), { code: 'PT403' });
    await upload(db, reservation, owner, 'inherited_member');
    await assert.rejects(upload(db, reservation), { code: 'PT403' });
    assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects')).rows[0].count, 1);
    await identity(db, peer);
    assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 0);
  });
  test('only attested immutable bytes publish through the real predecessor RPC with the original request ID', async context => {
    const db = await database(context), reservation = await reserve(db);
    await upload(db, reservation);
    await assert.rejects(rpc(db, 'publish_story', [reservation.request_id, `https://fixture.supabase.co/storage/v1/object/public/story-media-public-v3/stories/${owner}/forged.jpg`, 'photo', 'authenticated']), { code: 'PT403' });
    await approve(db, reservation);
    await identity(db);
    await assert.rejects(rpc(db, 'publish_validated_story', [randomUUID(), reservation.reservation_id, hash]), { code: 'PT409' });
    const result = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
    assert.equal(result.committed, true); assert.equal(result.request_id, reservation.request_id);
    assert.notEqual(result.id, reservation.reservation_id);
    assert.equal((await rpc(db, 'get_story', [result.id])).photo, reservation.media_url);
    const again = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
    assert.equal(again.id, result.id); assert.equal(again.duplicate, true);
  });
  test('technical caps reject nulls, unsupported MIME, kind mismatch, and values above the candidate ceiling', async context => {
    const db = await database(context);
    for (const declaration of [['photo', 'image/gif', 1], ['photo', 'video/mp4', 1], ['video', 'video/mp4; codecs=avc1', 1],
      ['photo', 'image/jpeg', 8388609], ['video', 'video/webm', 26214401], ['photo', 'image/png', 0], [null, 'image/jpeg', 1]]) {
      await assert.rejects(reserve(db, randomUUID(), ...declaration), { code: '22023' });
    }
    await identity(db, null, 'service_role');
    for (const [column, maximum] of Object.entries({ photo_bytes: 8388608, video_bytes: 26214400, video_ms: 30000, max_pixels: 16777216,
      pending_per_owner: 3, requests_per_day: 20, bytes_per_day: 104857600 })) {
      await assert.rejects(db.query(`UPDATE public.story_media_settings SET ${column}=$1`, [maximum + 1]), { code: '23514' });
    }
  });
  test('pending and daily budgets include cancellations and repeated fresh request IDs but not idempotent retries', async context => {
    const db = await database(context);
    const first = await reserve(db), second = await reserve(db), third = await reserve(db);
    await assert.rejects(reserve(db), { code: 'PT429' });
    await reserve(db, first.request_id);
    for (const reservation of [first, second, third]) await rpc(db, 'cancel_story_media', [reservation.request_id]);
    for (let count = 3; count < 20; count++) {
      const reservation = await reserve(db); await rpc(db, 'cancel_story_media', [reservation.request_id]);
    }
    await assert.rejects(reserve(db), { code: 'PT429' });
    await identity(db, peer);
    assert.equal((await rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 500])).owner, peer);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_reservations WHERE owner=$1', [owner])).rows[0].count, 20);
  });
  test('declared byte budget is charged atomically even when each upload is cancelled', async context => {
    const db = await database(context);
    for (let count = 0; count < 4; count++) {
      const reservation = await reserve(db, randomUUID(), 'video', 'video/mp4', 26214400);
      await rpc(db, 'cancel_story_media', [reservation.request_id]);
    }
    await assert.rejects(reserve(db), { code: 'PT429' });
  });
  test('broad direct inherited grants still cannot write private reservation rows under deny-by-default RLS', async context => {
    const db = await database(context), reservation = await reserve(db);
    await db.exec('RESET ROLE; GRANT SELECT,INSERT,UPDATE,DELETE ON public.story_media_reservations TO inherited_member');
    await identity(db, owner, 'inherited_member');
    assert.equal((await db.query('SELECT * FROM public.story_media_reservations')).rows.length, 0);
    assert.equal((await db.query("UPDATE public.story_media_reservations SET status='approved' RETURNING id")).rows.length, 0);
    await assert.rejects(db.query(`INSERT INTO public.story_media_reservations(owner,request_id,payload_digest,kind,content_type,declared_bytes,
      object_key,media_url,policy_epoch,created_at,expires_at) VALUES($1,$2,$3,'photo','image/jpeg',1,'forged','forged',1,now(),now()+interval '15 minutes')`,
    [owner, randomUUID(), hash]), { code: '42501' });
    assert.equal((await reserve(db, reservation.request_id)).status, 'reserved');
  });
  test('Storage UUID ownership, exact key, exact declared bytes and MIME are enforced independently of legacy policies', async context => {
    const db = await database(context), reservation = await reserve(db);
    for (const overrides of [{ owner: peer }, { ownerId: peer }, { key: reservation.object_key + '/extra.jpg' },
      { key: `stories/${peer}/${reservation.reservation_id}.jpg` }, { metadata: { size: 501, mimetype: 'image/jpeg' } },
      { metadata: { size: 500, mimetype: 'image/png' } }]) {
      await assert.rejects(upload(db, reservation, owner, 'authenticated', overrides), { code: 'PT403' });
    }
    await upload(db, reservation);
  });
  test('NULL owner metadata fails closed even when the Storage writer bypasses RLS', async context => {
    const db = await database(context), reservation = await reserve(db);
    assert.equal(await rpc(db, '_story_media_storage_insert', [reservation.bucket, reservation.object_key, null]), false);
    await identity(db, owner, 'service_role');
    await assert.rejects(db.query(`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata) VALUES($1,$2,$3,NULL,$4)`,
      [reservation.bucket, reservation.object_key, owner, { size: 500, mimetype: 'image/jpeg' }]), { code: 'PT403' });
  });
  test('candidate objects resist UPDATE DELETE rename and upsert even for service bypass, while legacy objects remain unaffected', async context => {
    const db = await database(context), reservation = await reserve(db);
    await upload(db, reservation);
    for (const role of ['authenticated', 'inherited_member']) {
      await identity(db, owner, role);
      assert.equal((await db.query("UPDATE storage.objects SET metadata='{}' WHERE bucket_id='story-media-quarantine-v3' RETURNING id")).rows.length, 0);
      assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='story-media-quarantine-v3' RETURNING id")).rows.length, 0);
    }
    await identity(db, null, 'service_role');
    for (const statement of ["UPDATE storage.objects SET metadata='{}'", "UPDATE storage.objects SET name='replaced.jpg'", 'DELETE FROM storage.objects']) {
      await assert.rejects(db.exec(statement), { code: 'PT403' });
    }
    await identity(db);
    await db.exec("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('media','legacy.jpg','{}')");
    assert.equal((await db.query("UPDATE storage.objects SET metadata='{}' WHERE bucket_id='media' RETURNING id")).rows.length, 1);
    assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='media' RETURNING id")).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length, 1);
  });
  test('a cancel, expired lease, reservation expiry or settings epoch change fences a late service attestation', async context => {
    const db = await database(context);
    for (const boundary of ['cancel', 'lease', 'expiry', 'policy']) {
      const reservation = await reserve(db); await upload(db, reservation); const lease = await claim(db, reservation);
      if (boundary === 'cancel') { await identity(db); await rpc(db, 'cancel_story_media', [reservation.request_id]); }
      else {
        await db.exec('RESET ROLE');
        if (boundary === 'lease') await db.query("UPDATE public.story_media_reservations SET lease_until=now()-interval '1 second' WHERE id=$1", [reservation.reservation_id]);
        if (boundary === 'expiry') await db.query("UPDATE public.story_media_reservations SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [reservation.reservation_id]);
        if (boundary === 'policy') await db.exec('UPDATE public.story_media_settings SET video_ms=29999');
      }
      await identity(db, null, 'service_role');
      await assert.rejects(rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]), { code: 'PT409' });
      await identity(db); await rpc(db, 'cancel_story_media', [reservation.request_id]);
    }
  });
  test('validation leases are finite, never caller-issued and cannot cross owners', async context => {
    const db = await database(context), reservation = await reserve(db); await upload(db, reservation);
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease = await claim(db, reservation);
      await assert.rejects(rpc(db, 'claim_story_media_validation', [peer, reservation.request_id]), { code: 'PT404' });
      await assert.rejects(rpc(db, 'claim_story_media_validation', [owner, reservation.request_id]), { code: 'PT429' });
      await assert.rejects(rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, randomUUID(), hash, 500, 'image/jpeg', 16, 16, null, null]), { code: 'PT409' });
      await db.exec('RESET ROLE');
      await db.query("UPDATE public.story_media_reservations SET lease_until=now()-interval '1 second' WHERE id=$1", [reservation.reservation_id]);
    }
    await assert.rejects(claim(db, reservation), { code: 'PT429' });
  });
  test('video cannot be attested without verified duration or exact type bytes hash and dimensions', async context => {
    const db = await database(context), reservation = await reserve(db, randomUUID(), 'video', 'video/mp4', 500);
    await upload(db, reservation); const lease = await claim(db, reservation);
    const baseline = [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'video/mp4', 16, 16, 1000, null];
    for (const [index, value] of [[4, null], [4, 'bad'], [5, 501], [6, 'video/webm'], [7, null], [8, 8193], [9, null], [9, 30001]]) {
      const argumentsForCase = [...baseline]; argumentsForCase[index] = value;
      await assert.rejects(rpc(db, 'attest_story_media', argumentsForCase), { code: '22023' });
    }
    assert.equal((await rpc(db, 'attest_story_media', baseline)).duration_verified, true);
  });
  test('server-required mode rejects direct legacy v2 RPC and content updates, rolls back parent rows, and protects receipt reuse', async context => {
    const db = await database(context), reservation = await reserve(db); await upload(db, reservation); await approve(db, reservation);
    await identity(db);
    for (const kind of ['photo', 'video']) {
      await assert.rejects(rpc(db, 'publish_story', [randomUUID(), reservation.media_url, kind, 'authenticated']));
    }
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.stories_v2')).rows[0].count, 0);
    await identity(db, peer);
    await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]), { code: 'PT409' });
    await identity(db);
    await assert.rejects(rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, 'b'.repeat(64)]), { code: 'PT409' });
    const result = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
    await db.exec('RESET ROLE');
    await assert.rejects(db.query('UPDATE public.story_content SET media_url=$1 WHERE story_id=$2', [reservation.media_url, result.id]), { code: 'PT403' });
    await db.exec("INSERT INTO public.stories VALUES('legacy','legacy','unchanged.jpg','photo',now())");
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.stories')).rows[0].count, 1);
  });
  test('service inventory is bounded and dry-run only; cancellation never erases Storage bytes', async context => {
    const db = await database(context), reservation = await reserve(db); await upload(db, reservation);
    await rpc(db, 'cancel_story_media', [reservation.request_id]);
    await assert.rejects(rpc(db, 'preview_story_media_cleanup'), { code: '42501' });
    await identity(db, null, 'service_role');
    await assert.rejects(rpc(db, 'preview_story_media_cleanup', [null, 51]), { code: '22023' });
    const report = await rpc(db, 'preview_story_media_cleanup', [null, 1]);
    assert.equal(report.dry_run, true); assert.equal(report.physical_delete_allowed, false);
    assert.equal(report.items.length, 1); assert.equal(report.items[0].object_key, reservation.object_key);
    assert.equal(report.next_cursor, reservation.reservation_id);
    assert.equal((await rpc(db, 'preview_story_media_cleanup', [report.next_cursor, 1])).items.length, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM storage.objects')).rows[0].count, 1);
  });
}