'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const qat = require('../scripts/qat-config.cjs');
const filename = path.join(__dirname, '../supabase/functions/registration-signup/index.ts');
const source = fs.readFileSync(filename, 'utf8').replace(/^export /gm, '')
  .replace('if (import.meta.main) Deno.serve(createRegistrationSignupHandler(signupConfiguration()));', '');
const createHandler = vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: filename })
  + '\ncreateRegistrationSignupHandler;', { Request, Response, TextDecoder, Uint8Array, AbortController, URL, atob, setTimeout, clearTimeout });
const owner = '11111111-1111-4111-8111-111111111111';
const proof = 'a'.repeat(64), binding = 'b'.repeat(64), password = 'Synthetic-password-only';
const config = { enabled: true, origin: qat.backendOrigin, anonKey: 'synthetic-public-key' };
const metadata = { name: 'Synthetic signup', registration_consent_proof: proof, registration_consent_binding: binding };
const body = { email: 'signup@example.test', password, data: metadata };
const jwt = (changes = {}) => [
  Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: owner, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    user_metadata: { name: metadata.name }, ...changes })).toString('base64url'),
  Buffer.alloc(32, 1).toString('base64url')
].join('.');
const session = (changes = {}) => ({ access_token: jwt(), refresh_token: 'fresh-refresh', expires_in: 3600,
  user: { id: owner, email: body.email, email_confirmed_at: '2026-09-01T12:00:00Z', user_metadata: { name: metadata.name } }, ...changes });
const request = (changes = {}) => new Request(qat.backendOrigin + '/functions/v1/registration-signup', {
  method: 'POST', headers: { origin: qat.siteOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body), ...changes });

test('QAT signup discards the initial metadata-bearing session and returns only the refreshed safe session', async () => {
  const calls = [];
  const initial = session({ access_token: jwt({ user_metadata: metadata }), refresh_token: 'initial-refresh',
    user: { ...session().user, user_metadata: metadata, identities: [{ identity_data: metadata }] } });
  const handler = createHandler(config, { fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.apikey, config.anonKey);
    return Response.json(calls.length === 1 ? initial : session());
  } });
  const response = await handler(request()), result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), qat.siteOrigin);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.map(call => call.url), [qat.backendOrigin + '/auth/v1/signup', qat.backendOrigin + '/auth/v1/token?grant_type=refresh_token']);
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.deepEqual(JSON.parse(calls[1].options.body), { refresh_token: 'initial-refresh' });
  assert.equal(result.access_token, session().access_token);
  assert.equal(result.refresh_token, 'fresh-refresh');
  assert.equal(result.user.id, owner);
  assert.deepEqual(result.user.user_metadata, { name: metadata.name });
  assert.equal(Object.hasOwn(result.user, 'identities'), false);
  for (const secret of [proof, binding, password, 'initial-refresh']) assert.ok(!JSON.stringify(result).includes(secret));
  const claims = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64url'));
  assert.ok(!JSON.stringify(claims).includes(proof));
});

for (const mode of ['metadata', 'jwt', 'identity', 'expired', 'refresh-error']) {
  test('QAT signup never returns an unsafe refreshed session: ' + mode, async () => {
    let calls = 0;
    const handler = createHandler(config, { fetch: async () => {
      if (++calls === 1) return Response.json(session({ refresh_token: 'initial-refresh' }));
      const value = session();
      if (mode === 'metadata') value.user.user_metadata = metadata;
      if (mode === 'jwt') value.access_token = jwt({ user_metadata: metadata });
      if (mode === 'identity') value.user.id = '22222222-2222-4222-8222-222222222222';
      if (mode === 'expired') value.access_token = jwt({ exp: 1 });
      return Response.json(value, { status: mode === 'refresh-error' ? 500 : 200 });
    } });
    const response = await handler(request());
    assert.equal(response.status, 503);
    const text = await response.text();
    for (const secret of [proof, binding, password, 'initial-refresh', 'fresh-refresh']) assert.ok(!text.includes(secret));
    assert.equal(calls, 2, 'An uncertain signup is not retried automatically');
  });
}

test('QAT signup projects confirmation-required responses without retaining metadata or refreshing', async () => {
  let calls = 0;
  const handler = createHandler(config, { fetch: async () => {
    calls++;
    return Response.json({ id: owner, email: body.email, confirmation_sent_at: '2026-09-09T12:00:00Z', user_metadata: metadata });
  } });
  const response = await handler(request()), result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result, { id: owner, email: body.email, confirmation_sent_at: '2026-09-09T12:00:00Z', user_metadata: { name: metadata.name } });
  assert.equal(calls, 1);
});

test('QAT signup stays default-off and refuses production, foreign origins and malformed input before upstream calls', async () => {
  let calls = 0;
  const options = { fetch: async () => { calls++; throw new Error('Unexpected upstream'); } };
  assert.equal((await createHandler({ ...config, enabled: false }, options)(request())).status, 503);
  assert.equal((await createHandler({ ...config, origin: 'https://ptukgtxpigdkdzsewuvz.supabase.co' }, options)(request())).status, 503);
  assert.equal((await createHandler(config, options)(request({ headers: { origin: 'https://example.test', 'content-type': 'application/json' } }))).status, 403);
  assert.equal((await createHandler(config, options)(request({ body: JSON.stringify({ ...body, redirect_to: 'https://example.test' }) }))).status, 400);
  assert.equal((await createHandler(config, options)(request({ body: JSON.stringify({ ...body, data: { ...metadata, role: 'service_role' } }) }))).status, 400);
  assert.equal((await createHandler(config, options)(request({ body: 'not JSON' }))).status, 400);
  assert.equal((await createHandler(config, options)(request({ body: 'x'.repeat(17000) }))).status, 400);
  assert.equal(calls, 0);
});

test('QAT signup deadline settles a stalled upstream and cannot start a late session refresh', async () => {
  let resolve, calls = 0;
  const delayed = new Promise(accept => { resolve = accept; });
  const handler = createHandler(config, { deadlineMs: 15, fetch: async () => { calls++; return delayed; } });
  const response = await handler(request());
  assert.equal(response.status, 503);
  resolve(Response.json(session()));
  await new Promise(accept => setImmediate(accept));
  assert.equal(calls, 1);
});

test('QAT signup deadline cancels a stalled response body without refreshing or leaking input', async () => {
  let cancelled = false, calls = 0;
  const handler = createHandler(config, { deadlineMs: 15, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  } });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.ok(!(await response.text()).includes(proof));
});