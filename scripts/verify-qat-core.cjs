'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const qat = require('./qat-config.cjs');

async function verifyCore({ anonKey, serviceKey, fetchImpl = globalThis.fetch }) {
  qat.validateKey(anonKey, 'anon');
  qat.validateKey(serviceKey, 'service_role');
  const record = { startedAt: new Date().toISOString(), projectRef: qat.projectRef,
    scope: 'Real QAT Auth, core PostgREST isolation and connection actions with temporary synthetic users only',
    result: 'incomplete', checks: [], requests: [], cleanup: [], productionChanged: false,
    acceptance: 'pending', excluded: ['Storage and media', 'Stories v2', 'Provider payments', 'Analytics', 'Push', 'Physical devices'] };
  const users = [], assets = [], runId = randomUUID();
  const totalDeadline = AbortSignal.timeout(240000);
  let cleanupDeadline = null;

  async function request(route, { method = 'GET', token = anonKey, key = anonKey, body, prefer = 'return=representation' } = {}) {
    const url = new URL(route, qat.backendOrigin);
    assert.equal(url.origin, qat.backendOrigin, 'Only the isolated QAT origin is allowed');
    assert.match(url.pathname, /^\/(auth\/v1\/(token|admin\/users(?:\/[a-f0-9-]{36})?)|rest\/v1\/(accounts|profiles|posts|messages|requests|entitlements|support_tickets|rpc\/get_state))$/);
    assert.ok(record.requests.length < (cleanupDeadline ? 80 : 50), 'QAT verification request limit exceeded');
    const call = { method, path: url.pathname, status: null };
    record.requests.push(call);
    const response = await fetchImpl(url.href, { method, redirect: 'error',
      signal: AbortSignal.any([cleanupDeadline || totalDeadline, AbortSignal.timeout(15000)]),
      headers: { apikey: key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: prefer },
      body: body === undefined ? undefined : JSON.stringify(body) });
    call.status = response.status;
    const text = await response.text();
    if (Buffer.byteLength(text) > 262144) throw new Error('QAT response exceeds the verification limit');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { throw new Error('QAT response is not JSON'); }
    }
    if (typeof data?.code === 'string' && /^[A-Za-z0-9_]{1,50}$/.test(data.code)) call.code = data.code;
    return { status: response.status, data };
  }

  const admin = (route, options = {}) => request(route, { ...options, token: serviceKey, key: serviceKey });
  const member = (user, route, options = {}) => request('/rest/v1/' + route, { ...options, token: user.token });
  async function check(name, run) {
    const item = { name, result: 'incomplete' };
    record.checks.push(item);
    try { await run(); item.result = 'passed'; }
    catch (error) { item.result = 'failed'; throw new Error(name + ': ' + error.message); }
  }
  function owned(reply, key, value) {
    assert.ok([200, 201].includes(reply.status), 'Expected an acknowledged owned write');
    assert.ok(Array.isArray(reply.data) && reply.data.length === 1, 'Expected exactly one persisted row');
    assert.equal(reply.data[0][key], value, 'Acknowledged row identity differs');
    return reply.data[0];
  }
  function deniedWrite(reply) {
    assert.ok(reply.status === 403 || reply.status === 200 && Array.isArray(reply.data) && reply.data.length === 0,
      'An unrelated caller must not receive an acknowledged write');
  }

  try {
    await check('Confirmed synthetic users authenticate through real password grants', async () => {
      for (const label of ['owner', 'peer', 'stranger']) {
        const email = 'qat-' + runId + '-' + label + '@example.test', password = randomBytes(32).toString('base64url');
        const created = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
        assert.ok([200, 201].includes(created.status), 'Synthetic account creation was not acknowledged');
        assert.match(created.data?.id || '', /^[a-f0-9-]{36}$/);
        assert.equal(created.data.email, email);
        const user = { id: created.data.id, token: null };
        users.push(user);
        const login = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
        assert.equal(login.status, 200);
        assert.equal(login.data?.user?.id, user.id);
        assert.ok(typeof login.data.access_token === 'string' && login.data.access_token.length > 20);
        user.token = login.data.access_token;
      }
      assert.equal(new Set(users.map(user => user.id)).size, 3);
    });
    const [owner, peer, stranger] = users;
    await check('Anonymous users cannot read accounts or private messages', async () => {
      for (const table of ['accounts', 'messages']) {
        assert.ok([401, 403].includes((await request('/rest/v1/' + table + '?select=*&limit=1')).status));
      }
      assert.ok([401, 403].includes((await request('/rest/v1/rpc/get_state', { method: 'POST', body: {} })).status));
    });
    await check('A profile and account persist with the actual client column contract', async () => {
      assets.push({ table: 'profiles', key: 'uid', value: owner.id });
      owned(await member(owner, 'profiles', { method: 'POST', body: { uid: owner.id, data: { name: 'Synthetic QAT owner' }, updated_at: new Date().toISOString() } }), 'uid', owner.id);
      assets.push({ table: 'accounts', key: 'uid', value: owner.id });
      owned(await member(owner, 'accounts', { method: 'POST', body: { uid: owner.id, data: { marker: runId } } }), 'uid', owner.id);
      const mine = await member(owner, 'accounts?uid=eq.' + owner.id + '&select=uid,data');
      assert.equal(mine.status, 200);
      assert.equal(mine.data?.[0]?.data?.marker, runId);
    });
    await check('Another member cannot read or overwrite the owner account', async () => {
      const hidden = await member(peer, 'accounts?uid=eq.' + owner.id + '&select=uid,data');
      assert.equal(hidden.status, 200);
      assert.deepEqual(hidden.data, []);
      const write = await member(peer, 'accounts?uid=eq.' + owner.id, { method: 'PATCH', body: { data: { marker: 'forged' } } });
      deniedWrite(write);
      assert.equal((await member(owner, 'accounts?uid=eq.' + owner.id + '&select=data')).data?.[0]?.data?.marker, runId);
    });
    await check('Post ownership and the public feed contract reject actor spoofing', async () => {
      const postId = randomUUID(), spoofedId = randomUUID();
      assets.push({ table: 'posts', key: 'id', value: postId }, { table: 'posts', key: 'id', value: spoofedId });
      owned(await member(owner, 'posts', { method: 'POST', body: { id: postId, author: owner.id, data: { text: 'Synthetic QAT post' } } }), 'id', postId);
      assert.equal((await member(owner, 'posts', { method: 'POST', body: { id: spoofedId, author: peer.id, data: {} } })).status, 403);
      const feed = await member(owner, 'rpc/get_state', { method: 'POST', body: {} });
      assert.equal(feed.status, 200);
      assert.deepEqual(Object.keys(feed.data).sort(), ['comments', 'posts', 'requests', 'stories', 'users']);
      assert.equal(feed.data.posts[postId]?.author, owner.id);
      assert.ok(Number.isFinite(feed.data.posts[postId]?.ts));
    });
    await check('Messages are readable only by sender and recipient', async () => {
      const id = randomUUID();
      assets.push({ table: 'messages', key: 'id', value: id });
      owned(await member(owner, 'messages', { method: 'POST', body: { id, from_uid: owner.id, to_uid: peer.id, body: 'Synthetic QAT private message' } }), 'id', id);
      const received = await member(peer, 'messages?id=eq.' + id + '&select=id,body');
      assert.equal(received.status, 200);
      assert.equal(received.data?.[0]?.id, id);
      const hidden = await member(stranger, 'messages?id=eq.' + id + '&select=id,body');
      assert.equal(hidden.status, 200);
      assert.deepEqual(hidden.data, []);
    });
    const outgoingId = owner.id + '__' + peer.id, incomingId = peer.id + '__' + owner.id;
    const cancelledId = owner.id + '__' + stranger.id, spoofedRequestId = stranger.id + '__' + peer.id;
    const pendingRequest = { id: outgoingId, from_uid: owner.id, to_uid: peer.id, status: 'pending' };
    const createRequest = (user, body) => member(user, 'requests?on_conflict=id',
      { method: 'POST', body, prefer: 'resolution=ignore-duplicates,return=representation' });
    await check('Connection creation and retry enforce pending status and participant-bound identity', async () => {
      for (const value of [outgoingId, incomingId, cancelledId, spoofedRequestId]) assets.push({ table: 'requests', key: 'id', value });
      assert.ok([401, 403].includes((await request('/rest/v1/requests?select=id&limit=1')).status));
      assert.equal(owned(await createRequest(owner, pendingRequest), 'id', outgoingId).status, 'pending');
      const visible = await member(owner, 'rpc/get_state', { method: 'POST', body: {} });
      assert.equal(visible.status, 200);
      const requestRow = visible.data?.requests?.[outgoingId];
      assert.equal(requestRow?.id, outgoingId);
      assert.equal(requestRow.from, owner.id);
      assert.equal(requestRow.to, peer.id);
      assert.equal(requestRow.status, 'pending');
      const repeated = await createRequest(owner, pendingRequest);
      assert.ok([200, 201].includes(repeated.status));
      assert.deepEqual(repeated.data, []);
      assert.equal((await createRequest(owner, { ...pendingRequest, id: spoofedRequestId })).status, 403);
      assert.equal((await createRequest(owner, { id: cancelledId, from_uid: owner.id, to_uid: stranger.id, status: 'accepted' })).status, 403);
    });
    await check('Only the recipient can accept and request identities stay immutable', async () => {
      const route = 'requests?id=eq.' + outgoingId;
      const hidden = await member(stranger, route + '&select=id');
      assert.equal(hidden.status, 200);
      assert.deepEqual(hidden.data, []);
      const feed = await member(stranger, 'rpc/get_state', { method: 'POST', body: {} });
      assert.equal(feed.status, 200);
      assert.ok(feed.data && feed.data.requests && !Object.hasOwn(feed.data.requests, outgoingId));
      deniedWrite(await member(owner, route, { method: 'PATCH', body: { status: 'accepted' } }));
      deniedWrite(await member(stranger, route, { method: 'PATCH', body: { status: 'accepted' } }));
      assert.equal((await member(peer, route, { method: 'PATCH', body: { from_uid: stranger.id } })).status, 403);
      assert.equal(owned(await member(peer, route, { method: 'PATCH', body: { status: 'accepted' } }), 'id', outgoingId).status, 'accepted');
      const retried = await createRequest(owner, pendingRequest);
      assert.ok([200, 201].includes(retried.status));
      assert.deepEqual(retried.data, []);
      const saved = await member(owner, route + '&select=id,from_uid,to_uid,status');
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data, [{ ...pendingRequest, status: 'accepted' }]);
    });
    await check('Only participants can remove, decline or cancel connection requests', async () => {
      deniedWrite(await member(stranger, 'requests?id=eq.' + outgoingId, { method: 'DELETE' }));
      owned(await member(owner, 'requests?id=eq.' + outgoingId, { method: 'DELETE' }), 'id', outgoingId);
      owned(await createRequest(peer, { id: incomingId, from_uid: peer.id, to_uid: owner.id, status: 'pending' }), 'id', incomingId);
      owned(await member(owner, 'requests?id=eq.' + incomingId, { method: 'DELETE' }), 'id', incomingId);
      owned(await createRequest(owner, { id: cancelledId, from_uid: owner.id, to_uid: stranger.id, status: 'pending' }), 'id', cancelledId);
      owned(await member(owner, 'requests?id=eq.' + cancelledId, { method: 'DELETE' }), 'id', cancelledId);
      const remaining = await member(owner, 'requests?id=in.(' + [outgoingId, incomingId, cancelledId].join(',') + ')&select=id');
      assert.equal(remaining.status, 200);
      assert.deepEqual(remaining.data, []);
    });
    await check('An empty entitlement read works but paid self-grants are denied', async () => {
      const empty = await member(owner, 'entitlements?uid=eq.' + owner.id + '&select=uid,tier');
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.data, []);
      assets.push({ table: 'entitlements', key: 'uid', value: owner.id });
      assert.equal((await member(owner, 'entitlements', { method: 'POST', body: { uid: owner.id, tier: 'elite', status: 'active' } })).status, 403);
    });
    record.result = 'passed';
  } catch (error) {
    record.result = 'failed';
    record.error = error.message.slice(0, 600);
  } finally {
    cleanupDeadline = AbortSignal.timeout(90000);
    for (const item of [...assets].reverse()) {
      try {
        const route = '/rest/v1/' + item.table + '?' + item.key + '=eq.' + item.value;
        const removed = await admin(route, { method: 'DELETE' });
        assert.ok([200, 204].includes(removed.status));
        const remaining = await admin(route + '&select=' + item.key);
        assert.equal(remaining.status, 200);
        assert.deepEqual(remaining.data, []);
        record.cleanup.push({ resource: item.table, fixtureId: item.value, result: 'passed' });
      } catch { record.cleanup.push({ resource: item.table, fixtureId: item.value, result: 'failed' }); record.result = 'failed'; }
    }
    for (const user of users) {
      try {
        const removed = await admin('/auth/v1/admin/users/' + user.id, { method: 'DELETE' });
        assert.ok([200, 204].includes(removed.status));
        assert.equal((await admin('/auth/v1/admin/users/' + user.id)).status, 404);
        record.cleanup.push({ resource: 'synthetic_auth_user', fixtureId: user.id, result: 'passed' });
      } catch { record.cleanup.push({ resource: 'synthetic_auth_user', fixtureId: user.id, result: 'failed' }); record.result = 'failed'; }
      user.token = null;
    }
    record.syntheticUsersCreated = users.length;
    record.completedAt = new Date().toISOString();
  }
  return record;
}

module.exports = { verifyCore };

if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  (async () => {
    if (process.argv[2] !== '--hosted') throw new Error('Use --hosted for the explicitly isolated QAT verification.');
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-qat-core-'));
    const filename = path.join(output, 'verification.json');
    fs.writeFileSync(filename, JSON.stringify({ result: 'incomplete', projectRef: qat.projectRef }) + '\n');
    const record = await verifyCore({ anonKey: process.env.FORMORA_QAT_ANON_KEY, serviceKey: process.env.FORMORA_QAT_SERVICE_KEY });
    fs.writeFileSync(filename, JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({ result: record.result, projectRef: record.projectRef, checks: record.checks,
      cleanup: record.cleanup, requests: record.requests.length, evidence: filename, error: record.error, productionChanged: false }, null, 2));
    if (record.result !== 'passed') process.exitCode = 1;
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}