'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createHash, createHmac, timingSafeEqual, randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { database, identity, rpc, owner, peer, policy } = require('./story-media-sql.test.cjs');
const { root, createFixtures, startRuntimeBridge } = require('../scripts/verify-story-media-runtime.cjs');
const apiOrigin = 'https://fixture.supabase.co';
const signatureKey = Buffer.from('isolated-story-media-auth-fixture-only');
const sourceFiles = ['js/cloud.js', 'js/mod/social.js', 'js/mod/stories.js', 'js/config.js', 'js/app.js', 'css/styles.css',
  'supabase/story-interactions.sql', 'supabase/story-media.sql', 'supabase/functions/validate-story-media/index.ts',
  'supabase/functions/validate-story-media/deno.json', 'supabase/functions/validate-story-media/deno.lock',
  'scripts/verify-story-media-runtime.cjs', 'scripts/verify-story-media-runtime.ts', 'tests/story-media-pipeline.test.cjs', 'tests/story-media-sql.test.cjs'];
const fingerprint = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const report = { result: 'running', startedAt: new Date().toISOString(), cases: [], productionChanged: false, realMediaDeleted: false,
  hostedProof: false, scope: 'Real browser Cloud/Social/Stories and existing resize helper; synthetic signed GoTrue fixture; actual SQL and network-denied Deno handler/WASM via stdio.',
  executionGraph: [ ['Social.shareStory', 'Cloud.uploadMedia'], ['Cloud.uploadMedia', 'reserve_story_media'],
    ['reserve_story_media', 'private quarantine INSERT RLS + trigger'], ['private quarantine INSERT RLS + trigger', 'Deno handler -> synthetic GoTrue'],
    ['Deno handler -> synthetic GoTrue', 'claim_story_media_validation'], ['claim_story_media_validation', 'actual immutable fixture bytes -> WASM worker'],
    ['actual immutable fixture bytes -> WASM worker', 'attest_story_media'], ['attest_story_media', 'claim_story_media_promotion'],
    ['claim_story_media_promotion', 'exact validated buffer -> service public INSERT gate'], ['exact validated buffer -> service public INSERT gate', 'stored public ID/version -> finalize_story_media'],
    ['stored public ID/version -> finalize_story_media', 'Cloud SHA-256 comparison'],
    ['Cloud SHA-256 comparison', 'Stories.publish -> publish_validated_story'], ['Stories.publish -> publish_validated_story', 'unchanged publish_story -> story_content trigger'] ] };
let server, browser, origin, fixtureDirectory;
function signedToken(actor) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: actor, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const input = header + '.' + payload;
  return input + '.' + createHmac('sha256', signatureKey).update(input).digest('base64url');
}
function verifiedOwner(authorization) {
  try {
    const token = authorization.slice('Bearer '.length), [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', signatureKey).update(header + '.' + payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (!authorization.startsWith('Bearer ') || received.length !== expected.length || !timingSafeEqual(expected, received)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    return claims.exp > Date.now() / 1000 && claims.role === 'authenticated' && [owner, peer].includes(claims.sub) ? claims.sub : null;
  } catch { return null; }
}
const specifications = {
  reserve_story_media: ['p_request_id', 'p_kind', 'p_content_type', 'p_declared_bytes'],
  cancel_story_media: ['p_request_id'], publish_validated_story: ['p_request_id', 'p_reservation_id', 'p_sha256'],
  publish_story: ['p_request_id', 'p_media_url', 'p_kind', 'p_audience'], get_story: ['p_id'], story_action_receipt: ['p_request_id'],
  story_feed: ['p_cursor'],
  claim_story_media_validation: ['p_owner', 'p_request_id'],
  attest_story_media: ['p_owner', 'p_request_id', 'p_epoch', 'p_lease_token', 'p_sha256', 'p_actual_bytes', 'p_content_type', 'p_width', 'p_height', 'p_duration_ms', 'p_failure_code'],
  claim_story_media_promotion: ['p_owner', 'p_request_id', 'p_epoch', 'p_lease_token'],
  finalize_story_media: ['p_owner', 'p_request_id', 'p_epoch', 'p_lease_token', 'p_sha256', 'p_public_object_id', 'p_public_object_version'],
};
const statusFor = error => /^PT\d{3}$/.test(error.code) ? Number(error.code.slice(2)) : error.code === '42501' ? 403 : error.code === '23505' ? 409 : 400;
function deferred() { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; }
if (process.env.STORY_MEDIA_RUNTIME !== '1') test('contract only: Story media browser pipeline is NOT executed without STORY_MEDIA_RUNTIME=1', context => {
  assert.match(fs.readFileSync(path.join(root, 'js/config.js'), 'utf8'), /window\.STORY_MEDIA_VALIDATION = false;/);
  assert.match(fs.readFileSync(path.join(root, 'js/mod/stories.js'), 'utf8'), /publish_validated_story: \["p_request_id", "p_reservation_id", "p_sha256"\]/);
  context.diagnostic(JSON.stringify({ actualBrowserPipelineExecuted: false, actualBrowserScenarios: 0,
    requires: 'STORY_MEDIA_RUNTIME=1, Deno with frozen cached dependencies, FFmpeg and installed Playwright Chromium; no quiet prerequisite skip.' }));
});
else {
before(async () => {
  report.fingerprints = fingerprint();
  fixtureDirectory = await createFixtures();
  const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const helpers = appSource.split('\nconst App = {')[0];
  const icons = vm.runInNewContext(appSource + '\n;({symbols:App._ICONS,renderer:App.ic.toString()});',
    { document: { addEventListener() {} } }, { timeout: 1000 });
  assert.match(helpers, /function resizeImage\(/); assert.doesNotMatch(helpers, /const App =/);
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/css/styles.css">
        <input id="fixture-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"><p id="fixture-status"></p>
        <script>Object.assign(window,{USE_SUPABASE_AUTH:true,STORY_INTERACTIONS:true,STORY_MEDIA_VALIDATION:${!url.searchParams.has('flag-off')},
          SUPABASE_URL:${JSON.stringify(apiOrigin)},SUPABASE_ANON_KEY:'fixture-public',__owner:${JSON.stringify(owner)},__tokens:${JSON.stringify({ [owner]: signedToken(owner), [peer]: signedToken(peer) })}});
          const SupaAuth={active:()=>true,uid:()=>window.__owner,token:async()=>window.__tokens[window.__owner],_authEpoch:1};
          ${helpers}
          const App={toast:message=>document.getElementById('fixture-status').textContent=message,
            _ICONS:${JSON.stringify(icons.symbols)},${icons.renderer}};</script>
        <script src="/js/cloud.js"></script><script src="/js/mod/social.js"></script><script src="/js/mod/stories.js"></script>
        <script>Cloud._ensureIdentity(); Social.key='fixture'; Social.state={}; Social.render=()=>{};
          document.getElementById('fixture-file').addEventListener('change',event=>Social.onStoryFile(event));</script>`);
      return;
    }
    const files = ['/css/styles.css', '/js/cloud.js', '/js/mod/social.js', '/js/mod/stories.js'];
    if (!files.includes(url.pathname)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': (url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript') + '; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, url.pathname)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
});
after(async () => {
  try { await browser?.close(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    report.completedAt = new Date().toISOString(); report.sourceUnchanged = JSON.stringify(fingerprint()) === JSON.stringify(report.fingerprints);
    report.result = report.sourceUnchanged && report.cases.length > 0 && report.cases.every(item => item.result === 'passed') ? 'passed' : 'failed';
    if (fixtureDirectory) {
      fs.writeFileSync(path.join(fixtureDirectory, 'pipeline-evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ pipelineEvidence: path.relative(root, path.join(fixtureDirectory, 'pipeline-evidence.json')),
        result: report.result, sourceUnchanged: report.sourceUnchanged, browserScenarios: report.cases.length }));
    }
  }
});

async function openFixture(scope, options = {}) {
  const db = await database(null, !options.flagOff);
  if (options.flagOff) await db.query(`UPDATE public.story_settings SET enabled=true,permission_policy_approved=true,media_audience_approved=true,
    public_media_approved=true,retention_approved=true,operator_policy_ref=$1,media_origin=$2,public_bucket='media'`, [policy, apiOrigin]);
  const context = await browser.newContext({ viewport: options.viewport || { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { calls: [], media: new Map(), external: [], errors: [], consoleErrors: [], uploads: 0, promotions: 0, publications: [], lostUpload: false, lostPublish: false };
  let tail = Promise.resolve();
  const serial = work => { const next = tail.then(work); tail = next.catch(() => {}); return next; };
  const query = (sql, parameters = []) => serial(async () => { await db.exec('RESET ROLE'); return (await db.query(sql, parameters)).rows; });
  const invoke = (actor, role, name, body) => serial(async () => {
    try {
      if (!Object.hasOwn(specifications, name) || Object.keys(body).sort().join() !== [...specifications[name]].sort().join()) return { status: 400, body: { error: 'unknown_rpc_shape' } };
      await identity(db, actor, role);
      return { status: 200, body: await rpc(db, name, specifications[name].map(key => body[key])) };
    } catch (error) { return { status: statusFor(error), body: { code: error.code, message: 'Fixture SQL rejected operation' } }; }
  });
  const bridge = startRuntimeBridge(async message => {
    state.calls.push({ surface: 'server', name: new URL(message.url).pathname, body: message.body ? JSON.parse(message.body) : null });
    if (!message.url.startsWith(apiOrigin + '/')) throw new Error('Forbidden endpoint');
    if (message.url === apiOrigin + '/auth/v1/user') {
      const actor = verifiedOwner(message.headers.authorization || '');
      return { status: actor ? 200 : 401, body: actor ? { id: actor, is_anonymous: false } : { error: 'invalid_token' } };
    }
    if (message.headers.authorization !== 'Bearer fixture-service-only' || message.headers.apikey !== 'fixture-service-only') throw new Error('Service credential missing');
    if (message.url.includes('/rest/v1/rpc/')) return invoke(null, 'service_role', message.url.split('/').at(-1), JSON.parse(message.body));
    if (message.method === 'POST' && message.url.startsWith(apiOrigin + '/storage/v1/object/story-media-public-v3/')) {
      const key = message.url.slice((apiOrigin + '/storage/v1/object/').length), divider = key.indexOf('/');
      const bytes = Buffer.from(message.bodyBase64, 'base64'), type = message.headers['content-type'];
      assert.equal(message.headers['x-upsert'], 'false'); assert.ok(bytes.length <= 26214400);
      const metadata = JSON.parse(Buffer.from(message.headers['x-metadata'], 'base64'));
      const expectedHash = createHash('sha256').update(bytes).digest('hex');
      assert.equal(metadata.sha256, expectedHash);
      return serial(async () => {
        try {
          await identity(db, null, 'service_role');
          const row = (await db.query('INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata) VALUES($1,$2,NULL,NULL,$3,$4) RETURNING id,version',
            [key.slice(0, divider), key.slice(divider + 1), { mimetype: type, size: bytes.length }, metadata])).rows[0];
          assert.equal(state.media.has(key), false); state.media.set(key, { bytes, type, id: row.id, version: row.version }); state.promotions++;
          return { status: 200, body: { Key: key, Id: row.id } };
        } catch (error) { return { status: statusFor(error), body: { code: error.code } }; }
      });
    }
    const prefix = apiOrigin + '/storage/v1/object/authenticated/';
    const stored = message.url.startsWith(prefix) && state.media.get(message.url.slice(prefix.length));
    if (!stored) return { status: 404, body: {} };
    if (options.missingLengthOnce && !state.missingLengthUsed && message.url.includes('/story-media-quarantine-v3/')) {
      state.missingLengthUsed = true;
      return { status: 200, body: stored.bytes, headers: { 'content-type': stored.type } };
    }
    return { status: 200, body: stored.bytes, headers: { 'content-type': stored.type, 'content-length': String(stored.bytes.length) } };
  });
  scope.after(async () => { options.hold?.release.resolve(); await context.close(); await bridge.close(); await tail; await db.close(); });
  await context.route('**/*', async route => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== apiOrigin) { state.external.push(url.href); return route.abort(); }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'apikey,authorization,content-type,x-upsert' } });
      const reply = result => route.fulfill({ status: result.status, json: result.body, headers: { 'access-control-allow-origin': origin } });
      const actor = verifiedOwner(request.headers().authorization || '');
      if (url.pathname.startsWith('/storage/v1/object/public/')) {
        state.calls.push({ surface: 'read', name: 'Stored media read', path: url.pathname });
        const key = url.pathname.slice('/storage/v1/object/public/'.length);
        const buckets = await query('SELECT public FROM storage.buckets WHERE id=$1', [key.split('/')[0]]);
        const stored = buckets[0]?.public === true && state.media.get(key);
        return stored ? route.fulfill({ status: 200, body: stored.bytes, contentType: stored.type }) : reply({ status: 404, body: {} });
      }
      if (!actor) return reply({ status: 401, body: { error: 'fixture_auth_required' } });
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const key = url.pathname.slice('/storage/v1/object/'.length), divider = key.indexOf('/'), bucket = key.slice(0, divider), name = key.slice(divider + 1);
        const bytes = request.postDataBuffer(), type = request.headers()['content-type'];
        state.calls.push({ surface: 'client', name: 'Storage INSERT', upsert: request.headers()['x-upsert'], key });
        const result = await serial(async () => {
          try {
            await identity(db, actor);
            const row = (await db.query('INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata) VALUES($1,$2,$3,$4,$5) RETURNING id,version',
              [bucket, name, actor, actor, { mimetype: type, size: bytes.length }])).rows[0];
            assert.equal(state.media.has(key), false); state.media.set(key, { bytes, type, id: row.id, version: row.version }); state.uploads++;
            return { status: 200, body: { Key: key, Id: row.id } };
          } catch (error) { return { status: statusFor(error), body: { code: error.code } }; }
        });
        if (options.hold?.at === 'upload') { options.hold.started.resolve(); await options.hold.release.promise; }
        if (options.lostUpload && !state.lostUpload) { state.lostUpload = true; return route.abort('failed'); }
        return reply(result);
      }
      const body = request.postDataJSON();
      state.calls.push({ surface: 'client', name: url.pathname.split('/').at(-1), body });
      if (url.pathname === '/functions/v1/validate-story-media') {
        const result = await bridge.validate(request.headers().authorization, body);
        if (options.hold?.at === 'validation') { options.hold.started.resolve(); await options.hold.release.promise; }
        return reply(result);
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1);
        const result = await invoke(actor, 'authenticated', name, body);
        if (['publish_story', 'publish_validated_story'].includes(name)) {
          state.publications.push({ name, body, result });
          if (options.lostPublish && !state.lostPublish) { state.lostPublish = true; return route.abort('failed'); }
        }
        return reply(result);
      }
      return reply({ status: 404, body: {} });
    } catch (error) { state.errors.push(error.message); if (!context.pages().every(page => page.isClosed())) await route.abort().catch(() => {}); }
  });
  const page = await context.newPage(); page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
  scope.after(() => { report.cases.at(-1).consoleErrors = state.consoleErrors; report.cases.at(-1).pageErrors = state.errors; });
  await page.goto(origin + '/' + (options.flagOff ? '?flag-off' : ''));
  const select = filename => page.locator('#fixture-file').setInputFiles(path.join(fixtureDirectory, filename));
  const share = () => page.locator('.sp-share').click();
  const confirmed = () => page.waitForFunction(() => document.querySelector('#fixture-status').textContent.includes('Story shared.'));
  return { page, state, db, query, select, share, confirmed };
}
function scenario(name, work) {
  test(name, { timeout: 30000 }, async scope => {
    const row = { name, result: 'running' }; report.cases.push(row);
    try { await work(scope, row); row.result = 'passed'; }
    catch (error) { row.result = 'failed'; row.error = error.message; throw error; }
  });
}
for (const [filename, viewport] of [['photo.png', { width: 390, height: 844 }], ['clip.mp4', { width: 1280, height: 900 }], ['clip.webm', { width: 390, height: 844 }]]) {
  scenario('browser binary-to-SQL publication: ' + filename, async (scope, evidence) => {
    const fixture = await openFixture(scope, { viewport }); await fixture.select(filename);
    await fixture.page.waitForFunction(() => {
      const media = document.querySelector('.sv-media');
      return media && (media.tagName === 'IMG' ? media.complete && media.naturalWidth > 0 : media.readyState >= 2 && media.videoWidth > 0);
    });
    await fixture.page.screenshot({ path: path.join(fixtureDirectory, 'preview-' + filename.replace('.', '-') + '.png'), animations: 'disabled' });
    await fixture.share(); await fixture.confirmed();
    const rows = await fixture.query(`SELECT reservation.*,content.media_url AS published_url FROM public.story_media_reservations AS reservation
      JOIN public.story_content AS content ON content.story_id=reservation.published_story_id`);
    assert.equal(rows.length, 1); const row = rows[0], stored = fixture.state.media.get(row.bucket + '/' + row.object_key);
    const promoted = fixture.state.media.get(row.public_bucket + '/' + row.public_key);
    assert.equal(row.bucket, 'story-media-quarantine-v3'); assert.equal(row.public_bucket, 'story-media-public-v3');
    assert.ok(promoted.bytes.equals(stored.bytes)); assert.notEqual(promoted.id, stored.id);
    assert.equal(promoted.id, row.public_object_id); assert.equal(promoted.version, row.public_object_version);
    assert.equal(fixture.state.promotions, 1); assert.equal(fixture.state.uploads, 1);
    assert.equal(row.status, 'published'); assert.equal(row.published_url, row.media_url);
    assert.equal(row.sha256, createHash('sha256').update(stored.bytes).digest('hex'));
    assert.equal(row.actual_bytes, stored.bytes.length); assert.equal(row.duration_ms, filename.endsWith('.png') ? null : 1000);
    assert.equal(fixture.state.calls.find(call => call.name === 'Storage INSERT').upsert, 'false');
    assert.equal(fixture.state.publications[0].name, 'publish_validated_story');
    assert.equal(fixture.state.publications[0].body.p_request_id, row.request_id);
    assert.equal(await fixture.page.evaluate(() => Social._storyDraft), null);
    await fixture.page.evaluate(async id => { await Stories.open(id); }, row.published_story_id);
    await fixture.page.waitForFunction(url => {
      const media = [...Stories._root.querySelectorAll('img,video')].find(element => element.src === url);
      return media && (media.tagName === 'IMG' ? media.complete && media.naturalWidth > 0 : media.readyState >= 2 && media.videoWidth > 0);
    }, row.media_url);
    await fixture.page.screenshot({ path: path.join(fixtureDirectory, 'published-' + filename.replace('.', '-') + '.png'), animations: 'disabled' });
    assert.equal(fixture.state.calls.some(call => call.name === 'Stored media read'), true);
    assert.deepEqual(fixture.state.external, []); assert.deepEqual(fixture.state.errors, []);
    assert.deepEqual(fixture.state.consoleErrors, []);
    Object.assign(evidence, { viewport, bytes: row.actual_bytes, sha256: row.sha256, durationMs: row.duration_ms,
      checkedReadDecoded: true, calls: fixture.state.calls.map(call => call.name) });
  });
}
for (const loss of ['lostUpload', 'lostPublish']) scenario('browser retries ' + loss + ' without overwriting or duplicate publication', async scope => {
  const fixture = await openFixture(scope, { [loss]: true }); await fixture.select('photo.jpg'); await fixture.share();
  await fixture.page.waitForFunction(() => Social._storyDraft && !Social._storyDraft.sending);
  const requestId = await fixture.page.evaluate(() => Social._storyDraft.id);
  await fixture.share(); await fixture.confirmed();
  assert.equal(fixture.state.uploads, 1);
  assert.equal(fixture.state.promotions, 1);
  const rows = await fixture.query('SELECT request_id,status FROM public.story_media_reservations');
  assert.equal(rows.length, 1); assert.equal(rows[0].request_id, requestId); assert.equal(rows[0].status, 'published');
  assert.equal((await fixture.query('SELECT * FROM public.stories_v2')).length, 1);
  assert.deepEqual(fixture.state.errors, []);
});
scenario('browser malformed video is retained as a failed orphan, not published', async scope => {
  const fixture = await openFixture(scope); await fixture.select('truncated-clip.mp4'); await fixture.share();
  await fixture.page.waitForFunction(() => Social._storyDraft && !Social._storyDraft.sending);
  assert.equal((await fixture.query('SELECT * FROM public.stories_v2')).length, 0);
  const rows = await fixture.query('SELECT status,sha256,bucket,object_key,public_key FROM public.story_media_reservations');
  assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].sha256, null);
  assert.equal(fixture.state.media.size, 1); assert.equal(fixture.state.publications.length, 0);
  assert.equal(fixture.state.promotions, 0); assert.equal(rows[0].public_key, null);
  assert.equal((await fixture.query("SELECT id FROM storage.objects WHERE bucket_id='story-media-public-v3'")).length, 0);
  const anonymousStatus = await fixture.page.evaluate(async url => (await fetch(url, { credentials: 'omit' })).status,
    apiOrigin + '/storage/v1/object/public/' + rows[0].bucket + '/' + rows[0].object_key);
  assert.equal(anonymousStatus, 404);
  assert.match(await fixture.page.locator('#fixture-status').textContent(), /supported photo or a video/);
  assert.deepEqual(fixture.state.errors, []);
});
for (const boundary of ['cancel-upload', 'account-validation']) scenario('browser fences ' + boundary + ' before publication', async scope => {
  const hold = { at: boundary === 'cancel-upload' ? 'upload' : 'validation', started: deferred(), release: deferred() };
  const fixture = await openFixture(scope, { hold }); await fixture.select('photo.png'); await fixture.share(); await hold.started.promise;
  await fixture.page.evaluate(next => {
    window.__heldShare = Social._storyDraft;
    if (next) { window.__owner = next; SupaAuth._authEpoch++; Cloud._ensureIdentity(); } else Social.cancelStory();
  }, boundary === 'account-validation' ? peer : null);
  hold.release.resolve();
  await fixture.page.waitForFunction(() => !window.__heldShare.sending);
  assert.equal(fixture.state.publications.length, 0); assert.equal((await fixture.query('SELECT * FROM public.stories_v2')).length, 0);
  if (boundary === 'cancel-upload') assert.equal(fixture.state.calls.some(call => call.name === 'validate-story-media'), false);
  assert.equal(fixture.state.media.size, boundary === 'cancel-upload' ? 1 : 2);
  assert.equal(fixture.state.promotions, boundary === 'cancel-upload' ? 0 : 1); assert.deepEqual(fixture.state.errors, []);
});
scenario('browser flag-off preserves the original legacy-bucket upload and v2 publishing route', async scope => {
  const fixture = await openFixture(scope, { flagOff: true }); await fixture.select('photo.png'); await fixture.share(); await fixture.confirmed();
  assert.equal(fixture.state.calls.find(call => call.name === 'Storage INSERT').upsert, 'true');
  assert.equal(fixture.state.publications[0].name, 'publish_story');
  assert.equal(fixture.state.calls.some(call => call.name === 'reserve_story_media' || call.name === 'validate-story-media'), false);
  assert.equal((await fixture.query('SELECT * FROM public.story_media_reservations')).length, 0);
  assert.deepEqual(fixture.state.errors, []);
});
scenario('browser infrastructure failure retries the original quarantine upload within the real SQL attempt cap', async scope => {
  const fixture = await openFixture(scope, { missingLengthOnce: true }); await fixture.select('photo.jpg'); await fixture.share();
  await fixture.page.waitForFunction(() => Social._storyDraft && !Social._storyDraft.sending);
  const before = (await fixture.query('SELECT request_id,status,attempts,sha256,public_object_id FROM public.story_media_reservations'))[0];
  assert.equal(before.status, 'reserved'); assert.equal(before.attempts, 1); assert.equal(before.sha256, null); assert.equal(before.public_object_id, null);
  assert.equal(fixture.state.promotions, 0); assert.equal(fixture.state.uploads, 1);
  await fixture.share(); await fixture.confirmed();
  const after = (await fixture.query('SELECT request_id,status,attempts FROM public.story_media_reservations'))[0];
  assert.equal(after.request_id, before.request_id); assert.equal(after.status, 'published'); assert.equal(after.attempts, 2);
  assert.equal(fixture.state.uploads, 1); assert.equal(fixture.state.promotions, 1); assert.deepEqual(fixture.state.errors, []);
});
}