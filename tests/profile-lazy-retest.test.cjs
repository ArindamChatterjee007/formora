'use strict';

// Independent retest of the lazily-loaded Profile screen (js/mod/profile.js + the js/app.js loader).
// Written from the source contract, not from the author's suite: it drives the real caller
// (App.renderTab('profile')), the real module, and the real budget files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseFragment } = require('parse5');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'js/mod/profile.js'), 'utf8');

function harness() {
  const injected = [], toasts = [], rendered = [];
  const controls = new Map();
  let markup = '', busy = null;

  const view = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      controls.clear();
      (function walk(node) {
        const attributes = Object.fromEntries((node.attrs || []).map(attribute => [attribute.name, attribute.value]));
        if (attributes.id && (node.tagName === 'input' || node.tagName === 'select')) {
          const chosen = (node.childNodes || []).find(child => (child.attrs || []).some(attribute => attribute.name === 'selected'));
          const fallback = chosen ? chosen.attrs.find(attribute => attribute.name === 'value') : null;
          controls.set(attributes.id, { id: attributes.id, type: attributes.type || 'text', value: attributes.value ?? (fallback ? fallback.value : '') });
        }
        for (const child of node.childNodes || []) walk(child);
      })(parseFragment(value));
    },
    contains: node => controls.get(node.id) === node,
    setAttribute(name, value) { if (name === 'aria-busy') busy = value; },
    removeAttribute(name) { if (name === 'aria-busy') busy = null; },
  };

  const session = { user: { id: 'member-a', email: 'a@example.test' }, uid: 'uid-a', cloud: null };
  const context = vm.createContext({
    window: { addEventListener() {} }, URL, console, setTimeout, clearTimeout, setInterval: () => 0,
    document: {
      currentScript: { src: 'https://formora.test/app/js/app.js?v=175' },
      baseURI: 'https://formora.test/app/',
      addEventListener() {},
      getElementById: id => (id === 'view-profile' ? view : controls.get(id) || null),
      createElement: () => ({ remove() { this.removed = true; } }),
      head: { appendChild: element => injected.push(element) },
    },
    Auth: { currentUser: () => session.user, isLoggedIn: () => !!session.user, load() {} },
    Store: { key: 'store-a', state: { profile: {} }, latestWeight: () => 70, save() {} },
    SupaAuth: { active: () => true, uid: () => session.uid, email: () => (session.user ? session.user.email : '') },
    Social: { render() {} },
  });
  vm.runInContext(`${appSource}\nglobalThis.app = App;`, context);

  const app = context.app;
  Object.assign(app, {
    _entry: 1, _authUid: session.uid, curTab: 'profile',
    toast: message => toasts.push(message),
    physiqueFigure: () => '<svg></svg>',
  });

  async function settle() {
    await app._profileLoad?.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
  }

  async function arrive({ real = false } = {}) {
    if (real) vm.runInContext(moduleSource, context);
    else context.window.AppProfile = {
      renderProfile(preserveDraft) {
        rendered.push({ receiver: this, preserveDraft });
        view.innerHTML = '<div class="profile-hero"></div>';
      },
    };
    injected.at(-1).onload();
    await settle();
  }

  function dressForRealRender(profile) {
    Object.assign(context, {
      Engine: { stats: () => ({}), bodyComp: () => ({}), streak: () => 0, getPhysique: () => ({}) },
      DIETS: { veg: 'Vegetarian', nonveg: 'Non-vegetarian' },
      Social: {
        render() {}, feed: () => [], crewList: () => [], avatar: () => '<span class="av"></span>',
        me: () => ({ level: 'Rookie' }), tierBadge: () => '<span class="tier-badge"></span>',
      },
    });
    context.Store.state.profile = profile;
  }

  return { app, context, view, controls, injected, toasts, rendered, session, settle, arrive, dressForRealRender, busy: () => busy };
}

test('Entering Profile through the real tab router defers the module, announces loading and never blocks the caller', async () => {
  const fixture = harness();
  assert.equal(fixture.context.window.AppProfile, undefined);

  assert.equal(fixture.app.renderTab('profile'), undefined);

  assert.equal(fixture.injected.length, 1);
  assert.equal(fixture.injected[0].src, 'https://formora.test/app/js/mod/profile.js?v=175');
  assert.equal(fixture.busy(), 'true');
  assert.match(fixture.view.innerHTML, /role="status"/);
  assert.equal(fixture.rendered.length, 0);

  await fixture.arrive();

  assert.equal(fixture.busy(), null);
  assert.deepEqual(fixture.rendered, [{ receiver: fixture.app, preserveDraft: true }]);
});

test('Repeat entries share one request and a warm Profile renders without any further network work', async () => {
  const fixture = harness();
  fixture.app.renderTab('profile');
  fixture.app.renderProfile();
  fixture.app.renderProfile(false);
  assert.equal(fixture.injected.length, 1, 'one in-flight request only');

  await fixture.arrive();
  assert.equal(fixture.rendered.length, 1, 'only the newest cold request paints');
  assert.equal(fixture.rendered[0].preserveDraft, false);

  fixture.app.renderTab('profile');
  assert.equal(fixture.rendered.length, 2, 'warm render is synchronous');
  assert.equal(fixture.injected.length, 1, 'the loader is cached, not re-requested');
  assert.equal(fixture.busy(), null, 'a warm render never announces loading');
});

test('A module that arrives after sign-out and sign-in as the same member (A to B to A) cannot paint', async () => {
  const fixture = harness();
  fixture.app.renderTab('profile');
  const placeholder = fixture.view.innerHTML;

  fixture.session.user = { id: 'member-b', email: 'b@example.test' };
  fixture.session.uid = 'uid-b';
  fixture.context.Store.key = 'store-b';
  fixture.app._entry++;                    // sign out
  fixture.session.user = { id: 'member-a', email: 'a@example.test' };
  fixture.session.uid = 'uid-a';
  fixture.context.Store.key = 'store-a';
  fixture.app._entry++;                    // the first member signs back in: same identity, new session

  await fixture.arrive();

  assert.equal(fixture.rendered.length, 0, 'the stale request is fenced by the session generation');
  assert.equal(fixture.view.innerHTML, placeholder);
  assert.deepEqual(fixture.toasts, []);
});

test('Leaving Profile before the module arrives leaves the destination screen untouched', async () => {
  const fixture = harness();
  fixture.app.renderTab('profile');
  fixture.app.curTab = 'coach';
  fixture.view.innerHTML = '<p>Coach screen</p>';

  await fixture.arrive();

  assert.equal(fixture.rendered.length, 0);
  assert.equal(fixture.view.innerHTML, '<p>Coach screen</p>');
});

test('A failed module presents an accessible retry, releases the request and can recover', async () => {
  const fixture = harness();
  fixture.app.renderTab('profile');
  fixture.injected[0].onerror();
  await fixture.settle();

  assert.match(fixture.view.innerHTML, /role="alert"/);
  assert.match(fixture.view.innerHTML, /onclick="App\.renderProfile\(\)"/);
  assert.equal(fixture.busy(), null);
  assert.equal(fixture.app._profileLoad, null, 'the failed promise is not cached');

  fixture.app.renderProfile();
  assert.equal(fixture.injected.length, 2);
  await fixture.arrive();
  assert.equal(fixture.rendered.length, 1);
});

test('A module that never executes is timed out, removed and retryable', async () => {
  const fixture = harness();
  const timers = [];
  fixture.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return 1; };
  fixture.context.clearTimeout = () => {};

  fixture.app.renderTab('profile');
  assert.equal(timers[0].delay, 10000);
  timers[0].callback();
  await fixture.settle();

  assert.equal(fixture.injected[0].removed, true);
  assert.equal(fixture.app._profileLoad, null);
  assert.match(fixture.view.innerHTML, /role="alert"/);
});

test('The real module rebuilds the screen, keeps an unsaved draft and drops it on an explicit reset', async () => {
  const fixture = harness();
  fixture.dressForRealRender({ name: 'Saved Name', dob: '1996-02-02', heightCm: 175, targetWeightKg: 71, gender: 'male', diet: 'veg', activityFactor: 1.55 });
  fixture.app.renderTab('profile');
  await fixture.arrive({ real: true });

  assert.equal(fixture.controls.get('p-name').value, 'Saved Name');
  assert.equal(fixture.controls.size, fixture.app._profileFieldIds.length, 'every draft-tracked field is rendered');
  assert.match(fixture.view.innerHTML, /onchange="App\.uploadCover\(event\)"/);
  assert.match(fixture.view.innerHTML, /onclick="App\.saveProfile\(\)"/);

  fixture.controls.get('p-name').value = 'Typed but not saved';
  fixture.app.renderProfile();                       // a re-render replaces every node
  assert.equal(fixture.controls.get('p-name').value, 'Typed but not saved');
  assert.equal(fixture.context.Store.state.profile.name, 'Saved Name', 'the draft is never written to storage');

  fixture.app.renderProfile(false);
  assert.equal(fixture.controls.get('p-name').value, 'Saved Name');
  assert.equal(fixture.app._profileDraft, null);
});

test('A draft captured before an account switch is discarded rather than restored into the next member form', async () => {
  const fixture = harness();
  fixture.dressForRealRender({ name: 'Member A', dob: '1996-02-02', heightCm: 175, targetWeightKg: 71, gender: 'male', diet: 'veg', activityFactor: 1.55 });
  fixture.app.renderTab('profile');
  await fixture.arrive({ real: true });

  fixture.controls.get('p-name').value = 'A private draft';
  fixture.app._captureProfileDraft();                // leaving the tab
  assert.equal(fixture.app._profileDraft.values['p-name'], 'A private draft');

  fixture.session.user = { id: 'member-b', email: 'b@example.test' };
  fixture.session.uid = 'uid-b';
  fixture.context.Store.key = 'store-b';
  fixture.context.Store.state.profile = { name: 'Member B', dob: '1990-03-03', heightCm: 160, targetWeightKg: 60, gender: 'female', diet: 'nonveg', activityFactor: 1.375 };
  fixture.app.renderProfile();

  assert.equal(fixture.controls.get('p-name').value, 'Member B');
  assert.equal(fixture.app._profileDraft, null, 'the previous member draft is cleared, not carried over');
});

test('Cover actions keep their public contract: a cold call loads the module, and an inactive cloud short-circuits before any request', async () => {
  const fixture = harness();
  fixture.context.Cloud = { active: () => false };
  assert.equal(await fixture.app.syncCover(), false);
  assert.equal(fixture.injected.length, 0, 'syncCover with no cloud costs no download');

  fixture.app.curTab = 'home';
  fixture.dressForRealRender({ name: 'Member A' });
  const resolvers = [];
  fixture.context.resizeImage = () => new Promise(resolve => resolvers.push(resolve));
  const upload = fixture.app.uploadCover({ target: { files: [{ name: 'cover.jpg' }] } });
  assert.equal(fixture.injected.length, 1, 'the file selection survives the cold start');

  await fixture.arrive({ real: true });
  assert.equal(resolvers.length, 1, 'the queued upload resumes once the module is present');
  resolvers[0]('data:image/jpeg;base64,Y292ZXI=');
  assert.equal(await upload, true);
  assert.equal(fixture.context.Store.state.profile.cover, 'data:image/jpeg;base64,Y292ZXI=');
});

test('The Profile implementation exists once, is never eager, and is what keeps the top-level JS gate green', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!html.includes('mod/profile.js'), 'index.html must not preload the module');
  for (const marker of ['Your fitness dashboard', 'ph-cover-edit', 'fm_cover_pending_']) {
    assert.ok(moduleSource.includes(marker), `${marker} lives in the module`);
    assert.ok(!appSource.includes(marker), `${marker} is not duplicated in js/app.js`);
  }
  for (const method of ['renderProfile', 'uploadCover', 'syncCover']) {
    assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(moduleSource), method);
    assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(appSource), `${method} keeps an App-level entry point`);
  }

  const eager = fs.readdirSync(path.join(root, 'js')).filter(file => file.endsWith('.js'))
    .reduce((total, file) => total + fs.statSync(path.join(root, 'js', file)).size, 0);
  const moduleBytes = fs.statSync(path.join(root, 'js/mod/profile.js')).size;
  assert.equal(eager, 439045);
  assert.ok(eager <= 440320, `${eager} exceeds the CI budget`);
  assert.ok(eager + moduleBytes > 440320, 'the extraction is what keeps the budget green');
});
