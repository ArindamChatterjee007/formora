'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse, parseFragment } = require('parse5');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const profileSource = fs.readFileSync(path.join(root, 'js/mod/profile.js'), 'utf8');

function fixture() {
  const scripts = [], renders = [], messages = [];
  const attributes = new Map(), fields = new Map();
  let markup = '';
  const view = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      fields.clear();
      function visit(node) {
        const attrs = Object.fromEntries((node.attrs || []).map(attribute => [attribute.name, attribute.value]));
        if (attrs.id && ['input', 'select'].includes(node.tagName)) {
          const selected = node.childNodes?.find(child => child.attrs?.some(attribute => attribute.name === 'selected'));
          fields.set(attrs.id, { id: attrs.id, value: attrs.value || selected?.attrs.find(attribute => attribute.name === 'value')?.value || '', type: attrs.type || 'text' });
        }
        for (const child of node.childNodes || []) visit(child);
      }
      visit(parseFragment(value));
    },
    contains: field => fields.get(field.id) === field,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const state = { user: { id: 'member-a', email: 'member-a@example.test' }, uid: 'owner-a' };
  const context = vm.createContext({
    window: { addEventListener() {} }, URL, console, setTimeout, clearTimeout, setInterval: () => 0,
    document: {
      currentScript: { src: 'https://example.test/formora/js/app.js?v=175' },
      baseURI: 'https://example.test/formora/',
      addEventListener() {},
      getElementById: id => id === 'view-profile' ? view : fields.get(id) || null,
      createElement: () => ({ remove() { this.removed = true; } }),
      head: { appendChild: script => scripts.push(script) },
    },
    Auth: { currentUser: () => state.user, load() {}, isLoggedIn: () => false },
    Store: { key: 'store-a', state: { profile: {} } },
    SupaAuth: { active: () => true, uid: () => state.uid, email: () => state.user?.email || '' },
    Social: { render() {} },
  });
  vm.runInContext(appSource + '\nglobalThis.app = App;', context);
  const app = context.app;
  Object.assign(app, { _entry: 1, _authUid: state.uid, curTab: 'profile', toast: message => messages.push(message) });
  async function settle() {
    await app._profileLoad?.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
  }
  async function loaded(real = false) {
    if (real) vm.runInContext(profileSource, context);
    else context.window.AppProfile = {
        renderProfile(preserveDraft) {
          renders.push({ receiver: this, preserveDraft });
          view.innerHTML = 'Profile loaded';
        },
      };
    scripts.at(-1).onload();
    await settle();
  }
  return { app, context, scripts, renders, messages, view, attributes, fields, state, loaded, settle };
}

test('Profile code is requested only on use and concurrent renders share one versioned script', async () => {
  const harness = fixture();
  for (const name of ['spawnParticles', 'applySky', 'guardImages', 'bindSwipe', '_bindModalA11y', '_watchCloudReads', 'showAuth']) harness.app[name] = () => {};
  harness.context.SupaAuth.active = () => false;
  harness.app.init();
  harness.app.renderTab('home');
  assert.equal(harness.scripts.length, 0);
  assert.equal(harness.context.window.AppProfile, undefined);
  assert.equal(harness.app.renderProfile(), undefined);
  assert.equal(harness.app.renderProfile(false), undefined);
  assert.equal(harness.scripts.length, 1);
  assert.equal(harness.scripts[0].src, 'https://example.test/formora/js/mod/profile.js?v=175');
  assert.equal(harness.attributes.get('aria-busy'), 'true');
  await harness.loaded();
  assert.equal(harness.renders.length, 1);
  assert.equal(harness.renders[0].receiver, harness.app);
  assert.equal(harness.renders[0].preserveDraft, false);
  assert.equal(harness.attributes.has('aria-busy'), false);
  assert.equal(harness.app.renderProfile(), undefined);
  assert.equal(harness.renders.length, 2);
  assert.equal(harness.scripts.length, 1);
});

for (const boundary of ['navigation', 'account', 'session', 'auth identity', 'view replacement']) {
  test(`A pending Profile load cannot render after ${boundary} changes`, async () => {
    const harness = fixture();
    harness.app.renderProfile();
    if (boundary === 'navigation') harness.app.curTab = 'home';
    if (boundary === 'account') {
      harness.state.user = { id: 'member-b' };
      harness.context.Store.key = 'store-b';
    }
    if (boundary === 'session') harness.app._entry++;
    if (boundary === 'auth identity') harness.state.uid = 'owner-b';
    if (boundary === 'view replacement') harness.context.document.getElementById = () => ({});
    await harness.loaded();
    assert.equal(harness.renders.length, 0);
  });
}

test('A failed Profile script presents an accessible retry and a later attempt can succeed', async () => {
  const harness = fixture();
  harness.app.renderProfile();
  harness.scripts[0].onerror();
  await harness.settle();
  assert.match(harness.view.innerHTML, /role="alert"/);
  assert.match(harness.view.innerHTML, /App\.renderProfile\(\)/);
  assert.equal(harness.attributes.has('aria-busy'), false);
  harness.app.renderProfile();
  assert.equal(harness.scripts.length, 2);
  await harness.loaded();
  assert.equal(harness.renders.length, 1);
});

for (const failure of ['timeout', 'missing module']) {
  test(`Profile ${failure} releases the failed request and permits retry`, async () => {
    const harness = fixture(), timers = [];
    harness.context.setTimeout = (callback, milliseconds) => {
      assert.equal(milliseconds, 10000);
      timers.push(callback);
      return 1;
    };
    harness.context.clearTimeout = () => {};
    harness.app.renderProfile();
    if (failure === 'timeout') timers[0]();
    else harness.scripts[0].onload();
    await harness.settle();
    assert.equal(harness.app._profileLoad, null);
    assert.equal(harness.scripts[0].removed, true);
    assert.match(harness.view.innerHTML, /role="alert"/);
    harness.app.renderProfile();
    await harness.loaded();
    assert.equal(harness.renders.length, 1);
  });
}

test('A failed load after logout does not replace the new screen with an error', async () => {
  const harness = fixture();
  harness.app.renderProfile();
  harness.app._entry++;
  harness.state.user = null;
  harness.view.innerHTML = 'Signed out';
  harness.scripts[0].onerror();
  await harness.settle();
  assert.equal(harness.view.innerHTML, 'Signed out');
  assert.equal(harness.messages.length, 0);
});

for (const tier of ['free', 'pro', 'elite']) {
  test(`The real lazy Profile renderer retains ${tier} access, handlers, labels and unsaved drafts`, async () => {
    const harness = fixture();
    Object.assign(harness.context, {
      Engine: { stats: () => ({}), bodyComp: () => ({}), streak: () => 0, getPhysique: () => ({}) },
      DIETS: { veg: 'Vegetarian' },
      Entitlements: { isPro: () => tier !== 'free', isElite: () => tier === 'elite', _e: { current_period_end: null } },
      Social: { feed: () => [], crewList: () => [], me: () => ({ level: 'Rookie' }), avatar: () => '', tierBadge: () => tier },
    });
    Object.assign(harness.context.Store, { latestWeight: () => 70, save() {} });
    harness.context.Store.state.profile = { name: 'Member <test>', dob: '1995-01-01', heightCm: 170, targetWeightKg: 72, diet: 'veg', gender: 'male', activityFactor: 1.55 };
    harness.app.physiqueFigure = () => '';
    harness.app.renderCheckoutDiagnostics = () => '';
    const originalApi = ['renderProfile', 'uploadCover', 'syncCover', 'saveProfile', 'saveSocialProfile', 'importData']
      .map(name => [name, harness.app[name]]);
    harness.app.renderProfile();
    await harness.loaded(true);
    assert.match(harness.view.innerHTML, /Member &lt;test&gt;/);
    assert.ok(harness.view.innerHTML.includes(`data-tier="${tier}"`));
    assert.match(harness.view.innerHTML, /aria-label="Log out"/);
    assert.match(harness.view.innerHTML, /label for="p-name"/);
    assert.match(harness.view.innerHTML, /onchange="App\.uploadCover\(event\)"/);
    assert.match(harness.view.innerHTML, /onclick="App\.exportData\(\)"/);
    assert.equal(harness.view.innerHTML.includes('class="card member-card"'), tier !== 'free');
    assert.doesNotMatch(harness.view.innerHTML, /access until/);
    assert.equal(harness.fields.size, harness.app._profileFieldIds.length);
    for (const [name, reference] of originalApi) assert.equal(harness.app[name], reference, name);
    harness.fields.get('p-name').value = 'Unsaved name';
    assert.equal(harness.app.renderProfile(), undefined);
    assert.equal(harness.fields.get('p-name').value, 'Unsaved name');
    assert.equal(harness.context.Store.state.profile.name, 'Member <test>');
    assert.equal(harness.app.renderProfile(false), undefined);
    assert.equal(harness.fields.get('p-name').value, 'Member <test>');
    assert.equal(harness.app._profileDraft, null);
  });
}

test('Cold cover calls preserve file selection and last-selection-wins ordering', async () => {
  const harness = fixture(), pending = [];
  harness.app.curTab = 'home';
  harness.context.Cloud = { active: () => false };
  harness.context.Store.save = () => {};
  harness.context.resizeImage = file => new Promise(resolve => pending.push({ file, resolve }));
  const firstFile = { name: 'first.jpg' }, secondFile = { name: 'second.jpg' };
  const event = { target: { files: [firstFile] } };
  const first = harness.app.uploadCover(event);
  event.target.files = [secondFile];
  const second = harness.app.uploadCover(event);
  event.target.files = [];
  assert.equal(harness.scripts.length, 1);
  assert.equal(pending.length, 0);
  await harness.loaded(true);
  assert.deepEqual(pending.map(item => item.file), [firstFile, secondFile]);
  pending[1].resolve('data:image/jpeg;base64,c2Vjb25k');
  assert.equal(await second, true);
  pending[0].resolve('data:image/jpeg;base64,Zmlyc3Q=');
  assert.equal(await first, false);
  assert.equal(harness.context.Store.state.profile.cover, 'data:image/jpeg;base64,c2Vjb25k');
});

for (const method of ['uploadCover', 'syncCover']) {
  test(`A cold ${method} cannot mutate a different account after its module arrives`, async () => {
    const harness = fixture();
    harness.context.Cloud = { active: () => true, me: 'owner-a' };
    const operation = harness.app[method]({ target: { files: [{ name: 'photo.jpg' }] } });
    assert.equal(harness.scripts.length, 1);
    harness.state.uid = 'owner-b';
    harness.state.user = { id: 'member-b' };
    harness.context.Store.key = 'store-b';
    harness.context.Store.state.profile = { cover: 'Keep this cover' };
    await harness.loaded(true);
    assert.equal(await operation, false);
    assert.equal(harness.context.Store.state.profile.cover, 'Keep this cover');
    assert.equal(harness.messages.length, 0);
  });
}

test('A failed cold cover load returns false and reports a retry without changing saved data', async () => {
  const harness = fixture();
  harness.context.Store.state.profile.cover = 'Keep this cover';
  const operation = harness.app.uploadCover({ target: { files: [{ name: 'photo.jpg' }] } });
  harness.scripts[0].onerror();
  assert.equal(await operation, false);
  assert.equal(harness.context.Store.state.profile.cover, 'Keep this cover');
  assert.match(harness.messages[0], /try again/i);
});

test('The unchanged top-level JS budget passes without eagerly loading the Profile module', () => {
  const document = parse(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  const references = [];
  function visit(node) {
    if (node.tagName === 'script' || node.tagName === 'link') {
      references.push(...(node.attrs || []).filter(attribute => ['src', 'href'].includes(attribute.name)).map(attribute => attribute.value));
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  assert.ok(!references.some(reference => reference.includes('js/mod/profile.js')));
  assert.ok(fs.statSync(path.join(root, 'js/mod/profile.js')).size >= 15 * 1024);
  const bytes = fs.readdirSync(path.join(root, 'js')).filter(file => file.endsWith('.js'))
    .reduce((total, file) => total + fs.statSync(path.join(root, 'js', file)).size, 0);
  assert.ok(bytes <= 430 * 1024, `${bytes} exceeds 440320 bytes`);
});