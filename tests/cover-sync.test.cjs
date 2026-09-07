'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = ['../js/app.js', '../js/mod/profile.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const state = { uid: 'A', uploads: [], profiles: [], messages: [], saved: 0 };
  const storage = new Map();
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} }, File, Blob, atob, AbortController,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout, clearTimeout,
    Auth: { currentUser: () => ({ id: state.uid, email: state.uid + '@example.test' }) },
    SupaAuth: { active: () => true, uid: () => state.uid, email: () => state.uid + '@example.test' },
    Store: { key: 'store-A', state: { profile: { cover: 'previous', coverUrl: 'https://fixture.test/old.jpg' } }, save: () => { state.saved++; } },
    Cloud: { active: () => true, me: 'A',
      uploadMedia: async (file, folder) => { state.uploads.push({ file, folder }); return 'https://fixture.test/new.jpg'; },
      registerMe: async profile => { state.profiles.push({ ...profile }); return true; } },
    fetch: async () => ({ blob: async () => new Blob(['photo'], { type: 'image/jpeg' }) })
  });
  vm.runInContext(source + '\nglobalThis.app = App;', context);
  context.resizeImage = async () => 'data:image/jpeg;base64,bmV3';
  Object.assign(context.app, { _entry: 1, _authUid: 'A', curTab: 'profile', renderProfile() {}, toast: message => state.messages.push(message) });
  return { context, app: context.app, state, event: { target: { files: [new File(['photo'], 'cover.jpg', { type: 'image/jpeg' })] } } };
}

test('cover sync saves a local-only draft and publishes only after an acknowledged public-profile write', async () => {
  const { app, context, state, event } = setup();
  const ack = deferred(), started = deferred();
  context.Cloud.registerMe = profile => { state.profiles.push({ ...profile }); started.resolve(); return ack.promise; };
  const upload = app.uploadCover(event);
  await started.promise;
  assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/old.jpg');
  assert.equal(context.Store.state.profile.coverPending, true);
  assert.equal(context.Store.state.profile.cover, 'previous');
  assert.match(JSON.parse(context.localStorage.getItem('fm_cover_pending_A')).data, /^data:image\/jpeg/);
  ack.resolve(true);
  await upload;
  assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/new.jpg');
  assert.equal(context.Store.state.profile.coverPending, false);
  assert.equal(state.uploads[0].folder, 'covers');
});

test('failed cover upload and profile acknowledgement retain the old public URL and permit retry', async () => {
  for (const failure of ['upload', 'profile']) {
    const { app, context, state, event } = setup();
    const upload = context.Cloud.uploadMedia, publish = context.Cloud.registerMe;
    if (failure === 'upload') context.Cloud.uploadMedia = async () => null;
    else context.Cloud.registerMe = async () => false;
    await app.uploadCover(event);
    assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/old.jpg');
    assert.equal(context.Store.state.profile.coverPending, true);
    assert.match(state.messages.at(-1), /retry|try again/i);
    app._coverDraft = null;
    context.Cloud.uploadMedia = upload; context.Cloud.registerMe = publish;
    await app.syncCover();
    assert.equal(context.Store.state.profile.coverPending, false);
    assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/new.jpg');
    assert.equal(state.uploads.length, 1, 'A failed publication must reuse its uploaded object');
    assert.equal(context.localStorage.getItem('fm_cover_pending_A'), null);
  }
});

test('late cover resize or upload cannot overwrite a different account', async () => {
  for (const phase of ['resize', 'upload']) {
    const { app, context, state, event } = setup();
    const gate = deferred(), started = deferred();
    if (phase === 'resize') context.resizeImage = () => { started.resolve(); return gate.promise; };
    else context.Cloud.uploadMedia = () => { started.resolve(); return gate.promise; };
    const uploading = app.uploadCover(event);
    await started.promise;
    app._entry++; state.uid = 'B'; app._authUid = 'B'; context.Cloud.me = 'B';
    context.Store.key = 'store-B'; context.Store.state = { profile: { cover: 'B image', coverUrl: 'B URL' } };
    gate.resolve(phase === 'resize' ? 'data:image/jpeg;base64,bmV3' : 'https://fixture.test/new.jpg');
    await uploading;
    assert.equal(context.Store.state.profile.cover, 'B image');
    assert.equal(context.Store.state.profile.coverUrl, 'B URL');
    assert.equal(state.profiles.length, 0);
  }
});

test('duplicate retry shares one pending cover upload', async () => {
  const { app, context, state } = setup();
  context.Store.state.profile.cover = 'data:image/jpeg;base64,bmV3';
  context.Store.state.profile.coverPending = true;
  const gate = deferred(), started = deferred();
  context.Cloud.uploadMedia = () => { state.uploads.push({}); started.resolve(); return gate.promise; };
  const first = app.syncCover();
  await started.promise;
  const duplicate = app.syncCover();
  gate.resolve('https://fixture.test/new.jpg');
  await Promise.all([first, duplicate]);
  assert.equal(state.uploads.length, 1);
});

test('a newer cover selection waits for older publication then becomes the final public image', async () => {
  const { app, context, state, event } = setup();
  const gate = deferred(), started = deferred();
  let uploads = 0;
  context.Cloud.uploadMedia = async () => 'https://fixture.test/image-' + (++uploads) + '.jpg';
  context.Cloud.registerMe = profile => {
    state.profiles.push({ ...profile });
    if (state.profiles.length === 1) { started.resolve(); return gate.promise; }
    return Promise.resolve(true);
  };
  const first = app.uploadCover(event);
  await started.promise;
  const second = app.uploadCover(event);
  await Promise.resolve();
  assert.equal(uploads, 1);
  gate.resolve(true);
  await Promise.all([first, second]);
  assert.equal(uploads, 2);
  assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/image-2.jpg');
  assert.equal(state.profiles.at(-1).coverUrl, 'https://fixture.test/image-2.jpg');
  assert.equal(context.Store.state.profile.coverPending, false);
});

test('a stalled public-profile acknowledgement times out and releases cover retry', async () => {
  const { app, context, event } = setup();
  const timers = [], started = deferred();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cloud.js'), 'utf8') + '\nglobalThis.realCloud = Cloud;', context);
  Object.assign(context.realCloud, { me: 'A', base: 'https://fixture.test/rest/v1', key: 'fixture-key', active: () => true,
    uploadMedia: async () => 'https://fixture.test/new.jpg' });
  Object.assign(context.SupaAuth, { token: async () => 'fixture-token', bearer: () => 'fixture-token' });
  context.setTimeout = (callback, milliseconds) => { assert.equal(milliseconds, 10000); timers.push(callback); return 1; };
  context.clearTimeout = () => {};
  context.fetch = (url, options) => {
    started.resolve();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  };
  const uploading = app.uploadCover(event);
  await started.promise;
  timers[0]();
  assert.equal(await uploading, false);
  assert.equal(app._coverSync, null);
  assert.equal(context.Store.state.profile.coverPending, true);
  assert.equal(context.Store.state.profile.coverUrl, 'https://fixture.test/old.jpg');
  context.fetch = async () => ({ ok: true });
  assert.equal(await app.syncCover(), true);
  assert.equal(context.Store.state.profile.coverPending, false);
});