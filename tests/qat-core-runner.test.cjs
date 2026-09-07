'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCore } = require('../scripts/verify-qat-core.cjs');
const qat = require('../scripts/qat-config.cjs');
const key = (role, ref = qat.projectRef) => [
  Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role, ref, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  Buffer.alloc(32, 1).toString('base64url')
].join('.');

test('The hosted runner rejects wrong-project and wrong-role keys before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected request'); };
  for (const credentials of [
    { anonKey: key('anon', 'ptukgtxpigdkdzsewuvz'), serviceKey: key('service_role') },
    { anonKey: key('anon'), serviceKey: key('service_role', 'ptukgtxpigdkdzsewuvz') },
    { anonKey: key('service_role'), serviceKey: key('service_role') },
    { anonKey: key('anon'), serviceKey: key('anon') }
  ]) await assert.rejects(verifyCore({ ...credentials, fetchImpl }));
  assert.equal(calls, 0);
});

test('An early hosted failure is recorded without outputting credentials or retrying creation', async () => {
  const anonKey = key('anon'), serviceKey = key('service_role');
  let calls = 0;
  const record = await verifyCore({ anonKey, serviceKey, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, qat.backendOrigin + '/auth/v1/admin/users');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.email_confirm, true);
    assert.match(body.email, /@example\.test$/);
    assert.ok(body.password.length >= 40);
    return Response.json({ code: 'fixture_unavailable' }, { status: 503 });
  } });
  assert.equal(record.result, 'failed');
  assert.equal(calls, 1);
  assert.equal(record.syntheticUsersCreated, 0);
  assert.equal(record.checks[0].result, 'failed');
  assert.deepEqual(record.cleanup, []);
  assert.ok(!JSON.stringify(record).includes(anonKey));
  assert.ok(!JSON.stringify(record).includes(serviceKey));
  assert.equal(record.productionChanged, false);
});

test('An expired test deadline retains separate time to clean its acknowledged synthetic user', async context => {
  const deadline = new AbortController(), originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const fixtureId = '11111111-1111-4111-8111-111111111111';
  context.mock.method(AbortSignal, 'timeout', duration => duration === 240000 ? deadline.signal : originalTimeout(duration));
  const calls = [];
  const record = await verifyCore({ anonKey: key('anon'), serviceKey: key('service_role'), fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.endsWith('/admin/users') && options.method === 'POST') {
      const email = JSON.parse(options.body).email;
      deadline.abort();
      return Response.json({ id: fixtureId, email }, { status: 201 });
    }
    if (url.includes('/token?')) {
      assert.equal(options.signal.aborted, true);
      throw new Error('Synthetic test deadline');
    }
    assert.equal(url, qat.backendOrigin + '/auth/v1/admin/users/' + fixtureId);
    assert.equal(options.signal.aborted, false, 'Cleanup must not reuse the expired test deadline');
    return options.method === 'DELETE' ? Response.json({ id: fixtureId }) : Response.json({ code: 'user_not_found' }, { status: 404 });
  } });
  assert.equal(record.result, 'failed');
  assert.equal(calls.length, 4);
  assert.equal(record.syntheticUsersCreated, 1);
  assert.deepEqual(record.cleanup, [{ resource: 'synthetic_auth_user', fixtureId, result: 'passed' }]);
});