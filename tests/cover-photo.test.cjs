'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = ['../js/app.js', '../js/mod/profile.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const originalUrl = 'https://cover-fixture.test/original.jpg';
const uploadedUrl = 'https://cover-fixture.test/uploaded.jpg';
const imageData = 'data:image/jpeg;base64,bmV3';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const state = { uid: 'A', uploads: [], profiles: [], messages: [], saves: [] };
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} }, File, Blob, atob, Uint8Array,
    setTimeout, clearTimeout,
    Auth: { currentUser: () => state.uid ? { id: state.uid, email: state.uid + '@example.test' } : null },
    SupaAuth: { active: () => true, uid: () => state.uid, email: () => state.uid + '@example.test' },
    Store: {
      key: 'store-A', state: { profile: { name: 'A', cover: originalUrl, coverUrl: originalUrl }, workoutLog: [{ id: 'keep-workout' }] },
      save() { state.saves.push({ key: this.key, value: structuredClone(this.state) }); },
    },
    Cloud: {
      active: () => true, me: 'A',
      uploadMedia: async (file, folder) => { state.uploads.push({ file, folder }); return uploadedUrl; },
      registerMe(profile) { state.profiles.push({ uid: this.me, profile: { ...profile } }); return Promise.resolve(true); },
    },
    fetch: async () => ({ blob: async () => new Blob(['photo'], { type: 'image/jpeg' }) }),
  });
  vm.runInContext(source + '\nglobalThis.app = App;', context);
  context.resizeImage = async () => imageData;
  Object.assign(context.app, {
    _entry: 1, _authUid: 'A', curTab: 'profile', renderProfile() {},
    toast: message => state.messages.push(message),
  });
  const event = { target: { files: [new File(['photo'], 'cover.jpg', { type: 'image/jpeg' })] } };
  return { context, app: context.app, state, event };
}

test('cover remains unchanged until both upload and profile persistence acknowledge success', async () => {
  const { app, context, state, event } = setup();
  const gate = deferred(), seen = deferred();
  context.Cloud.registerMe = profile => {
    state.profiles.push({ uid: context.Cloud.me, profile: { ...profile } });
    seen.resolve();
    return gate.promise;
  };
  const uploading = app.uploadCover(event);
  await seen.promise;
  const pending = { ...context.Store.state.profile };
  gate.resolve(true);
  assert.equal(await uploading, true);
  assert.equal(pending.cover, originalUrl);
  assert.equal(pending.coverUrl, originalUrl);
  assert.equal(pending.coverPending, true);
  assert.equal(context.Store.state.profile.cover, uploadedUrl);
  assert.equal(context.Store.state.profile.coverUrl, uploadedUrl);
  assert.equal(context.Store.state.profile.coverPending, false);
  assert.equal(state.uploads[0].folder, 'covers');
  assert.equal(state.uploads[0].file.type, 'image/jpeg');
  assert.equal(state.messages.filter(message => /synced/i.test(message)).length, 1);
  assert.deepEqual(context.Store.state.workoutLog, [{ id: 'keep-workout' }]);
});

for (const failure of ['upload', 'profile']) {
  test(`${failure} rejection preserves the original cover and supports retry without fake success`, async () => {
    const { app, context, state, event } = setup();
    const upload = context.Cloud.uploadMedia, register = context.Cloud.registerMe;
    if (failure === 'upload') context.Cloud.uploadMedia = async () => null;
    else context.Cloud.registerMe = async () => false;
    assert.equal(await app.uploadCover(event), false);
    assert.equal(context.Store.state.profile.cover, originalUrl);
    assert.equal(context.Store.state.profile.coverUrl, originalUrl);
    assert.equal(context.Store.state.profile.coverPending, true);
    assert.match(state.messages.at(-1), /could not|couldn't/i);
    assert.match(state.messages.at(-1), /retry|try again/i);
    assert.equal(state.messages.some(message => /cover synced|success/i.test(message)), false);
    context.Cloud.uploadMedia = upload;
    context.Cloud.registerMe = register;
    assert.equal(await app.syncCover(), true);
    assert.equal(context.Store.state.profile.cover, uploadedUrl);
    assert.equal(context.Store.state.profile.coverUrl, uploadedUrl);
    assert.equal(context.Store.state.profile.coverPending, false);
  });
}

test('Cloud.me changing during upload prevents any profile registration under the new key', async () => {
  const { app, context, state, event } = setup();
  const gate = deferred(), seen = deferred();
  context.Cloud.uploadMedia = () => { seen.resolve(); return gate.promise; };
  const uploading = app.uploadCover(event);
  await seen.promise;
  context.Cloud.me = 'B';
  gate.resolve(uploadedUrl);
  assert.equal(await uploading, false);
  assert.equal(state.profiles.length, 0);
  assert.equal(context.Store.state.profile.cover, originalUrl);
  assert.equal(context.Store.state.profile.coverUrl, originalUrl);
  assert.equal(state.messages.some(message => /synced/i.test(message)), false);
});

for (const phase of ['resize', 'upload', 'profile']) {
  for (const action of ['logout', 'switch']) {
    test(`${action} during ${phase} cannot apply A's cover or save under B's local key`, async () => {
      const { app, context, state, event } = setup();
      const gate = deferred(), seen = deferred();
      if (phase === 'resize') context.resizeImage = () => { seen.resolve(); return gate.promise; };
      if (phase === 'upload') context.Cloud.uploadMedia = () => { seen.resolve(); return gate.promise; };
      if (phase === 'profile') context.Cloud.registerMe = profile => {
        state.profiles.push({ uid: context.Cloud.me, profile: { ...profile } });
        seen.resolve();
        return gate.promise;
      };
      const uploading = app.uploadCover(event);
      await seen.promise;
      const saveCount = state.saves.length;
      app._entry++;
      state.uid = action === 'logout' ? null : 'B';
      app._authUid = state.uid;
      context.Cloud.me = state.uid;
      context.Store.key = action === 'logout' ? 'signed-out' : 'store-B';
      context.Store.state = { profile: { cover: 'B cover', coverUrl: 'B URL' }, workoutLog: [{ id: 'keep-B' }] };
      gate.resolve(phase === 'resize' ? imageData : phase === 'upload' ? uploadedUrl : true);
      assert.equal(await uploading, false);
      assert.equal(context.Store.state.profile.cover, 'B cover');
      assert.equal(context.Store.state.profile.coverUrl, 'B URL');
      assert.equal(state.saves.length, saveCount);
      assert.equal(state.profiles.some(record => record.uid !== 'A'), false);
      assert.equal(state.messages.some(message => /synced/i.test(message)), false);
    });
  }
}