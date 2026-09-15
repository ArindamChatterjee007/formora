'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto, createHash } = require('node:crypto');
const filename = path.join(__dirname, '../supabase/functions/validate-story-media/index.ts');
let source = fs.readFileSync(filename, 'utf8');
source = source.slice(0, source.indexOf('\nif (new URL(import.meta.url).searchParams')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify('file:///fixture/index.ts'));
const handlerFile = path.join(__dirname, '../supabase/functions/parse-story-media/handler.ts');
const handlerSource = fs.readFileSync(handlerFile, 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const { parseInService, technicalLimits, createParserHandler, createStoryMediaHandler, MediaFailure } = vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: filename })
  + '\n' + stripTypeScriptTypes(handlerSource, { mode: 'transform', sourceUrl: handlerFile })
  + '\n({parseInService, technicalLimits, createParserHandler, createStoryMediaHandler, MediaFailure});', { Request, Response, URL, Uint8Array, TextDecoder, AbortController, AbortSignal, btoa,
  crypto: webcrypto, performance, setTimeout, clearTimeout, fetch: () => { throw new Error('Unstubbed network'); } });
const config = { origin: 'https://fixture.supabase.co', anonKey: 'public-fixture', parserKey: 'p'.repeat(43) };
const bytes = new Uint8Array([1, 2, 3, 4]);
const declaration = { kind: 'photo', content_type: 'image/jpeg', declared_bytes: bytes.length };
const hash = createHash('sha256').update(bytes).digest('hex');
const result = options => ({ request_id: options.headers['x-story-parser-request'], actual_bytes: bytes.length, content_type: 'image/jpeg',
  width: 16, height: 16, duration_ms: null, duration_verified: false, parser: 'file-type@22.0.2+mediainfo.js@0.3.7', library: '25.10', sha256: hash });
const run = (network, signal, milliseconds = 1000) => parseInService(bytes, declaration, technicalLimits, config, signal, milliseconds, network);

test('Service parsing binds the unchanged upload bytes, request and digest to a fixed authenticated endpoint', async () => {
  let calls = 0;
  const value = await run(async (url, options) => {
    calls++;
    assert.equal(url, config.origin + '/functions/v1/parse-story-media');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-story-parser-key'], config.parserKey);
    assert.equal(options.headers.Authorization, 'Bearer ' + config.anonKey);
    assert.ok(Number(options.headers['x-story-parser-timeout-ms']) > 0 && Number(options.headers['x-story-parser-timeout-ms']) <= 1000);
    assert.equal(Object.hasOwn(options.headers, 'x-story-parser-deadline'), false);
    assert.equal(options.body, bytes);
    return Response.json(result(options));
  });
  assert.equal(calls, 1);
  assert.equal(value.sha256, hash);
  assert.equal(value.bytes, bytes);
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.equal(Object.hasOwn(value, 'request_id'), false);
});

test('Foreign, malformed, extra-field and stale parser acknowledgements cannot authorize bytes', async () => {
  for (const change of [{ request_id: 'foreign' }, { sha256: 'f'.repeat(64) }, { actual_bytes: 3 }, { content_type: 'video/mp4' },
    { width: 8193 }, { width: 8192, height: 8192 }, { duration_ms: 1 }, { duration_verified: true }, { internal: 'not allowed' }, { library: null }]) {
    await assert.rejects(run(async (_url, options) => Response.json({ ...result(options), ...change })), /storage_unavailable/);
  }
});

test('Parser infrastructure errors remain retryable without blind network retries', async () => {
  for (const status of [401, 403, 404, 429, 500, 503, 546]) {
    let calls = 0;
    await assert.rejects(run(async () => { calls++; return Response.json({ error: 'unavailable' }, { status }); }), /storage_unavailable/);
    assert.equal(calls, 1);
  }
  await assert.rejects(run(async () => Response.json({ error: 'invalid_media' }, { status: 422 })), /invalid_media/);
  await assert.rejects(run(async () => new Response('x'.repeat(2049))), /storage_unavailable/);
});

test('The caller deadline covers stalled response bodies and discards late parser success', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const work = run(async (_url, options) => {
    started();
    return new Promise(resolve => { release = () => resolve(Response.json(result(options))); });
  }, undefined, 40);
  const rejected = assert.rejects(work, /validation_timeout/);
  await began;
  await rejected;
  release();
  let cancelled = false;
  await assert.rejects(run(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), undefined, 40), /validation_timeout/);
  assert.equal(cancelled, true);
});

test('Pre-aborted or invalid parser configuration performs no network work', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const network = async () => { calls++; throw new Error('Must not send'); };
  await assert.rejects(run(network, controller.signal), /validation_timeout/);
  for (const change of [{ origin: 'https://fixture.supabase.co.evil.test' }, { parserKey: 'short' }, { anonKey: '' }]) {
    await assert.rejects(parseInService(bytes, declaration, technicalLimits, { ...config, ...change }, undefined, 100, network), /invalid_configuration/);
  }
  assert.equal(calls, 0);
});

test('Parser service stays disabled or unauthorized before reading media', async () => {
  let calls = 0;
  const options = { inspect: async () => { calls++; throw new Error('Must not parse'); } };
  const request = (headers = {}) => new Request(config.origin, { method: 'POST', body: bytes, headers });
  assert.equal((await createParserHandler({ key: config.parserKey, enabled: false }, options)(request({ 'x-story-parser-key': config.parserKey }))).status, 503);
  assert.equal((await createParserHandler({ key: config.parserKey, enabled: false, initializationError: 'runtime_unsupported' }, options)(request())).status, 403);
  assert.equal((await createParserHandler({ key: '', enabled: true }, options)(request())).status, 503);
  assert.equal((await createParserHandler({ key: config.parserKey, enabled: true }, options)(request())).status, 403);
  assert.equal(calls, 0);
});

test('Initialization failure diagnostics contain only fixed non-secret reasons', async () => {
  const denied = reason => createParserHandler({ enabled: false, key: config.parserKey, initializationError: reason }, { inspect: async () => { throw new Error(); } })(new Request(config.origin, { headers: { 'x-story-parser-key': config.parserKey } }));
  assert.deepEqual(await (await denied('filesystem_not_found')).json(), { error: 'parser_disabled', reason: 'filesystem_not_found' });
  assert.deepEqual(await (await denied('/tmp/private-path-secret')).json(), { error: 'parser_disabled' });
});

test('Authenticated service client and handler agree on declaration, limits and exact result', async () => {
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { inspect: async (input, declared, limits) => {
    assert.deepEqual([...input], [...bytes]);
    assert.equal(declared.content_type, declaration.content_type);
    assert.equal(limits.max_pixels, technicalLimits.max_pixels);
    const { request_id, ...inspection } = result({ headers: {} });
    return inspection;
  } });
  const parsed = await run((url, options) => handler(new Request(url, options)));
  assert.equal(parsed.width, 16); assert.equal(parsed.sha256, hash);
});

test('Parser service rejects excessive duration, oversized and broadened limits without inspection', async () => {
  let calls = 0;
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { inspect: async () => { calls++; throw new Error('Must not parse'); } });
  const headers = { 'x-story-parser-key': config.parserKey, 'x-story-parser-request': webcrypto.randomUUID(),
    'x-story-parser-timeout-ms': '1000', 'x-story-parser-limits': JSON.stringify(technicalLimits),
    'content-type': 'image/jpeg', 'content-length': '4' };
  for (const [change, status] of [[{ 'x-story-parser-timeout-ms': '10001' }, 400],
    [{ 'content-length': '8388609' }, 413], [{ 'x-story-parser-limits': JSON.stringify({ ...technicalLimits, max_pixels: 16777217 }) }, 400],
    [{ origin: 'https://browser.example' }, 403]]) {
    assert.equal((await handler(new Request(config.origin, { method: 'POST', headers: { ...headers, ...change }, body: bytes }))).status, status);
  }
  assert.equal(calls, 0);
});

test('Parser service validates method, request identity, encoding and exact body length before inspection', async () => {
  let calls = 0;
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { inspect: async () => { calls++; throw new Error('Must not inspect'); } });
  const headers = { 'x-story-parser-key': config.parserKey, 'x-story-parser-request': webcrypto.randomUUID(),
    'x-story-parser-timeout-ms': '1000', 'x-story-parser-limits': JSON.stringify(technicalLimits),
    'content-type': 'image/jpeg', 'content-length': '4' };
  for (const [method, change, expected, code] of [['GET', {}, 405, 'post_required'],
    ['POST', { 'x-story-parser-request': 'foreign' }, 400, 'invalid_parser_request'],
    ['POST', { 'content-encoding': 'gzip' }, 413, 'invalid_parser_body'],
    ['POST', { 'content-length': '3' }, 422, 'size_mismatch'],
    ['POST', { 'content-length': '5' }, 422, 'size_mismatch']]) {
    const response = await handler(new Request(config.origin, { method, headers: { ...headers, ...change }, ...(method === 'POST' ? { body: bytes } : {}) }));
    assert.equal(response.status, expected); assert.deepEqual(await response.json(), { error: code });
  }
  assert.equal(calls, 0);
});

test('A parser response without its reviewed library version fails closed', async () => {
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { inspect: async () => {
    const { request_id, library, ...inspection } = result({ headers: {} });
    return inspection;
  } });
  await assert.rejects(run((url, options) => handler(new Request(url, options))), /storage_unavailable/);
});

test('Parser service never emits a success completed after its supplied deadline', async () => {
  let now = Date.now();
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { now: () => now,
    inspect: async () => { now += 20000; return {}; } });
  await assert.rejects(run((url, options) => handler(new Request(url, options))), /validation_timeout/);
  const invalid = createParserHandler({ key: config.parserKey, enabled: true }, { inspect: async () => { throw new MediaFailure('invalid_media'); } });
  await assert.rejects(run((url, options) => invalid(new Request(url, options))), /invalid_media/);
});

test('Exclusive parser access stays busy after abort until inspection has actually settled', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const handler = createParserHandler({ enabled: true, key: config.parserKey }, {
    inspect: async () => { entered(); await new Promise(resolve => { release = resolve; }); throw new Error('Synthetic late failure'); }
  });
  const controller = new AbortController();
  const first = run((url, options) => handler(new Request(url, options)), controller.signal);
  const firstRejected = assert.rejects(first, /validation_timeout/);
  await started; controller.abort(); await firstRejected;
  const makeRequest = () => new Request(config.origin, { method: 'POST', headers: {
    'x-story-parser-key': config.parserKey, 'x-story-parser-request': webcrypto.randomUUID(),
    'x-story-parser-timeout-ms': '1000', 'x-story-parser-limits': JSON.stringify(technicalLimits),
    'content-type': 'image/jpeg', 'content-length': '4' }, body: bytes });
  assert.equal((await handler(makeRequest())).status, 429);
  release(); await new Promise(resolve => setImmediate(resolve));
  const next = handler(makeRequest());
  await new Promise(resolve => setImmediate(resolve));
  release(); assert.equal((await next).status, 503);
});

test('Parser durations do not depend on a synchronized caller wall clock', async () => {
  const handler = createParserHandler({ key: config.parserKey, enabled: true }, { now: () => 5,
    inspect: async () => { const { request_id, ...inspection } = result({ headers: {} }); return inspection; } });
  assert.equal((await run((url, options) => handler(new Request(url, options)))).sha256, hash);
});

test('A project-wide parser credential cannot activate the validator or consume reservations', async () => {
  let calls = 0;
  for (const change of [{}, { parserEnabled: false }, { parserEnabled: true, parserKey: '' }]) {
    const handler = createStoryMediaHandler({ ...config, enabled: true, serviceKey: 'server-fixture', ...change }, {
      fetch: async () => { calls++; throw new Error('No auth, claim or Storage request is allowed'); }
    });
    const response = await handler(new Request(config.origin, { method: 'POST', headers: {
      authorization: 'Bearer member-fixture', 'content-type': 'application/json'
    }, body: JSON.stringify({ request_id: webcrypto.randomUUID() }) }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, change.parserEnabled ? 'invalid_configuration' : 'parser_unavailable');
  }
  assert.equal(calls, 0);
});

test('Explicit validator service routing preserves authenticated bytes through attestation and publication', async () => {
  const owner = webcrypto.randomUUID(), requestId = webcrypto.randomUUID(), reservationId = webcrypto.randomUUID();
  const publicKeyId = webcrypto.randomUUID(), publicObjectId = webcrypto.randomUUID();
  const reservation = { ...declaration, schema_version: 2, owner, request_id: requestId, reservation_id: reservationId,
    bucket: 'story-media-quarantine-v3', object_key: `stories/${owner}/${reservationId}.jpg`, public_bucket: 'story-media-public-v3',
    public_key_id: publicKeyId, policy_epoch: 1, expires_at: new Date(Date.now() + 60000).toISOString(), uploaded: true,
    status: 'validating', media_url: null, public_key: null, public_object_id: null, public_object_version: null,
    lease_token: webcrypto.randomUUID(), object_id: webcrypto.randomUUID(), epoch: 1, limits: technicalLimits };
  const publicKey = `stories/${owner}/${publicKeyId}_${hash}.jpg`;
  const { request_id, ...inspection } = result({ headers: {} });
  const attested = { ...reservation, ...inspection, status: 'attested', public_key: publicKey,
    media_url: config.origin + '/storage/v1/object/public/story-media-public-v3/' + publicKey };
  let promotionCalls = 0, parserCalls = 0;
  const operations = [];
  const handler = createStoryMediaHandler({ ...config, enabled: true, serviceKey: 'server-fixture', parserEnabled: true }, {
    fetch: async (url, options) => {
      const route = new URL(url).pathname; operations.push(route);
      if (route === '/auth/v1/user') return Response.json({ id: owner });
      if (route === '/rest/v1/rpc/claim_story_media_validation') return Response.json(reservation);
      if (route.startsWith('/storage/v1/object/authenticated/')) return new Response(bytes, { headers: {
        'content-type': declaration.content_type, 'content-length': String(bytes.length)
      } });
      if (route === '/functions/v1/parse-story-media') {
        parserCalls++;
        assert.equal(options.headers['x-story-parser-key'], config.parserKey);
        assert.equal(options.headers.Authorization, 'Bearer ' + config.anonKey);
        assert.deepEqual([...options.body], [...bytes]);
        return Response.json(result(options));
      }
      if (route === '/rest/v1/rpc/attest_story_media') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.p_sha256, hash); assert.equal(payload.p_failure_code, null);
        return Response.json(attested);
      }
      if (route === '/rest/v1/rpc/claim_story_media_promotion') {
        promotionCalls++;
        return Response.json({ ...attested, status: 'promoting', write_allowed: promotionCalls === 1,
          promotion_token: reservation.lease_token, public_object_id: promotionCalls === 1 ? null : publicObjectId,
          public_object_version: promotionCalls === 1 ? null : 'fixture-version' });
      }
      if (route === '/storage/v1/object/story-media-public-v3/' + publicKey) {
        assert.equal(options.headers['x-upsert'], 'false'); assert.deepEqual([...options.body], [...bytes]);
        return Response.json({ Id: publicObjectId, Key: 'story-media-public-v3/' + publicKey });
      }
      if (route === '/rest/v1/rpc/finalize_story_media') return Response.json({ ...attested, status: 'approved',
        public_object_id: publicObjectId, public_object_version: 'fixture-version' });
      throw new Error('Unexpected request: ' + route);
    }
  });
  const response = await handler(new Request(config.origin, { method: 'POST', headers: {
    authorization: 'Bearer member-fixture', 'content-type': 'application/json'
  }, body: JSON.stringify({ request_id: requestId }) }));
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ receipt, operations })); assert.equal(receipt.sha256, hash);
  assert.equal(parserCalls, 1); assert.equal(promotionCalls, 2);
  assert.ok(operations.indexOf('/functions/v1/parse-story-media') < operations.indexOf('/rest/v1/rpc/attest_story_media'));
});