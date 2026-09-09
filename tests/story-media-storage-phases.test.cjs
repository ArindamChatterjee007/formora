'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, reserve, claim, owner, peer, hash } = require('./story-media-sql.test.cjs');

async function insert(db, reservation, metadata, version, actor = owner) {
  return (await db.query(`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,version)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id,version`,
    [reservation.bucket, reservation.object_key, actor, actor, metadata, version])).rows[0];
}

test('Storage permission probe rolls back without binding and the exact durable service insert binds at commit', async context => {
  const db = await database(context), reservation = await reserve(db);
  await identity(db, owner); await db.exec('BEGIN');
  await insert(db, reservation, { mimetype: 'image/jpeg', contentLength: 500 }, '1');
  await db.exec('ROLLBACK; RESET ROLE');
  assert.equal((await db.query('SELECT object_id FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0].object_id, null);
  assert.equal((await db.query('SELECT id FROM storage.objects')).rows.length, 0);
  await identity(db, null, 'service_role');
  const version = randomUUID(), stored = await insert(db, reservation, { mimetype: 'image/jpeg', contentLength: 500, size: 500 }, version);
  const lease = await claim(db, reservation);
  assert.equal(lease.object_id, stored.id); assert.equal(lease.object_version, version);
});

test('No caller can commit the transient permission row or omit the durable size', async context => {
  const db = await database(context), reservation = await reserve(db);
  for (const [actor, role] of [[owner, 'authenticated'], [null, 'service_role']]) {
    await identity(db, actor, role);
    await assert.rejects(insert(db, reservation, { mimetype: 'image/jpeg', contentLength: 500 }, '1'), { code: 'PT403' });
    await assert.rejects(insert(db, reservation, { mimetype: 'image/jpeg', contentLength: 500 }, randomUUID()), { code: 'PT403' });
  }
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT id FROM storage.objects')).rows.length, 0);
  assert.equal((await db.query('SELECT object_id FROM public.story_media_reservations')).rows[0].object_id, null);
});

test('Permission and durable phases reject wrong bytes, owner, MIME and premature repeated writes', async context => {
  const db = await database(context), reservation = await reserve(db);
  await identity(db, owner);
  for (const [metadata, actor] of [[{ mimetype: 'image/jpeg', contentLength: 499 }, owner],
    [{ mimetype: 'image/png', contentLength: 500 }, owner], [{ mimetype: 'image/jpeg', contentLength: 500 }, peer]]) {
    await db.exec('BEGIN');
    try { await assert.rejects(insert(db, reservation, metadata, '1', actor), { code: 'PT403' }); }
    finally { await db.exec('ROLLBACK'); }
  }
  await identity(db, null, 'service_role');
  await assert.rejects(insert(db, reservation, { mimetype: 'image/jpeg', size: 499 }, randomUUID()), { code: 'PT403' });
  await assert.rejects(insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID(), peer), { code: 'PT403' });
  await insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID());
  await assert.rejects(insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID()), { code: 'PT403' });
});

test('Missing deferred commit enforcement prevents admission before any upload', async context => {
  const db = await database(context);
  await db.exec(`DROP TRIGGER story_media_storage_bound ON storage.objects;
    CREATE TRIGGER story_media_storage_bound AFTER INSERT ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION public._story_media_storage_bound()`);
  await assert.rejects(reserve(db), { code: 'PT503' });
});

test('Public promotion probes roll back and only the exact leased durable object can finalize', async context => {
  const db = await database(context), reservation = await reserve(db);
  await identity(db, null, 'service_role');
  await insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID());
  const lease = await claim(db, reservation);
  await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]);
  const promotion = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  const metadata = { reservation_id: reservation.reservation_id, owner, sha256: hash, epoch: lease.epoch,
    lease_token: lease.lease_token, promotion_token: promotion.promotion_token };
  const write = (version, size, proof = metadata) => db.query(`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata,version)
    VALUES($1,$2,NULL,NULL,$3,$4,$5) RETURNING id,version`, [promotion.public_bucket, promotion.public_key,
    { mimetype: 'image/jpeg', contentLength: 500, ...(size === undefined ? {} : { size }) }, proof, version]);
  await db.exec('BEGIN'); await write('1'); await db.exec('ROLLBACK');
  const unbound = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  assert.equal(unbound.public_object_id, null); assert.equal(unbound.write_allowed, false);
  await assert.rejects(write('1'), { code: 'PT403' });
  await assert.rejects(write(randomUUID(), 500, { ...metadata, promotion_token: randomUUID() }), { code: 'PT403' });
  const stored = (await write(randomUUID(), 500)).rows[0];
  const approved = await rpc(db, 'finalize_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, stored.id, stored.version]);
  assert.equal(approved.status, 'approved'); assert.equal(approved.public_object_id, stored.id);
  await assert.rejects(write(randomUUID(), 500), { code: 'PT403' });
});

test('Deferred binding rejects two objects in one transaction even without a unique Storage name', async context => {
  const db = await database(context), reservation = await reserve(db);
  await db.exec('RESET ROLE; ALTER TABLE storage.objects DROP CONSTRAINT objects_bucket_id_name_key');
  await identity(db, null, 'service_role'); await db.exec('BEGIN');
  try {
    await insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID());
    await insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID());
    await assert.rejects(db.exec('COMMIT'), { code: 'PT403' });
  } finally { await db.exec('ROLLBACK; RESET ROLE'); }
  assert.equal((await db.query('SELECT id FROM storage.objects')).rows.length, 0);
  assert.equal((await db.query('SELECT object_id FROM public.story_media_reservations')).rows[0].object_id, null);
});

test('Deferred public binding rejects duplicate promotions even without a unique Storage name', async context => {
  const db = await database(context), reservation = await reserve(db);
  await identity(db, null, 'service_role');
  const privateObject = await insert(db, reservation, { mimetype: 'image/jpeg', size: 500 }, randomUUID());
  const lease = await claim(db, reservation);
  await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, hash, 500, 'image/jpeg', 16, 16, null, null]);
  const promotion = await rpc(db, 'claim_story_media_promotion', [owner, reservation.request_id, lease.epoch, lease.lease_token]);
  const metadata = { reservation_id: reservation.reservation_id, owner, sha256: hash, epoch: lease.epoch,
    lease_token: lease.lease_token, promotion_token: promotion.promotion_token };
  await db.exec('RESET ROLE; ALTER TABLE storage.objects DROP CONSTRAINT objects_bucket_id_name_key');
  await identity(db, null, 'service_role'); await db.exec('BEGIN');
  try {
    for (let count = 0; count < 2; count++) {
      await db.query(`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata,version)
        VALUES($1,$2,NULL,NULL,$3,$4,$5)`, [promotion.public_bucket, promotion.public_key,
        { mimetype: 'image/jpeg', size: 500 }, metadata, randomUUID()]);
    }
    await assert.rejects(db.exec('COMMIT'), { code: 'PT403' });
  } finally { await db.exec('ROLLBACK; RESET ROLE'); }
  assert.deepEqual((await db.query('SELECT id FROM storage.objects')).rows, [{ id: privateObject.id }]);
  const current = (await db.query('SELECT object_id,public_object_id,public_object_version,public_sha256,status FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
  assert.deepEqual(current, { object_id: privateObject.id, public_object_id: null, public_object_version: null, public_sha256: null, status: 'promoting' });
});