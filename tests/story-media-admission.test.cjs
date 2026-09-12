'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { database, identity, rpc, owner, peer, policy } = require('./story-media-sql.test.cjs');

async function configure(db, pending, requests, bytes) {
  await db.exec('RESET ROLE');
  await db.query('UPDATE public.story_media_settings SET global_pending=$1,global_requests_per_day=$2,global_bytes_per_day=$3', [pending, requests, bytes]);
}
async function reserve(db, actor, bytes = 500, requestId = randomUUID()) {
  await identity(db, actor);
  return rpc(db, 'reserve_story_media', [requestId, 'photo', 'image/jpeg', bytes]);
}

test('Global admission has no assumed budget and cannot be enabled without explicit limits', async context => {
  const db = await database(context, false);
  const settings = (await db.query('SELECT * FROM public.story_media_settings')).rows[0];
  for (const name of ['global_pending', 'global_requests_per_day', 'global_bytes_per_day']) assert.equal(settings[name], null);
  await assert.rejects(db.query(`UPDATE public.story_media_settings SET enabled=true,publication_required=true,
    storage_policy_approved=true,quota_approved=true,retention_approved=true,
    storage_policy_ref=$1,quota_policy_ref=$1,retention_policy_ref=$1`, [policy]), { code: '23514' });
  assert.equal((await db.query('SELECT enabled FROM public.story_media_settings')).rows[0].enabled, false);
  await assert.rejects(db.exec('UPDATE public.story_media_settings SET global_pending=0'), { code: '23514' });
  await assert.rejects(db.exec('UPDATE public.story_media_settings SET global_requests_per_day=-1'), { code: '23514' });
  await assert.rejects(db.exec('UPDATE public.story_media_settings SET global_bytes_per_day=9007199254740992'), { code: '23514' });
});

test('Global declared-byte admission spans accounts and cancelled reservations retain their daily charge', async context => {
  const db = await database(context);
  await configure(db, 10, 10, 750);
  const first = await reserve(db, owner);
  await assert.rejects(reserve(db, peer), { code: 'PT429', detail: 'media_admission_global_limit' });
  assert.deepEqual(await reserve(db, owner, 500, first.request_id), first);
  await rpc(db, 'cancel_story_media', [first.request_id]);
  const second = await reserve(db, peer, 250);
  assert.equal(second.declared_bytes, 250);
  await assert.rejects(reserve(db, owner, 1), { code: 'PT429' });
  await db.exec('RESET ROLE');
  const totals = (await db.query('SELECT count(*)::int AS requests,sum(declared_bytes)::int AS bytes FROM public.story_media_reservations')).rows[0];
  assert.deepEqual(totals, { requests: 2, bytes: 750 });
});

test('Global request admission counts both owners and cannot be refunded by cancellation', async context => {
  const db = await database(context);
  await configure(db, 10, 2, 10000);
  const first = await reserve(db, owner, 100);
  await reserve(db, peer, 100);
  await assert.rejects(reserve(db, owner, 100), { code: 'PT429' });
  await identity(db, owner); await rpc(db, 'cancel_story_media', [first.request_id]);
  await assert.rejects(reserve(db, owner, 100), { code: 'PT429' });
});

test('Global pending capacity spans owners while exact replay and completed cancellation remain bounded', async context => {
  const db = await database(context);
  await configure(db, 2, 10, 10000);
  const first = await reserve(db, owner, 100), second = await reserve(db, peer, 100);
  await assert.rejects(reserve(db, owner, 100), { code: 'PT429' });
  assert.deepEqual(await reserve(db, peer, 100, second.request_id), second);
  await identity(db, owner); await rpc(db, 'cancel_story_media', [first.request_id]);
  assert.equal((await reserve(db, owner, 100)).status, 'reserved');
  await db.exec('RESET ROLE');
  assert.equal((await db.query("SELECT count(*)::int AS count FROM public.story_media_reservations WHERE status='reserved'")).rows[0].count, 2);
});

test('Renewal cannot reopen a slot already occupied by another owner', async context => {
  const db = await database(context);
  await configure(db, 1, 10, 10000);
  const expired = await reserve(db, owner, 100);
  await db.exec('RESET ROLE');
  await db.query("UPDATE public.story_media_reservations SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [expired.reservation_id]);
  const active = await reserve(db, peer, 100);
  await assert.rejects(reserve(db, owner, 100, expired.request_id), { code: 'PT429', detail: 'media_admission_global_limit' });
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT status,renewals FROM public.story_media_reservations WHERE id=$1', [expired.reservation_id])).rows[0],
    { status: 'reserved', renewals: 0 });
  assert.equal((await db.query('SELECT sum(declared_bytes)::int AS bytes FROM public.story_media_reservations')).rows[0].bytes, 200);
  await identity(db, peer); await rpc(db, 'cancel_story_media', [active.request_id]);
  const retried = await reserve(db, owner, 100, expired.request_id);
  assert.equal(retried.status, 'reserved'); assert.equal(retried.renewals, 1);
  assert.equal(retried.reservation_id, expired.reservation_id);
});

test('Global budget changes invalidate old policy epochs without resetting an existing reservation charge', async context => {
  const db = await database(context);
  await configure(db, 2, 10, 10000);
  const first = await reserve(db, owner, 100);
  await configure(db, 2, 9, 9000);
  const renewed = await reserve(db, owner, 100, first.request_id);
  assert.equal(renewed.policy_epoch, first.policy_epoch + 1);
  assert.equal(renewed.reservation_id, first.reservation_id); assert.equal(renewed.renewals, 1);
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT count(*)::int AS requests,sum(declared_bytes)::int AS bytes FROM public.story_media_reservations')).rows[0], { requests: 1, bytes: 100 });
});

test('Admission refuses snapshot isolation before writing a reservation', async context => {
  const db = await database(context);
  for (const isolation of ['READ UNCOMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    await identity(db, owner);
    await db.exec('BEGIN ISOLATION LEVEL ' + isolation);
    try {
      await assert.rejects(rpc(db, 'reserve_story_media', [randomUUID(), 'photo', 'image/jpeg', 500]), { code: 'PT503' });
    } finally { await db.exec('ROLLBACK'); }
  }
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.story_media_reservations')).rows[0].count, 0);
});

test('Global new-admission accounting uses UTC days and does not imply a retained-byte ceiling', async context => {
  const db = await database(context);
  await configure(db, 1, 1, 500);
  await db.exec("SET TIME ZONE 'Pacific/Honolulu'");
  const previous = await reserve(db, owner);
  await db.exec('RESET ROLE');
  await db.query(`UPDATE public.story_media_reservations
    SET created_at=date_trunc('day',clock_timestamp(),'UTC')-interval '1 hour',
      expires_at=date_trunc('day',clock_timestamp(),'UTC')-interval '45 minutes' WHERE id=$1`, [previous.reservation_id]);
  await reserve(db, peer);
  await assert.rejects(reserve(db, owner), { code: 'PT429' });
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT sum(declared_bytes)::int AS bytes FROM public.story_media_reservations')).rows[0].bytes, 1000);
  assert.equal((await db.query("SELECT sum(declared_bytes)::int AS bytes FROM public.story_media_reservations WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')")).rows[0].bytes, 500);
});

test('A lower daily cap does not recharge renewal or release stale-policy pending slots', async context => {
  const db = await database(context);
  await configure(db, 2, 10, 10000);
  const first = await reserve(db, owner, 500), second = await reserve(db, peer, 500);
  await configure(db, 2, 1, 500);
  const renewed = await reserve(db, owner, 500, first.request_id);
  assert.equal(renewed.status, 'reserved'); assert.equal(renewed.reservation_id, first.reservation_id);
  assert.equal(renewed.renewals, 1);
  await assert.rejects(reserve(db, peer, 1), { code: 'PT429', detail: 'media_admission_global_limit' });
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query("SELECT count(*)::int AS requests,sum(declared_bytes)::int AS bytes,count(*) FILTER(WHERE status='reserved')::int AS pending FROM public.story_media_reservations")).rows[0],
    { requests: 2, bytes: 1000, pending: 2 });
  assert.equal((await db.query('SELECT policy_epoch FROM public.story_media_reservations WHERE id=$1', [second.reservation_id])).rows[0].policy_epoch, first.policy_epoch);
});