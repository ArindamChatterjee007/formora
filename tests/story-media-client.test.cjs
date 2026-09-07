'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash, randomUUID } = require('node:crypto');
const createStories = require('../js/mod/stories.js');
const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const root = 'https://fixture.supabase.co';
function fixture(options = {}) {
  const state = { calls: [], owner, epoch: 1, uploaded: false, late: false };
  const file = new File(['synthetic transport bytes'], 'photo.jpg', { type: 'image/jpeg' });
  const requestId = randomUUID(), reservationId = randomUUID(), publicKeyId = randomUUID();
  const objectKey = `stories/${owner}/${reservationId}.jpg`;
  const hash = createHash('sha256').update('synthetic transport bytes').digest('hex');
  const publicKey = `stories/${owner}/${publicKeyId}_${hash}.jpg`;
  const reservation = { schema_version: 2, owner, request_id: requestId, reservation_id: reservationId,
    bucket: 'story-media-quarantine-v3', object_key: objectKey, media_url: null,
    public_bucket: 'story-media-public-v3', public_key_id: publicKeyId, public_key: null, public_object_id: null, public_object_version: null,
    content_type: file.type, kind: 'photo', declared_bytes: file.size, expires_at: new Date(Date.now() + 900000).toISOString(),
    policy_epoch: 1, status: 'reserved', uploaded: false };
  const receipt = { ...reservation, status: 'approved', uploaded: true, actual_bytes: file.size, width: 16, height: 16,
    duration_ms: null, duration_verified: false, sha256: hash, public_key: publicKey,
    public_object_id: randomUUID(), public_object_version: 'fixture-stored-public-version',
    media_url: `${root}/storage/v1/object/public/story-media-public-v3/${publicKey}` };
  const host = { USE_SUPABASE_AUTH: true, SUPABASE_URL: root, SUPABASE_ANON_KEY: 'fixture-public', STORY_INTERACTIONS: true, STORY_MEDIA_VALIDATION: true };
  const auth = { active: () => true, uid: () => state.owner, token: async () => 'verified-fixture-token', _authEpoch: 1 };
  const network = async (url, init) => {
    state.calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init, { state, reservation, receipt });
    if (url.endsWith('/reserve_story_media')) return Response.json({ ...reservation, uploaded: state.uploaded });
    if (url.includes('/storage/')) { state.uploaded = true; return Response.json({ Key: 'story-media-quarantine-v3/' + objectKey, Id: randomUUID() }, { status: 200 }); }
    return Response.json(receipt);
  };
  const context = vm.createContext({ window: host, SupaAuth: auth, File, Blob, Response, URL, Uint8Array, TextDecoder, TextEncoder,
    crypto: webcrypto, atob, AbortController, setTimeout: options.setTimeout || setTimeout, clearTimeout, fetch: network });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cloud.js'), 'utf8') + '\nglobalThis.cloud=Cloud;', context);
  const cloud = context.cloud; cloud.me = owner; cloud.key = 'fixture-public'; cloud.base = root + '/rest/v1';
  const upload = () => cloud.uploadMedia(file, 'stories', { requestId, current: () => !state.late });
  return { context, host, auth, state, cloud, file, requestId, reservation, receipt, upload };
}

test('validated upload reserves, uses exact no-overwrite storage ACK, validates, and checks the actual file hash', async () => {
  const client = fixture(), receipt = await client.upload();
  assert.equal(receipt.sha256, client.receipt.sha256); assert.equal(client.state.calls.length, 3);
  const [reserve, upload, validate] = client.state.calls;
  assert.deepEqual(JSON.parse(reserve.init.body), { p_request_id: client.requestId, p_kind: 'photo', p_content_type: 'image/jpeg', p_declared_bytes: client.file.size });
  assert.equal(upload.init.headers['x-upsert'], 'false'); assert.equal(upload.init.body, client.file);
  assert.equal(upload.url, root + '/storage/v1/object/story-media-quarantine-v3/' + client.reservation.object_key);
  assert.equal(receipt.media_url.includes('/public/story-media-public-v3/'), true);
  assert.equal(client.state.calls.some(call => call.url.includes('/object/story-media-public-v3/')), false);
  assert.deepEqual(JSON.parse(validate.init.body), { request_id: client.requestId });
  assert.equal(client.state.calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit'), true);
});
test('a lost storage ACK retries the same reservation and never overwrites its uploaded bytes', async () => {
  let lost = false;
  const client = fixture({ fetch: async (url, init, { state, reservation, receipt }) => {
    if (url.endsWith('/reserve_story_media')) return Response.json({ ...reservation, uploaded: state.uploaded });
    if (url.includes('/storage/')) { state.uploaded = true; lost = true; throw new Error('lost ACK'); }
    return Response.json(receipt);
  } });
  await assert.rejects(client.upload()); assert.equal(lost, true);
  assert.equal((await client.upload()).sha256, client.receipt.sha256);
  assert.equal(client.state.calls.filter(call => call.url.includes('/storage/')).length, 1);
});
for (const attack of ['owner', 'path', 'hash', 'ack']) test('forged ' + attack + ' cannot become a validated media receipt', async () => {
  const client = fixture({ fetch: async (url, init, { reservation, receipt }) => {
    if (url.endsWith('/reserve_story_media')) return Response.json(attack === 'owner' ? { ...reservation, owner: peer }
      : attack === 'path' ? { ...reservation, object_key: '../other.jpg' } : { ...reservation, uploaded: attack !== 'ack' });
    if (url.includes('/storage/')) return Response.json({ Key: 'foreign/key', Id: randomUUID() });
    return Response.json({ ...receipt, sha256: 'f'.repeat(64) });
  } });
  await assert.rejects(client.upload());
  assert.equal(client.state.calls.some(call => call.url.includes('foreign') || call.url.includes('../')), false);
});
test('hard deadline includes an auth token that ignores abort and cannot send a late request', async () => {
  let release;
  const client = fixture({ setTimeout: callback => setTimeout(callback, 15) });
  client.auth.token = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(client.upload(), { status: 504 });
  release('late-token'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state.calls.length, 0);
});
for (const stage of ['fetch', 'JSON body']) test('hard deadline bounds a stalled ' + stage + ' without a late upload', async () => {
  let expire, release, started, cancelled = false;
  const observed = new Promise(resolve => { started = resolve; });
  const client = fixture({ setTimeout: callback => { expire = callback; return {}; }, fetch: async () => {
    started();
    if (stage === 'fetch') return new Promise(resolve => { release = resolve; });
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }));
  } });
  const pending = client.upload(); await observed;
  if (stage === 'JSON body') await new Promise(resolve => setImmediate(resolve));
  expire(); await assert.rejects(pending, { status: 504 });
  if (release) release(Response.json(client.reservation));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.state.calls.length, 1);
  if (stage === 'JSON body') assert.equal(cancelled, true);
});
test('the Story-only flag does not change cover or other legacy media uploads', async () => {
  const client = fixture();
  const result = await client.cloud.uploadMedia(client.file, 'covers');
  assert.match(result, new RegExp('/storage/v1/object/public/media/covers/' + owner + '/'));
  assert.equal(client.state.calls.length, 1); assert.equal(client.state.calls[0].init.headers['x-upsert'], 'true');
});
test('publication routes the bound receipt through the additive SQL wrapper, with no arbitrary media URL argument', async () => {
  const client = fixture(); let called;
  const stories = createStories({ host: { ...client.host, performance, setTimeout, clearTimeout }, auth: client.auth, cloud: client.cloud });
  stories._mutate = async (action, name, target, body, after, request) => { called = { action, name, target, body, request }; return called; };
  await stories.publish(client.receipt.media_url, 'photo', client.requestId, client.receipt);
  assert.equal(called.name, 'publish_validated_story'); assert.equal(called.request, client.requestId);
  assert.deepEqual(called.body, { p_reservation_id: client.receipt.reservation_id, p_sha256: client.receipt.sha256 });
  await assert.rejects(stories.publish(client.receipt.media_url, 'photo', client.requestId), { status: 400 });
});
test('final receipt requires the canonical public key and stored version, never a private URL or provisional attestation', async () => {
  for (const patch of [{ public_object_id: null }, { public_object_version: null }, { public_key: '../other' },
    { media_url: root + '/storage/v1/object/public/story-media-quarantine-v3/raw.jpg' }, { status: 'attested' }, { schema_version: 1 }]) {
    const client = fixture({ fetch: async (url, _init, { reservation, receipt }) => url.endsWith('/reserve_story_media')
      ? Response.json({ ...reservation, uploaded: true }) : Response.json({ ...receipt, ...patch }) });
    await assert.rejects(client.upload(), { status: 502 });
  }
});
test('flag-on read compatibility unions legacy media with canonical validated media but never quarantine', () => {
  const client = fixture();
  const stories = createStories({ publicBucket: 'story-media-public-v3', host: { ...client.host, performance, setTimeout, clearTimeout }, auth: client.auth, cloud: client.cloud });
  assert.equal(stories._media(`${root}/storage/v1/object/public/media/stories/${owner}/legacy.jpg`, 'photo', owner), true);
  assert.equal(stories._media(client.receipt.media_url, 'photo', owner), true);
  for (const value of [client.receipt.media_url + '?download=1', client.receipt.media_url.replace(client.receipt.sha256, 'not-a-hash'),
    client.receipt.media_url.replace('story-media-public-v3', 'story-media-quarantine-v3'), client.receipt.media_url.replace(owner, peer)]) {
    assert.equal(stories._media(value, 'photo', owner), false);
  }
});
test('policy cancellation and uncertain promotion are explicit and never auto-submit a new request', async () => {
  for (const code of ['policy_changed', 'reservation_expired', 'promotion_review_required']) {
    const client = fixture({ fetch: async (_url, _init, { reservation }) => Response.json({ ...reservation, status: 'cancelled', failure_code: code }) });
    await assert.rejects(client.upload(), { status: 409, code });
    assert.equal(client.state.calls.length, 1); assert.equal(JSON.parse(client.state.calls[0].init.body).p_request_id, client.requestId);
  }
});