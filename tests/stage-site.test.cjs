'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stageConfig, stagePolicy, guardSource, transformHtml, buildStageSite } = require('../tools/build-stage-site.cjs');
const qat = require('../scripts/qat-config.cjs');
const commit = 'a'.repeat(40);
const origin = 'https://formora-qat.pages.dev';
const testKey = (role = 'anon', ref = qat.projectRef) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role, ref, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  Buffer.alloc(32, 1).toString('base64url')
].join('.');

test('Test stages cannot target production or a shared Pages origin', () => {
  for (const stage of ['main', 'production', '__proto__']) assert.throws(() => stageConfig(stage, commit, origin));
  for (const url of ['https://arindamchatterjee007.github.io/formora/', 'http://formora-qat.pages.dev', origin + '/qat', 'https://formora-qat.pages.dev@evil.test/']) {
    assert.throws(() => stageConfig('qat', commit, url), url);
  }
  assert.throws(() => stageConfig('qat', 'short', origin));
  assert.equal(stageConfig('qat', commit, origin).branch, 'release');
  assert.equal(stageConfig('beta', commit, 'https://formora-beta.pages.dev').acceptance, 'pending');
});

test('The guard runs before production config and cannot enable hosted services', () => {
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(guardSource(stageConfig('qat', commit, origin)), context);
  vm.runInContext('window.SUPABASE_URL="https://production.invalid";window.USE_SUPABASE_AUTH=true;window.RAZORPAY={enabled:true};window.RAZORPAY.enabled=true;window.LEMONSQUEEZY.buy.pro="https://checkout.invalid";', context);
  assert.equal(window.SUPABASE_URL, '');
  assert.equal(window.USE_SUPABASE_AUTH, false);
  assert.equal(window.RAZORPAY.enabled, false);
  assert.equal(window.LEMONSQUEEZY.buy.pro, undefined);
  assert.equal(window.FORMORA_STAGE.commit, commit);
  assert.equal(window.FORMORA_STAGE.backendConfigured, false);
  vm.runInContext('"use strict";window.SUPABASE_URL="https://production.invalid";window.RAZORPAY={enabled:true};', context);
  assert.equal(window.SUPABASE_URL, '');
  assert.equal(window.LAUNCH_OFFER, false);
  assert.throws(() => vm.runInContext('Object.defineProperty(window,"SUPABASE_URL",{value:"bypass"})', context));
});

test('An isolated QAT build accepts only its public project key and keeps all unrelated services off', async () => {
  const backend = { projectRef: qat.projectRef, anonKey: testKey() };
  const config = stageConfig('qat', commit, origin, backend), window = {};
  vm.runInNewContext(guardSource(config, backend), { window });
  assert.equal(config.mode, 'isolated-backend');
  assert.equal(config.backendConfigured, true);
  assert.equal(window.SUPABASE_URL, qat.backendOrigin);
  assert.equal(window.USE_SUPABASE_AUTH, true);
  assert.equal(window.STORY_INTERACTIONS, false);
  assert.equal(window.ACCOUNT_RIGHTS, false);
  assert.equal(window.RAZORPAY.enabled, false);
  assert.equal(JSON.stringify(config).includes(backend.anonKey), false);
  assert.equal(stagePolicy(config).split('connect-src ')[1].split(';')[0], "'self' " + qat.backendOrigin);
  assert.match(stagePolicy(config), /manifest-src 'self';/);
  assert.doesNotMatch(stagePolicy(config), /ptukgtxpigdkdzsewuvz|\*\.supabase/);
  assert.match(await transformHtml('<title>Formora</title>', config), /QAT isolated test/);
  for (const value of [null, {}, { ...backend, serviceKey: testKey('service_role') }, { ...backend, anonKey: testKey('service_role') },
    { ...backend, anonKey: testKey('anon', 'ptukgtxpigdkdzsewuvz') }, { ...backend, projectRef: 'ptukgtxpigdkdzsewuvz' }]) {
    assert.throws(() => qat.validateBackend(value));
  }
  assert.throws(() => stageConfig('beta', commit, origin, backend));
  assert.throws(() => stageConfig('qat', commit, 'https://other-qat.pages.dev', backend));
  assert.throws(() => stagePolicy({ ...config, backendOrigin: 'https://production.invalid' }));
});

test('HTML transformation installs fail-closed CSP and guard before all app scripts', async () => {
  const source = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="connect-src https:"><title>Formora</title><script src="js/config.js"></script></head><body><h1>Formora</h1></body></html>';
  const html = await transformHtml(source, stageConfig('qat', commit, origin));
  const { parse } = await import('parse5');
  const head = parse(html).childNodes.find(node => node.tagName === 'html').childNodes.find(node => node.tagName === 'head');
  const csp = head.childNodes.filter(node => node.tagName === 'meta' && node.attrs.some(attr => attr.name === 'http-equiv'));
  assert.equal(csp.length, 1);
  assert.match(csp[0].attrs.find(attr => attr.name === 'content').value, /connect-src 'self';/);
  assert.ok(html.indexOf('/__formora/stage.js') < html.indexOf('js/config.js'));
  assert.match(html, /QAT offline/);
  assert.match(html, /noindex,nofollow,noarchive/);
  assert.match(html, /<h1>Formora<\/h1>/);
});

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-stage-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['js', 'css', 'assets', 'icons', 'guides', 'office', 'backups', '.git', 'supabase']) fs.mkdirSync(path.join(root, directory));
  for (const file of ['index.html', 'legal.html', 'manifest.webmanifest', 'version.txt', 'push-worker.js', 'js/app.js', 'css/app.css', 'assets/real.png', 'office/private.json', 'backups/private.json']) {
    fs.writeFileSync(path.join(root, file), file.endsWith('.html') ? '<!doctype html><title>Formora</title><h1>App</h1>' : 'fixture');
  }
  return root;
}

test('Only app assets are packaged, with immutable source identities and no SPA private-path fallback', async context => {
  const root = fixture(context), output = path.join(root, 'dist/qat');
  const before = fs.readFileSync(path.join(root, 'index.html'));
  const result = await buildStageSite({ root, output, stage: 'qat', commit, origin });
  assert.equal(result.mode, 'offline-preview');
  assert.ok(fs.readFileSync(path.join(root, 'index.html')).equals(before));
  for (const file of ['office', 'backups', '.git', 'supabase', 'package.json']) assert.equal(fs.existsSync(path.join(output, file)), false);
  assert.ok(fs.existsSync(path.join(output, 'assets/real.png')));
  assert.ok(fs.existsSync(path.join(output, '404.html')));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, '__formora/candidate.json')));
  assert.equal(manifest.commit, commit);
  assert.ok(manifest.files.every(item => /^[a-f0-9]{64}$/.test(item.sourceSha256)));
  assert.deepEqual(manifest.controls.map(item => item.file).sort(), ['404.html', '__formora/stage.js', '_headers', 'robots.txt'].sort());
  const { createHash } = require('node:crypto');
  for (const item of manifest.controls) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(output, item.file))).digest('hex'), item.publishedSha256);
  assert.equal(result.sourceDigest, manifest.sourceDigest);
  assert.match(fs.readFileSync(path.join(output, '_headers'), 'utf8'), /frame-ancestors 'none'/);
  await assert.rejects(buildStageSite({ root, output, stage: 'qat', commit, origin }), /already exists/);
});

test('The isolated bundle uses the same hashed security controls without publishing backend credentials', async context => {
  const root = fixture(context), output = path.join(root, 'dist/isolated');
  const backend = { projectRef: qat.projectRef, anonKey: testKey() };
  await buildStageSite({ root, output, stage: 'qat', commit, origin, backend });
  const manifest = JSON.parse(fs.readFileSync(path.join(output, '__formora/candidate.json')));
  assert.equal(manifest.backendProjectRef, qat.projectRef);
  assert.equal(manifest.backendConfigured, true);
  assert.equal(manifest.acceptance, 'pending');
  assert.equal(JSON.stringify(manifest).includes(backend.anonKey), false);
  const headers = fs.readFileSync(path.join(output, '_headers'), 'utf8');
  assert.match(headers, new RegExp("connect-src 'self' " + qat.backendOrigin.replace(/[.]/g, '[.]')));
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(output, '__formora/stage.js'), 'utf8'), { window });
  assert.equal(window.SUPABASE_ANON_KEY, backend.anonKey);
  assert.equal(window.STORY_MEDIA_VALIDATION, false);
});

test('Stage output refuses symlink escapes and cannot overwrite the source tree', async context => {
  const root = fixture(context);
  await assert.rejects(buildStageSite({ root, output: path.join(root, 'www'), stage: 'qat', commit, origin }), /below dist/);
  fs.symlinkSync(path.join(root, 'office/private.json'), path.join(root, 'assets/hidden.txt'));
  await assert.rejects(buildStageSite({ root, output: path.join(root, 'dist/unsafe'), stage: 'qat', commit, origin }), /Symlink/);
  assert.equal(fs.existsSync(path.join(root, 'dist/unsafe')), false);
});

test('An interrupted packaging write leaves no deployable partial output', async context => {
  const root = fixture(context), output = path.join(root, 'dist/interrupted');
  const write = fs.writeFileSync;
  context.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('/__formora/stage.js')) throw new Error('fixture interrupted write');
    return write(file, ...args);
  });
  await assert.rejects(buildStageSite({ root, output, stage: 'qat', commit, origin }), /interrupted write/);
  assert.equal(fs.existsSync(output), false);
});