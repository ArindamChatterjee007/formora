'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

async function fixtureSeed(file, name) {
  const registered = new Map(), stopped = new Error('Stop before browser execution');
  const context = vm.createContext({
    require(module) {
      if (module === 'node:test') return { test: (title, callback) => registered.set(title, callback), before() {}, after() {} };
      if (module === 'playwright' || module === 'node:http') return {};
      assert.ok(['node:assert/strict', 'node:fs', 'node:path'].includes(module), 'Unexpected fixture dependency: ' + module);
      return require(module);
    },
    __dirname, URL, Buffer, structuredClone,
    fixtureOptions: null, fixtureState: {},
    fixturePage: { goto() { throw stopped; }, locator() { throw stopped; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8') + `
    setup = async (_test, options) => {
      fixtureOptions = options; fixtureState.uid = options.ownerUid;
      return { page: fixturePage, state: fixtureState };
    };`, context, { filename: file });
  const callback = registered.get(name);
  assert.equal(typeof callback, 'function', 'The original browser case remains registered');
  await assert.rejects(callback({}), error => error === stopped);
  return { options: context.fixtureOptions, state: context.fixtureState, source: callback.toString() };
}

function cloudFor(uid) {
  const cloud = vm.runInNewContext(fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8') + '\nCloud;', {
    window: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture', USE_SUPABASE_AUTH: true },
    SupaAuth: { active: () => true, uid: () => uid },
  });
  cloud.me = uid;
  return cloud;
}

test('secure notification fixtures cannot use legacy authenticated aliases', () => {
  assert.equal(cloudFor('member-A')._publishingUid(), null);
  assert.equal(cloudFor('member-B')._publishingUid(), null);
});

test('startup privacy case seeds a valid secure owner and an owned reference-only alert', async () => {
  const seed = await fixtureSeed('app-startup.e2e.cjs', 'private notifications clear at logout and late responses cannot enter the next account');
  const cloud = cloudFor(seed.options.ownerUid);
  assert.ok(cloud._publishingUid());
  const rows = cloud._notificationRows(seed.state.notifs);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].uid, cloud._publishingUid());
  assert.equal(Object.hasOwn(rows[0], 'body'), false);
  const unowned = { ...seed.state.notifs[0] };
  delete unowned.uid;
  assert.equal(cloud._notificationRows([unowned]), null);
});

test('keyboard Alerts case seeds a valid post target without replacing real notification actions', async () => {
  const seed = await fixtureSeed('profile-workflows.e2e.cjs', 'DEF-063: an Alerts row can be focused and activated from the keyboard');
  const cloud = cloudFor(seed.options.ownerUid), activity = seed.options.activity;
  assert.ok(cloud._publishingUid());
  const rows = cloud._notificationRows(activity.notifs);
  assert.equal(rows?.length, 1);
  assert.equal(rows[0].type, 'like');
  assert.equal(activity.posts[rows[0].post_id].author, cloud._publishingUid());
  assert.equal(activity.posts[rows[0].post_id].id, rows[0].post_id);
  assert.equal(activity.users[rows[0].actor].uid, rows[0].actor);
  assert.doesNotMatch(seed.source, /(?:App\.(?:pollNotifs|openNotif)|Social\.cloud\.(?:notifs|feed|users))\s*=/);
  assert.ok(seed.source.includes("page.keyboard.press('Enter')"));
  assert.ok(seed.source.includes("page.keyboard.press(' ')"));
});