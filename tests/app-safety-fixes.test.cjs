'use strict';
/* Gate for the DEF-036 / DEF-037 / DEF-040 / DEF-044 fixes and the sign-in
   continuation guards. Everything runs against the real js/app.js and
  js/mod/social.js sources in isolated VM and offline Chromium contexts:
  no live services or real member data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const appSource = source('js/app.js');

function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function appContext(extra = {}) {
  const context = vm.createContext(Object.assign({
    window: {}, setTimeout, clearTimeout, console,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
  }, extra));
  vm.runInContext(appSource + '\nglobalThis.app = App;', context);
  context.app.renderProfile = () => {};
  context.app.enterApp = () => {};
  return context;
}

// ---------------------------------------------------------------- DEF-036

function avatarFixture() {
  const saves = [], alerts = [];
  const context = appContext({
    alert: message => alerts.push(message),
    Store: {
      key: 'store-A', state: { profile: { avatar: 'avatar-A' } },
      save() { saves.push({ key: this.key, avatar: this.state.profile.avatar }); },
    },
  });
  context.app._entry = 1;
  return { context, saves, alerts, app: context.app, Store: context.Store };
}

const pick = () => ({ target: { files: [{ name: 'pick.jpg', type: 'image/jpeg' }] } });

for (const boundary of ['logout', 'another account', 'a newer selection']) {
  test(`DEF-036: a delayed avatar resize is ignored after ${boundary}`, async () => {
    const { context, app, Store, saves, alerts } = avatarFixture();
    const first = pending();
    context.resizeImage = () => first.promise;
    app.uploadAvatar(pick());

    if (boundary === 'logout') { app._entry++; Store.state = { profile: { avatar: null } }; }
    else if (boundary === 'another account') { app._entry++; Store.key = 'store-B'; Store.state = { profile: { avatar: 'avatar-B' } }; }
    else { const second = pending(); context.resizeImage = () => second.promise; app.uploadAvatar(pick()); }

    first.resolve('data:image/jpeg;base64,QQ==');
    await first.promise;
    await Promise.resolve();

    assert.equal(saves.length, 0, 'A superseded resize must never write to storage');
    assert.deepEqual(alerts, [], 'A superseded resize must not raise an error to the current member');
    assert.notEqual(Store.state.profile.avatar, 'data:image/jpeg;base64,QQ==', 'The image belongs to the account that chose it');
  });
}

test('DEF-036 control: an uninterrupted avatar resize is still saved and rendered', async () => {
  const { context, app, Store, saves, alerts } = avatarFixture();
  const resize = pending();
  let rendered = 0;
  app.renderProfile = () => { rendered++; };
  context.resizeImage = () => resize.promise;
  app.uploadAvatar(pick());
  resize.resolve('data:image/jpeg;base64,QQ==');
  await resize.promise;
  await Promise.resolve();
  assert.equal(Store.state.profile.avatar, 'data:image/jpeg;base64,QQ==');
  assert.deepEqual(saves, [{ key: 'store-A', avatar: 'data:image/jpeg;base64,QQ==' }]);
  assert.equal(rendered, 1);
  assert.deepEqual(alerts, []);
});

test('DEF-036: the newest avatar selection is the one that is kept', async () => {
  const { context, app, Store } = avatarFixture();
  const stale = pending(), latest = pending();
  context.resizeImage = () => stale.promise;
  app.uploadAvatar(pick());
  context.resizeImage = () => latest.promise;
  app.uploadAvatar(pick());
  latest.resolve('data:image/jpeg;base64,TEFURVNU');
  await latest.promise;
  await Promise.resolve();
  stale.resolve('data:image/jpeg;base64,U1RBTEU=');
  await stale.promise;
  await Promise.resolve();
  assert.equal(Store.state.profile.avatar, 'data:image/jpeg;base64,TEFURVNU', 'A late earlier pick must not overwrite the newer one');
});

// ---------------------------------------------------------------- DEF-037

const ACCOUNT = { id: 'A', name: 'Member A', email: 'a@example.test' };
const ORIGINAL = JSON.stringify({ profile: { name: 'Member A' }, workoutLog: [{ date: '2026-09-05', volume: 1200 }] });

function backupFixture(options = {}) {
  const store = new Map([['gymcoach_v1_A', ORIGINAL]]);
  const failures = options.failWrites || [];
  const auth = {
    data: { accounts: [{ ...ACCOUNT }], currentUserId: 'A' },
    load() {}, save() {},
    setCurrent(id) { if (options.setCurrentThrows) throw new Error('QuotaExceededError'); this.data.currentUserId = id; },
  };
  const entered = [];
  const context = appContext({
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { if (failures.includes(key)) throw new Error('QuotaExceededError'); store.set(key, value); },
      removeItem: key => store.delete(key),
    },
    Auth: auth,
    SupaAuth: options.supaAuth,
  });
  context.app.enterApp = () => entered.push(true);
  context.app.toast = () => {};
  return { app: context.app, store, auth, entered, context };
}

const backup = overrides => JSON.stringify(Object.assign({ app: 'formora', v: 1, account: ACCOUNT, data: { profile: { name: 'Member A' } } }, overrides));

const rejections = [
  ['not JSON at all', 'not-json{', 'bad_backup_file'],
  ['a JSON array instead of an object', '[]', 'bad_backup_file'],
  ['a foreign export', backup({ app: 'other-app' }), 'bad_backup_file'],
  ['an unsupported version', backup({ v: 2 }), 'unsupported_backup_version'],
  ['a missing account', backup({ account: undefined }), 'bad_backup_account'],
  ['an account without an id', backup({ account: { email: 'a@example.test' } }), 'bad_backup_account'],
  ['scalar data', backup({ data: 1 }), 'bad_backup_data'],
  ['a string profile', backup({ data: { profile: 'Member A' } }), 'bad_backup_data'],
  ['a non-array weight log', backup({ data: { profile: {}, weightLog: { '0': 1 } } }), 'bad_backup_data'],
  ['a non-array workout log', backup({ data: { profile: {}, workoutLog: 'none' } }), 'bad_backup_data'],
  ['no recognisable records', backup({ data: { somethingElse: true } }), 'bad_backup_data'],
];

for (const [label, text, code] of rejections) {
  test(`DEF-037: ${label} is rejected before anything is written`, async () => {
    const { app, store, auth } = backupFixture();
    await assert.rejects(async () => app.importData(text), error => error.message === code, code);
    assert.equal(store.get('gymcoach_v1_A'), ORIGINAL, 'Existing logs must survive an invalid backup');
    assert.deepEqual(auth.data.accounts, [ACCOUNT]);
    assert.equal(auth.data.currentUserId, 'A');
    assert.notEqual(app._backupError({ message: code }), undefined);
    assert.match(app._backupError({ message: code }), /\w/);
  });
}

test('DEF-037: a signed-in cloud session is never swapped by an imported email', async () => {
  const supaAuth = { active: () => true, uid: () => 'uuid-current', email: () => 'current@example.test' };
  const { app, store, auth } = backupFixture({ supaAuth });
  await assert.rejects(() => app.importData(backup({})), error => error.message === 'backup_owner_mismatch');
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.deepEqual(auth.data.accounts, [ACCOUNT], 'A rejected import must not touch the authenticated account list');
  assert.equal(auth.data.currentUserId, 'A');
});

test('DEF-037: the signed-in member can still restore their own backup', async () => {
  const supaAuth = { active: () => true, uid: () => 'uuid-current', email: () => 'A@Example.test' };
  const { app, store, entered } = backupFixture({ supaAuth });
  await app.importData(backup({ data: { profile: { name: 'Restored' }, workoutLog: [] } }));
  assert.deepEqual(JSON.parse(store.get('gymcoach_v1_A')), { profile: { name: 'Restored' }, workoutLog: [] });
  assert.deepEqual(entered, [true]);
});

test('DEF-037: a signed-out device restores the existing format and only known keys', async () => {
  const { app, store, auth, entered } = backupFixture();
  await app.importData(backup({
    data: {
      profile: { name: 'Restored' }, weightLog: [{ date: '2026-09-01', kg: 80 }], workoutLog: [], foodLog: [], restDays: [],
      updatedAt: 7, unexpectedKey: { nested: true },
    },
  }));
  const restored = JSON.parse(store.get('gymcoach_v1_A'));
  assert.deepEqual(Object.keys(restored).sort(), ['foodLog', 'profile', 'restDays', 'updatedAt', 'weightLog', 'workoutLog']);
  assert.equal(restored.unexpectedKey, undefined, 'Unknown keys are not written into the saved account shape');
  assert.equal(restored.profile.name, 'Restored');
  assert.equal(auth.data.currentUserId, 'A');
  assert.deepEqual(entered, [true]);
});

test('DEF-037: a partial write is rolled back to the exact previous keys', async () => {
  const { app, store, auth } = backupFixture({ setCurrentThrows: true });
  await assert.rejects(() => app.importData(backup({ data: { profile: { name: 'Restored' } } })),
    error => error.message === 'backup_write_failed');
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL, 'The previous saved logs are put back byte for byte');
  assert.equal(store.size, 1, 'Rollback removes only what the import added; it never clears storage');
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
  assert.equal(auth.data.currentUserId, 'A');
});

test('DEF-037: a rolled back import of a new account leaves no orphan key', async () => {
  const { app, store } = backupFixture({ setCurrentThrows: true });
  const other = { id: 'B', name: 'Member B', email: 'b@example.test' };
  await assert.rejects(() => app.importData(backup({ account: other, data: { profile: { name: 'B' } } })));
  assert.equal(store.has('gymcoach_v1_B'), false, 'A key created only by the failed import is removed again');
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
});

test('DEF-037: a backup read that finishes after an account switch is discarded', async () => {
  const { app, store, auth, context } = backupFixture();
  const readers = [];
  context.FileReader = class {
    constructor() { readers.push(this); }
    readAsText() { this.result = backup({ data: { profile: { name: 'Restored' } } }); }
  };
  app._entry = 4;
  app.importFile({ target: { files: [{ name: 'backup.json' }] } });
  app._entry = 5;                     // the member logged out / switched while the file was read
  await readers[0].onload();
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL, 'A stale file read must not replace the current account');
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
});

test('DEF-037 control: a backup read that completes for the same account is applied', async () => {
  const { app, store, entered, context } = backupFixture();
  const readers = [];
  context.FileReader = class {
    constructor() { readers.push(this); }
    readAsText() { this.result = backup({ data: { profile: { name: 'Restored' } } }); }
  };
  app._entry = 4;
  app.importFile({ target: { files: [{ name: 'backup.json' }] } });
  await readers[0].onload();
  assert.equal(JSON.parse(store.get('gymcoach_v1_A')).profile.name, 'Restored');
  assert.deepEqual(entered, [true]);
});

const malformedBackups = [
  ['missing account email', { account: { id: 'A', name: 'Member A' } }, 'bad_backup_account'],
  ['invalid account email', { account: { ...ACCOUNT, email: 'not-an-email' } }, 'bad_backup_account'],
  ['missing account name', { account: { id: 'A', email: ACCOUNT.email } }, 'bad_backup_account'],
  ['object account name', { account: { ...ACCOUNT, name: {} } }, 'bad_backup_account'],
  ['unsafe account id', { account: { ...ACCOUNT, id: '../B' } }, 'bad_backup_account'],
  ['unbounded account id', { account: { ...ACCOUNT, id: 'A'.repeat(129) } }, 'bad_backup_account'],
  ['null workout', { data: { workoutLog: [null] } }],
  ['null weight', { data: { weightLog: [null] } }],
  ['null food day', { data: { foodLog: [null] } }],
  ['null rest day', { data: { restDays: [null] } }],
  ['missing workout date', { data: { workoutLog: [{ volume: 0 }] } }],
  ['impossible workout date', { data: { workoutLog: [{ date: '2026-02-30' }] } }],
  ['object workout date', { data: { workoutLog: [{ date: {} }] } }],
  ['scalar exercise list', { data: { workoutLog: [{ date: '2026-09-05', exercises: {} }] } }],
  ['null exercise', { data: { workoutLog: [{ date: '2026-09-05', exercises: [null] }] } }],
  ['scalar set list', { data: { workoutLog: [{ date: '2026-09-05', exercises: [{ id: 'squat', sets: 1 }] }] } }],
  ['null set', { data: { workoutLog: [{ date: '2026-09-05', exercises: [{ id: 'squat', sets: [null] }] }] } }],
  ['negative reps', { data: { workoutLog: [{ date: '2026-09-05', exercises: [{ id: 'squat', sets: [{ reps: -1, weight: 20 }] }] }] } }],
  ['unbounded reps', { data: { workoutLog: [{ date: '2026-09-05', exercises: [{ id: 'squat', sets: [{ reps: 1e9, weight: 20 }] }] }] } }],
  ['nonnumeric lifted weight', { data: { workoutLog: [{ date: '2026-09-05', exercises: [{ id: 'squat', sets: [{ reps: 10, weight: 'heavy' }] }] }] } }],
  ['negative volume', { data: { workoutLog: [{ date: '2026-09-05', volume: -1 }] } }],
  ['nonnumeric body weight', { data: { weightLog: [{ date: '2026-09-05', kg: 'heavy' }] } }],
  ['unbounded body weight', { data: { weightLog: [{ date: '2026-09-05', kg: 1e9 }] } }],
  ['null food item', { data: { foodLog: [{ date: '2026-09-05', items: [null] }] } }],
  ['negative food calories', { data: { foodLog: [{ date: '2026-09-05', items: [{ text: 'Meal', kcal: -1, protein: 0 }] }] } }],
  ['object profile name', { data: { profile: { name: {} } } }],
  ['unbounded profile height', { data: { profile: { heightCm: 1e9 } } }],
  ['null followed member', { data: { profile: { following: [null] } } }],
  ['null draft session', { data: { draftSession: { date: '2026-09-05', session: null }, profile: {} } }],
  ['null draft exercise', { data: { draftSession: { date: '2026-09-05', session: { split: 'push', items: [null] } }, profile: {} } }],
];

for (const [label, value, code = 'bad_backup_data'] of malformedBackups) {
  test(`adjacent backup shape: ${label} is rejected without writes`, async () => {
    const { app, store, auth, entered } = backupFixture();
    await assert.rejects(async () => app.importData(backup(value)), error => error.message === code);
    assert.deepEqual([...store], [['gymcoach_v1_A', ORIGINAL]]);
    assert.deepEqual(auth.data.accounts, [ACCOUNT]);
    assert.equal(auth.data.currentUserId, 'A');
    assert.deepEqual(entered, []);
  });
}

test('adjacent backup shape: sparse legacy records and empty optional lists remain restorable', async () => {
  for (const data of [
    { profile: {} },
    { workoutLog: [{ date: '2026-09-05', volume: 1200 }] },
    { workoutLog: [{ date: '2026-09-05', exercises: [] }], foodLog: [{ date: '2026-09-05', items: [] }] },
    { profile: { avatar: null, cover: null, targetWeightKg: null, following: [], autoFollowed: [], socials: {}, lookPhotos: {} }, draftSession: null },
    { profile: {}, draftSession: { date: '2026-09-05', session: { split: 'push', items: [{ selected: 'bench_press', options: ['bench_press'], sets: [{ reps: '10', weight: '22.5' }] }] } } },
  ]) {
    const { app, store, entered } = backupFixture();
    await app.importData(backup({ data }));
    const expected = structuredClone(data);
    for (const workout of expected.workoutLog || []) { workout.exercises ??= [];workout.volume ??= 0; }
    assert.deepEqual(JSON.parse(store.get('gymcoach_v1_A')), expected);
    assert.deepEqual(entered, [true]);
  }
});

test('adjacent backup shape: unsafe object keys are stripped at every depth', async () => {
  const { app, store, auth, context } = backupFixture();
  const text = '{"account":{"id":"A","name":"Member A","email":"a@example.test","__proto__":{"admin":true}},"data":{"profile":{"name":"Restored","__proto__":{"admin":true},"socials":{"constructor":{"prototype":{"admin":true}},"instagram":"member"}},"workoutLog":[]}}';
  await app.importData(text);
  assert.equal(JSON.stringify(auth.data.accounts).includes('__proto__'), false);
  assert.deepEqual(JSON.parse(store.get('gymcoach_v1_A')), { profile: { name: 'Restored', socials: { instagram: 'member' } }, workoutLog: [] });
  assert.equal(vm.runInContext('({}).admin', context), undefined);
});

const OTHER_ACCOUNT = { id: 'B', name: 'Member B', email: 'b@example.test' };
const OTHER_DATA = JSON.stringify({ profile: { name: 'Member B' }, workoutLog: [{ date: '2026-09-04', volume: 2400 }] });

for (const localCurrent of ['A', 'B']) {
  test(`adjacent backup owner: secure A ignores the file's B id with local current ${localCurrent}`, async () => {
    const supaAuth = { active: () => true, uid: () => 'secure-a', email: () => 'A@Example.test' };
    const { app, auth, store } = backupFixture({ supaAuth });
    auth.data.accounts.push({ ...OTHER_ACCOUNT });auth.data.currentUserId = localCurrent;
    auth.currentUser = () => auth.data.accounts.find(account => account.id === auth.data.currentUserId);
    auth.findByEmail = email => auth.data.accounts.find(account => account.email.toLowerCase() === email.toLowerCase());
    store.set('gymcoach_v1_B', OTHER_DATA);
    await app.importData(backup({ account: { ...ACCOUNT, id: 'B' }, data: { profile: { name: 'Restored A' } } }));
    assert.deepEqual(JSON.parse(store.get('gymcoach_v1_A')), { profile: { name: 'Restored A' } });
    assert.equal(store.get('gymcoach_v1_B'), OTHER_DATA);
    assert.equal(auth.data.currentUserId, 'A');
    assert.deepEqual(auth.data.accounts.map(account => [account.id, account.email]), [['A', ACCOUNT.email], ['B', OTHER_ACCOUNT.email]]);
  });
}

test('adjacent backup owner: secure restore never creates a file-selected local id', async () => {
  const supaAuth = { active: () => true, uid: () => 'secure-a', email: () => ACCOUNT.email };
  const { app, auth, store } = backupFixture({ supaAuth });
  await app.importData(backup({ account: { ...ACCOUNT, id: 'untrusted-new-id' } }));
  assert.equal(auth.data.currentUserId, 'A');
  assert.equal(auth.data.accounts.length, 1);
  assert.equal(auth.data.accounts[0].id, 'A');
  assert.equal(store.has('gymcoach_v1_untrusted-new-id'), false);
});

test('adjacent backup owner: secure restore without a trusted local owner is rejected', async () => {
  const supaAuth = { active: () => true, uid: () => 'secure-a', email: () => ACCOUNT.email };
  const { app, auth, store } = backupFixture({ supaAuth });
  auth.data.accounts = [{ ...OTHER_ACCOUNT }];auth.data.currentUserId = 'B';
  await assert.rejects(async () => app.importData(backup({})), /backup_owner_mismatch/);
  assert.deepEqual(auth.data.accounts, [OTHER_ACCOUNT]);
  assert.equal(auth.data.currentUserId, 'B');
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
});

for (const email of [ACCOUNT.email, 'new@example.test']) {
  test(`adjacent backup owner: local id collision for ${email} is rejected`, async () => {
    const { app, auth, store } = backupFixture();
    auth.data.accounts.push({ ...OTHER_ACCOUNT });store.set('gymcoach_v1_B', OTHER_DATA);
    await assert.rejects(async () => app.importData(backup({ account: { ...ACCOUNT, id: 'B', email } })), /backup_id_collision/);
    assert.deepEqual(auth.data.accounts, [ACCOUNT, OTHER_ACCOUNT]);
    assert.equal(auth.data.currentUserId, 'A');
    assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
    assert.equal(store.get('gymcoach_v1_B'), OTHER_DATA);
  });
}

test('adjacent backup owner: local restore preserves an existing email-to-id mapping', async () => {
  const { app, auth, store } = backupFixture();
  await app.importData(backup({ account: { ...ACCOUNT, id: 'older-device-id', email: 'A@Example.test' } }));
  assert.equal(auth.data.accounts.length, 1);
  assert.equal(auth.data.accounts[0].id, 'A');
  assert.equal(auth.data.currentUserId, 'A');
  assert.equal(store.has('gymcoach_v1_older-device-id'), false);
  assert.equal(JSON.parse(store.get('gymcoach_v1_A')).profile.name, 'Member A');
});

test('adjacent backup owner: an unclaimed but occupied storage key is not overwritten', async () => {
  const { app, auth, store } = backupFixture();
  store.set('gymcoach_v1_B', OTHER_DATA);
  await assert.rejects(async () => app.importData(backup({ account: OTHER_ACCOUNT })), /backup_id_collision/);
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
  assert.equal(store.get('gymcoach_v1_B'), OTHER_DATA);
});

function persistentBackupFixture() {
  const fixture = backupFixture();
  const { auth, store, context } = fixture;
  const authText = '  ' + JSON.stringify(auth.data) + '\n';
  store.set('gymcoach_auth', authText);
  auth.currentUser = () => auth.data.accounts.find(account => account.id === auth.data.currentUserId);
  auth.save = () => store.set('gymcoach_auth', JSON.stringify(auth.data));
  auth.setCurrent = id => { auth.data.currentUserId = id;auth.save(); };
  context.Store = { key: 'gymcoach_v1_A', state: JSON.parse(ORIGINAL), _syncReady: false };
  return { ...fixture, authText };
}

test('adjacent backup completion: restore stays pending until app entry finishes', async () => {
  const { app } = backupFixture(), entry = pending();
  app.enterApp = () => entry.promise;
  let settled = false;
  const restoring = Promise.resolve(app.importData(backup({}))).then(result => { settled = true;return result; });
  await Promise.resolve();
  const settledBeforeEntry = settled;
  entry.resolve(true);
  assert.equal(await restoring, true);
  assert.equal(settledBeforeEntry, false);
});

test('adjacent backup completion: rejected app entry rolls back persisted and in-memory data', async () => {
  const { app, auth, store, context, authText } = persistentBackupFixture(), entry = pending();
  const previousState = context.Store.state;
  entry.promise.catch(() => {});
  app.enterApp = () => {
    context.Store.state = JSON.parse(store.get('gymcoach_v1_A'));
    return entry.promise;
  };
  const restoring = app.importData(backup({ data: { profile: { name: 'Restored' } } }));
  entry.reject(new Error('Rendering failed'));
  await assert.rejects(async () => restoring, /backup_restore_failed/);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.equal(store.get('gymcoach_auth'), authText);
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
  assert.equal(auth.data.currentUserId, 'A');
  assert.equal(context.Store.state, previousState);
  assert.equal(context.Store.key, 'gymcoach_v1_A');
});

test('adjacent backup completion: explicit entry failure is not reported as success', async () => {
  const { app, store, auth, authText } = persistentBackupFixture();
  app.enterApp = async () => false;
  await assert.rejects(async () => app.importData(backup({})), /backup_restore_failed/);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.equal(store.get('gymcoach_auth'), authText);
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
});

test('adjacent backup completion: an Auth write failure restores exact persisted Auth bytes', async () => {
  const { app, auth, store, authText } = persistentBackupFixture();
  auth.setCurrent = id => { auth.data.currentUserId = id;auth.save();throw new Error('QuotaExceededError'); };
  await assert.rejects(async () => app.importData(backup({ data: { profile: { name: 'Restored' } } })), /backup_write_failed/);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.equal(store.get('gymcoach_auth'), authText);
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
});

test('adjacent backup completion: a failed new-account entry leaves no account or storage orphan', async () => {
  const { app, auth, store, context, authText } = persistentBackupFixture();
  const previousState = context.Store.state, entry = pending();
  entry.promise.catch(() => {});
  app.enterApp = () => { context.Store.key = 'gymcoach_v1_B';context.Store.state = { profile: { name: 'B' } };return entry.promise; };
  const restoring = app.importData(backup({ account: OTHER_ACCOUNT }));
  entry.reject(new Error('Rendering failed'));
  await assert.rejects(async () => restoring, /backup_restore_failed/);
  assert.equal(store.has('gymcoach_v1_B'), false);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.equal(store.get('gymcoach_auth'), authText);
  assert.deepEqual(auth.data.accounts, [ACCOUNT]);
  assert.equal(auth.data.currentUserId, 'A');
  assert.equal(context.Store.key, 'gymcoach_v1_A');
  assert.equal(context.Store.state, previousState);
});

function backupReaderFixture() {
  const fixture = backupFixture(), readers = [], alerts = [], toasts = [];
  fixture.context.alert = message => alerts.push(message);
  fixture.app.toast = message => toasts.push(message);
  fixture.context.FileReader = class {
    constructor() { readers.push(this); }
    readAsText() { this.result = backup({}); }
  };
  return { ...fixture, readers, alerts, toasts };
}

test('adjacent backup completion: file success feedback waits for completed app entry', async () => {
  const { app, readers, toasts, alerts } = backupReaderFixture(), entry = pending();
  app.enterApp = () => entry.promise;
  app.importFile({ target: { files: [{ name: 'backup.json', size: 100 }] } });
  const reading = readers[0].onload();
  await Promise.resolve();assert.deepEqual(toasts, []);
  entry.resolve(true);await reading;
  assert.deepEqual(alerts, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /restored/i);
});

test('adjacent backup completion: file handler catches asynchronous restore rejection', async () => {
  const { app, readers, alerts, toasts } = backupReaderFixture();
  const failure = Promise.reject(new Error('backup_restore_failed'));failure.catch(() => {});
  app.importData = () => failure;
  app.importFile({ target: { files: [{ name: 'backup.json', size: 100 }] } });
  await readers[0].onload();
  assert.deepEqual(toasts, []);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /restor|previous/i);
});

test('adjacent backup completion: oversized files are rejected before a FileReader is created', () => {
  const { app, readers, alerts, store } = backupReaderFixture();
  app.importFile({ target: { files: [{ name: 'backup.json', size: 10 * 1024 * 1024 + 1 }] } });
  assert.equal(readers.length, 0);
  assert.equal(alerts.length, 1);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
});

test('adjacent backup completion: file read failure reports an error without writes or success', () => {
  const { app, readers, alerts, toasts, store } = backupReaderFixture();
  app.importFile({ target: { files: [{ name: 'backup.json', size: 100 }] } });
  assert.equal(typeof readers[0].onerror, 'function');readers[0].onerror();
  assert.equal(alerts.length, 1);assert.deepEqual(toasts, []);
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);
});

test('adjacent backup completion: oversized direct input is rejected without writes', async () => {
  const { app, store } = backupFixture();
  await assert.rejects(async () => app.importData(' '.repeat(10 * 1024 * 1024 + 1)), /bad_backup_file/);
  assert.deepEqual([...store], [['gymcoach_v1_A', ORIGINAL]]);
});

test('adjacent backup completion: a later account switch survives rollback of the earlier restore', async () => {
  const { app, auth, store, context } = persistentBackupFixture(), entry = pending();
  auth.data.accounts.push({ ...OTHER_ACCOUNT });store.set('gymcoach_v1_B', OTHER_DATA);auth.save();
  app._entry = 3;
  app.enterApp = () => { app._entry++;context.Store.state = JSON.parse(store.get('gymcoach_v1_A'));return entry.promise; };
  const restoring = app.importData(backup({ data: { profile: { name: 'Restored A' } } }));
  app._entry++;auth.setCurrent('B');
  const currentState = JSON.parse(OTHER_DATA);context.Store.key = 'gymcoach_v1_B';context.Store.state = currentState;
  entry.resolve();
  await assert.rejects(() => restoring, /backup_restore_failed/);
  assert.equal(auth.data.currentUserId, 'B');assert.deepEqual(auth.data.accounts, [ACCOUNT, OTHER_ACCOUNT]);
  assert.equal(JSON.parse(store.get('gymcoach_auth')).currentUserId, 'B');
  assert.equal(store.get('gymcoach_v1_A'), ORIGINAL);assert.equal(store.get('gymcoach_v1_B'), OTHER_DATA);
  assert.equal(context.Store.key, 'gymcoach_v1_B');assert.equal(context.Store.state, currentState);assert.equal(app._entry, 5);
});

test('adjacent backup completion: overlapping restores cannot overwrite the active restore', async () => {
  const { app, store } = backupFixture(), entry = pending();
  app.enterApp = () => entry.promise;
  const restoring = app.importData(backup({ data: { profile: { name: 'First restore' } } }));
  await assert.rejects(() => app.importData(backup({ data: { profile: { name: 'Second restore' } } })), /backup_busy/);
  assert.equal(JSON.parse(store.get('gymcoach_v1_A')).profile.name, 'First restore');
  entry.resolve(true);assert.equal(await restoring, true);
  assert.equal(app._backupRestoring, false);
});

test('adjacent backup completion: a failed rollback never claims that old data was restored', async () => {
  const { app, context, store } = persistentBackupFixture();
  const write = context.localStorage.setItem;
  context.localStorage.setItem = (key, value) => {
    if (key === 'gymcoach_v1_A' && value === ORIGINAL) throw new Error('Storage unavailable');
    write(key, value);
  };
  app.enterApp = async () => false;
  await assert.rejects(() => app.importData(backup({ data: { profile: { name: 'Restored' } } })), /backup_rollback_failed/);
  assert.notEqual(store.get('gymcoach_v1_A'), ORIGINAL);
  assert.match(app._backupError(new Error('backup_rollback_failed')), /could not be fully restored/);
  assert.equal(app._backupRestoring, false);
});

// ---------------------------------------------------------------- DEF-044

function socialContext() {
  const context = vm.createContext({
    window: {}, setTimeout, clearTimeout, console,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Store: { state: { profile: {} } },
    esc: value => String(value == null ? '' : value),
  });
  vm.runInContext(source('js/mod/social.js') + '\nglobalThis.social = Social;', context);
  vm.runInContext(appSource + '\nglobalThis.app = App;', context);
  const social = context.social;
  social.cloudActive = () => true;
  social.storiesRow = () => '<!--stories-->';
  social.me = () => ({ verified: true, name: 'Member A' });
  social._rankFeed = list => list;
  social._canSeePost = () => true;
  social._cloudPost = post => post;
  social.postCard = post => `<article data-id="${post.id}"></article>`;
  return context;
}

test('DEF-044: a failed cold feed read offers recovery instead of claiming an empty account', () => {
  const context = socialContext();
  const social = context.social;
  social.resetSession();
  social.noteFeedRead(false);
  const body = social.feedBody();
  assert.match(body, /role="alert"/, 'The failure is announced, not silent');
  assert.match(body, /App\.retryFeed\(\)/, 'A reachable retry control is rendered');
  assert.doesNotMatch(body, /No posts yet/, 'An outage must never be reported as an empty account');
});

test('DEF-044: a feed that has not been read yet reports loading, not emptiness', () => {
  const context = socialContext();
  context.social.resetSession();
  assert.equal(context.social.feedReadState(), 'idle');
  const body = context.social.feedBody();
  assert.match(body, /role="status"/);
  assert.match(body, /Loading your feed/);
  assert.doesNotMatch(body, /No posts yet/);
});

test('DEF-044 control: a successful read with no posts still shows the empty state', () => {
  const context = socialContext();
  context.social.resetSession();
  context.social.noteFeedRead(true);
  assert.equal(context.social.feedReadState(), 'ready');
  assert.match(context.social.feedBody(), /No posts yet/);
});

test('DEF-044: posts already loaded stay on screen when a later read fails', () => {
  const context = socialContext();
  const social = context.social;
  social.resetSession();
  social.noteFeedRead(true);
  social.cloud.feed = [{ id: 'post-1' }, { id: 'post-2' }];
  social.noteFeedRead(false);
  const body = social.feedBody();
  assert.match(body, /data-id="post-1"/);
  assert.match(body, /data-id="post-2"/);
  assert.doesNotMatch(body, /could not be loaded/, 'A transient failure does not replace content that is already loaded');
});

function cloudReadContext(getImplementation) {
  const context = socialContext();
  context.Cloud = {
    me: 'uid-a',
    active: () => true,
    _get: getImplementation,
    _tick() { return this._get(); },
  };
  vm.runInContext('globalThis.Cloud = Cloud;', context);
  context.app._watchCloudReads();
  context.social.resetSession();
  return context;
}

test('DEF-044: the read outcome is recorded around Cloud._get, which cannot report it itself', async () => {
  let result = null;
  const context = cloudReadContext(() => Promise.resolve(result));
  assert.equal(await context.Cloud._get(), null);
  assert.equal(context.social.feedReadState(), 'error', 'A null shared-state read is a failure, not an empty feed');
  result = { posts: {}, users: {} };
  assert.deepEqual(await context.Cloud._get(), result);
  assert.equal(context.social.feedReadState(), 'ready');
});

test('DEF-044: a rejected read is recorded and still propagates to the caller', async () => {
  const context = cloudReadContext(() => Promise.reject(new Error('network')));
  await assert.rejects(() => context.Cloud._get(), /network/);
  assert.equal(context.social.feedReadState(), 'error');
});

test('DEF-044: retrying recovers the feed and never fakes a result', async () => {
  let ok = false;
  const context = cloudReadContext(() => Promise.resolve(ok ? { posts: {} } : null));
  await context.Cloud._get();
  assert.equal(context.social.feedReadState(), 'error');
  ok = true;
  await context.app.retryFeed();
  assert.equal(context.social.feedReadState(), 'ready');

  // a poll already in flight short-circuits the tick: the previous state must be reported back
  context.social.noteFeedRead(false);
  context.Cloud._tick = () => Promise.resolve();
  await context.app.retryFeed();
  assert.equal(context.social.feedReadState(), 'error', 'A retry that performed no read must not look successful');
});

test('adjacent feed retry: a rendering failure releases the retry guard and allows recovery', async () => {
  let reads = 0, renders = 0;
  const context = cloudReadContext(async () => { reads++;return { posts: {} }; });
  context.social.noteFeedRead(false);
  context.app._renderFeedIfActive = () => { if (renders++ === 0) throw new Error('Render failed'); };
  await context.app.retryFeed().catch(() => {});
  assert.equal(context.app._feedRetry, false);
  assert.equal(context.social.feedReadState(), 'error');
  await context.app.retryFeed();
  assert.equal(reads, 1);
  assert.equal(context.social.feedReadState(), 'ready');
});

test('adjacent feed retry: a rejected read releases the retry guard without faking success', async () => {
  const context = cloudReadContext(async () => { throw new Error('Offline'); });
  context.social.noteFeedRead(false);
  await context.app.retryFeed();
  assert.equal(context.app._feedRetry, false);
  assert.equal(context.social.feedReadState(), 'error');
});

function modalKeyboardFixture() {
  const listeners = new Map();
  let visible = false, focused;
  const control = inside => {
    const element = { isConnected: true, inside, closest: () => element, focus: () => { focused = element; } };
    return element;
  };
  const opener = control(false), staleOpener = control(false), field = control(true);
  const overlay = { classList: { contains: () => !visible }, contains: element => !!element?.inside };
  const card = { tabIndex: -1 };
  const context = appContext({ document: {
    body: {}, addEventListener: (name, listener) => listeners.set(name, listener),
    getElementById: id => id === 'modal' ? overlay : id === 'modal-card' ? card : null,
  } });
  const app = context.app;
  app._focusedEl = () => focused;
  app._labelModal = () => {};
  app._setBackgroundInert = () => {};
  app._modalFocusables = () => [field];
  app._modalOpener = staleOpener;
  app._bindModalA11y();
  return { app, opener, field, listeners, focused: () => focused, open: () => { visible = true;field.focus();app._syncModal(); }, close: () => { visible = false;app._syncModal(); } };
}

for (const key of ['Enter', ' ']) {
  test(`adjacent modal: ${JSON.stringify(key)} remembers the opener before a preferences-style immediate focus`, () => {
    const fixture = modalKeyboardFixture();
    fixture.opener.focus();
    fixture.listeners.get('keydown')({ key, target: fixture.opener });
    fixture.open();fixture.close();
    assert.equal(fixture.focused(), fixture.opener);
  });
}

test('adjacent modal: internal pointer and keyboard activation cannot replace the original opener', () => {
  const fixture = modalKeyboardFixture();
  fixture.listeners.get('pointerdown')({ target: fixture.opener });
  fixture.open();
  fixture.listeners.get('pointerdown')({ target: fixture.field });
  fixture.listeners.get('keydown')({ key: 'Enter', target: fixture.field });
  fixture.listeners.get('keydown')({ key: ' ', target: fixture.field });
  assert.equal(fixture.app._modalOpener, fixture.opener);
  fixture.close();assert.equal(fixture.focused(), fixture.opener);
});

async function offlineApp(testContext, viewport) {
  const browser = await require('playwright').chromium.launch({ headless: true });
  testContext.after(() => browser.close());
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const origin = 'http://127.0.0.1', pageErrors = [], blocked = [], routeErrors = [];
  await context.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { blocked.push(url.origin);await route.abort('blockedbyclient');return; }
      if (url.pathname.startsWith('/auth/v1/')) {
        await route.fulfill({ json: { access_token: 'offline-access', refresh_token: 'offline-refresh', expires_in: 3600, user: { id: 'offline-owner-a', email: ACCOUNT.email } } });return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const json = url.pathname.endsWith('/rpc/get_state') ? { users: {}, posts: {}, requests: {}, comments: {}, stories: {} }
          : url.pathname.endsWith('/entitlements') ? [{ uid: 'offline-owner-a', tier: 'free', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }] : [];
        await route.fulfill({ json });return;
      }
      const pathname = decodeURIComponent(url.pathname), file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      const allowed = pathname === '/' || /^\/(?:index\.html|version\.txt|manifest\.webmanifest|favicon\.ico)$/.test(pathname) || /^\/(?:js|css|assets|icons)\//.test(pathname);
      if (!allowed || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { await route.fulfill({ status: 404, body: '' });return; }
      let body = fs.readFileSync(file);
      if (pathname === '/js/config.js') body = Buffer.from(body.toString() + `\nObject.assign(window, {SUPABASE_URL:${JSON.stringify(origin)}, SUPABASE_ANON_KEY:'offline-public', USE_SUPABASE_AUTH:true, SERVER_MEASUREMENT:true, FORMORA_WEB_PUSH:false, GOOGLE_CLIENT_ID:'', GOOGLE_IOS_CLIENT_ID:'', POSTHOG_KEY:'', EMAILJS_PUBLIC_KEY:'', EMAILJS_SERVICE_ID:'', EMAILJS_TEMPLATE_ID:'', EMAIL_FN_URL:'', SHEETS_API:'', SOCIAL_API:'', PEXELS_KEY:''}); if(window.Currency)Object.assign(window.Currency,{ready:true,cur:'INR',rate:83,country:'IN'});`);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
      await route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body });
    } catch (error) { routeErrors.push(error.message);await route.abort().catch(() => {}); }
  });
  await context.addInitScript(({ account, other, otherData }) => {
    localStorage.setItem('formora_supa_session', JSON.stringify({ uid: 'offline-owner-a', email: account.email, access_token: 'offline-access', refresh_token: 'offline-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    localStorage.setItem('gymcoach_auth', JSON.stringify({ accounts: [account, other], currentUserId: account.id }));
    localStorage.setItem('gymcoach_v1_A', JSON.stringify({ profile: { name: account.name, email: account.email, username: 'offline_member', dob: '1995-03-28', gender: 'male', heightCm: 178, startWeightKg: 80, targetWeightKg: 75, activityFactor: 1.55, physique: 'lean_aesthetic', physiqueChosen: true, onboarded: true }, weightLog: [{ date: '2026-09-05', kg: 80 }], workoutLog: [], foodLog: [], restDays: [] }));
    localStorage.setItem('gymcoach_v1_B', otherData);localStorage.setItem('fm_dl_x', '1');
  }, { account: ACCOUNT, other: OTHER_ACCOUNT, otherData: OTHER_DATA });
  const page = await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('#app-shell:not(.hidden)').waitFor().catch(async error => {
    const boot = await page.evaluate(() => ({ authView: typeof App === 'undefined' ? null : App.authView, account: typeof Auth === 'undefined' ? null : Auth.data?.currentUserId, store: typeof Store === 'undefined' ? null : Store.key, screen: document.getElementById('auth-card')?.textContent.slice(0, 500) }));
    throw new Error(error.message + '\n' + JSON.stringify({ boot, pageErrors, routeErrors, blocked }));
  });
  await page.locator('#launch').waitFor({ state: 'detached' });
  return { page, pageErrors, blocked, routeErrors };
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`adjacent browser: real backup entry, all tabs and Preferences keyboard close at ${viewport.width}px`, { timeout: 60000 }, async testContext => {
    const { page, pageErrors, routeErrors } = await offlineApp(testContext, viewport);
    const result = await page.evaluate(async ({ account, otherData }) => {
      const storeKey = 'gymcoach_v1_A', before = localStorage.getItem(storeKey), authBefore = localStorage.getItem('gymcoach_auth');
      let rejected = false;
      try { await App.importData(JSON.stringify({ account, data: { workoutLog: [null] } })); }
      catch (error) { rejected = error.message === 'bad_backup_data'; }
      const unchanged = before === localStorage.getItem(storeKey) && authBefore === localStorage.getItem('gymcoach_auth');
      const data = JSON.parse(before);data.workoutLog = [{ date: todayISO(), volume: 1200 }];
      const restored = await App.importData(JSON.stringify({ app: 'formora', v: 1, account: { ...account, id: 'B' }, data }));
      const tabs = ['home', 'search', 'flex', 'coach', 'alerts', 'profile', 'overview', 'today', 'progress', 'nutrition'].map(tab => {
        try {
          App.goTab(tab);
          const view = document.querySelector('#wrap > .view.active');
          return { tab, rendered: !!view?.textContent.trim() };
        } catch (error) { return { tab, rendered: false, error: error.message }; }
      });
      return { rejected, unchanged, restored, tabs, owner: Auth.currentUser().id, store: Store.key, otherUnchanged: localStorage.getItem('gymcoach_v1_B') === otherData, uniqueIds: new Set(Auth.data.accounts.map(saved => saved.id)).size === Auth.data.accounts.length };
    }, { account: ACCOUNT, otherData: OTHER_DATA });
    assert.equal(result.rejected, true);assert.equal(result.unchanged, true);assert.equal(result.restored, true);
    assert.equal(result.owner, 'A');assert.equal(result.store, 'gymcoach_v1_A');assert.equal(result.otherUnchanged, true);assert.equal(result.uniqueIds, true);
    assert.deepEqual(result.tabs.filter(tab => !tab.rendered), []);
    await page.waitForFunction(() => typeof Charts !== 'undefined');
    await page.evaluate(() => App.goTab('profile'));
    const opener = page.locator('#view-profile button[onclick="Preferences.open()"]');
    for (const key of ['Enter', 'Space']) {
      await opener.focus();await opener.press(key);
      await page.waitForFunction(() => App._modalActive && document.getElementById('modal').contains(document.activeElement));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.getElementById('modal').classList.contains('hidden'));
      assert.equal(await opener.evaluate(element => document.activeElement === element), true, key + ' returns focus to Preferences');
    }
    await page.evaluate(() => { Store.state.workoutLog = [];App.goTab('today');App.startSession('push'); });
    await page.waitForFunction(() => !!Store.state.draftSession);
    const draft = await page.evaluate(async () => {
      const exported = JSON.stringify({ app: 'formora', v: 1, account: Auth.currentUser(), data: Store.state });
      const before = JSON.stringify(Store.state.draftSession);
      const restored = await App.importData(exported);
      App.session = null;App.goTab('today');
      return { restored, unchanged: JSON.stringify(Store.state.draftSession) === before, resumed: App.session?.items.length > 0 };
    });
    assert.deepEqual(draft, { restored: true, unchanged: true, resumed: true });
    assert.deepEqual(pageErrors, []);assert.deepEqual(routeErrors, []);
  });
}

// ---------------------------------------------------------------- DEF-040

const LABELLED_CONTROLS = [
  'a-email', 'a-pass',
  's-name', 's-email', 's-phone', 's-pass', 's-pass2',
  'd-gender', 'd-dob', 'd-h', 'd-w', 'd-tw', 'd-act', 'd-exp', 'd-diet', 'd-physique',
  'g-name', 'g-email', 'f-email', 'p-phone', 'o-code', 'my-code',
  'r-pass', 'r-pass2',
  'sp-subj', 'sp-msg',
  'p-username', 'p-bio', 'p-privacy',
  'p-name', 'p-dob', 'p-h', 'p-tw', 'p-gender', 'p-diet', 'p-act',
];

test('DEF-040: every audited authentication, onboarding, support and profile control has an associated label', () => {
  const passwordFields = ['a-pass', 's-pass', 's-pass2', 'r-pass', 'r-pass2'];
  const missing = LABELLED_CONTROLS.filter(id => {
    if (passwordFields.includes(id)) return !/<label for="\$\{id\}">/.test(appSource);
    return !appSource.includes(`<label for="${id}">`) && !appSource.includes(`aria-label="${id}"`);
  });
  assert.deepEqual(missing, [], 'Visible labels must point at their control id');
});

test('DEF-040: labels are not silently replaced by placeholders', () => {
  for (const id of ['p-name', 'sp-msg', 'd-dob']) {
    const association = new RegExp(`<label for="${id}">([^<]|<span[^>]*>[^<]*</span>)+</label>`);
    assert.match(appSource, association, `${id} keeps a visible label, not only a placeholder`);
  }
});

// ------------------------------------------------- sign-in continuation guards

function authContext(options = {}) {
  const calls = { supabaseSignIn: [], loginWithGoogle: [], enterApp: [], authErr: [], signup: [] };
  const supaAuth = {
    active: () => true,
    uid: () => options.uid ?? 'uuid-a',
    email: () => options.signedInEmail ?? 'a@example.test',
    login: options.login || (() => Promise.resolve({})),
    signup: (...args) => { calls.signup.push(args); return (options.signup || (() => Promise.resolve({})))(...args); },
    signInWithGoogle: options.signInWithGoogle || (() => Promise.resolve({})),
  };
  const context = appContext({
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    SupaAuth: supaAuth,
    Auth: {
      findByEmail: () => options.local || null,
      validEmail: email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),
      login: () => Promise.resolve({}),
      supabaseSignIn: (...args) => calls.supabaseSignIn.push(args),
      loginWithGoogle: (...args) => calls.loginWithGoogle.push(args),
    },
    document: {
      addEventListener() {},
      querySelector: () => null,
      getElementById: id => ({ value: id === 'a-email' ? 'a@example.test' : 'Fixture-Only-Password42!' }),
    },
  });
  context.app.enterApp = () => { calls.enterApp.push(true); };
  context.app.authErr = message => calls.authErr.push(message);
  return { app: context.app, calls };
}

const googleCredential = email => ({
  credential: 'header.' + Buffer.from(JSON.stringify({ email, name: 'Member A' })).toString('base64') + '.signature',
});

test('sign-in guard: a login answered after a newer attempt does not enter the app', async () => {
  const reply = pending();
  const { app, calls } = authContext({ login: () => reply.promise });
  const signingIn = app.doLogin();
  app._beginAuthIntent('someone.else@example.test');   // a newer sign-in intent supersedes this one
  reply.resolve({});
  await signingIn;
  assert.deepEqual(calls.supabaseSignIn, []);
  assert.deepEqual(calls.enterApp, []);
  assert.deepEqual(calls.authErr, [], 'A superseded attempt is not reported as a bad password');
});

test('sign-in guard: a cancelled sign-in is not blamed on the password and creates nothing', async () => {
  const cancelled = Object.assign(new Error('changed'), { name: 'AbortError', code: 'AUTH_ATTEMPT_CANCELLED', cancelled: true });
  const { app, calls } = authContext({ login: () => Promise.reject(cancelled) });
  await app.doLogin();
  assert.deepEqual(calls.signup, [], 'An aborted attempt must never fall through to account creation');
  assert.deepEqual(calls.authErr, []);
  assert.deepEqual(calls.enterApp, []);
});

test('sign-in guard: a session for a different address is never adopted', async () => {
  const { app, calls } = authContext({ signedInEmail: 'someone.else@example.test' });
  await app.doLogin();
  assert.deepEqual(calls.supabaseSignIn, []);
  assert.deepEqual(calls.enterApp, []);
  assert.equal(calls.authErr.length, 1);
});

test('sign-in control: a normal login signs in the intended member', async () => {
  const { app, calls } = authContext();
  await app.doLogin();
  assert.equal(calls.supabaseSignIn.length, 1);
  assert.equal(calls.supabaseSignIn[0][0].email, 'a@example.test');
  assert.deepEqual(calls.enterApp, [true]);
  assert.deepEqual(calls.authErr, []);
});

test('sign-in guard: a late Google exchange cannot enter the app for the wrong member', async () => {
  const reply = pending();
  const { app, calls } = authContext({ signInWithGoogle: () => reply.promise });
  const signingIn = app.onGoogleCredential(googleCredential('a@example.test'));
  app._beginAuthIntent('someone.else@example.test');
  reply.resolve({});
  await signingIn;
  assert.deepEqual(calls.loginWithGoogle, []);
  assert.deepEqual(calls.enterApp, []);
});

test('sign-in guard: Google adopts the address the server verified, not the client claim', async () => {
  const { app, calls } = authContext({ signedInEmail: 'verified@example.test' });
  await app.onGoogleCredential(googleCredential('claimed@example.test'));
  assert.equal(calls.loginWithGoogle.length, 1);
  assert.equal(calls.loginWithGoogle[0][0].email, 'verified@example.test', 'Only the exchanged session decides the identity');
  assert.deepEqual(calls.enterApp, [true]);
});

test('sign-in guard: Google without an established session never signs anyone in', async () => {
  const { app, calls } = authContext({ uid: '' });
  await app.onGoogleCredential(googleCredential('a@example.test'));
  assert.deepEqual(calls.loginWithGoogle, []);
  assert.deepEqual(calls.enterApp, []);
  assert.equal(calls.authErr.length, 1);
});

test('sign-in control: Google sign-in uses the address the server confirmed', async () => {
  const { app, calls } = authContext();
  await app.onGoogleCredential(googleCredential('a@example.test'));
  assert.equal(calls.loginWithGoogle.length, 1);
  assert.equal(calls.loginWithGoogle[0][0].email, 'a@example.test');
  assert.deepEqual(calls.enterApp, [true]);
});

/* ---- DEF-063 (keyboard-reachable rows), DEF-067 (confirmed reset completes)
   and DEF-068 (programmatic selected/status state) -------------------------
   App-owned surfaces only. The post-author row (js/mod/social.js) and the feed
   Save toggle are the same defects in another owner's file and are not touched
   here. tests/profile-workflows.e2e.cjs proves the browser behaviour. */

function uiNode(id, attributes = {}) {
  return {
    id, textContent: '', innerHTML: '', dataset: {}, attributes: { ...attributes }, style: {},
    classList: {
      set: new Set(),
      add(...names) { names.forEach(name => this.set.add(name)); },
      remove(...names) { names.forEach(name => this.set.delete(name)); },
      contains(name) { return this.set.has(name); },
      toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); return on; },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { return child; },
  };
}

function uiContext(extra = {}) {
  const nodes = new Map(), selectors = [], created = [];
  const tabs = ['home', 'search', 'flex', 'coach', 'alerts', 'profile'].map(name => {
    const node = uiNode('tab-' + name);
    node.dataset.tab = name;
    return node;
  });
  const document = {
    addEventListener() {},
    body: uiNode('body'),
    getElementById: id => nodes.get(id) || null,
    querySelector(selector) { selectors.push(selector); return selector === '.wrap' ? uiNode('wrap') : null; },
    querySelectorAll(selector) { selectors.push(selector); return selector === '#tabbar .tab' ? tabs : []; },
    createElement() { const node = uiNode(''); created.push(node); return node; },
  };
  const context = vm.createContext(Object.assign({
    window: { scrollTo() {} }, setTimeout, clearTimeout, console, document,
  }, extra));
  vm.runInContext(appSource + '\nglobalThis.app = App;', context);
  const app = context.app;
  app.renderTab = () => {};
  app.renderChips = () => {};
  app.renderProfile = () => {};
  app.emptyState = () => '<div class="empty"></div>';
  return { app, context, nodes, tabs, selectors, created, document, node: uiNode };
}

test('DEF-063: Enter and Space activate a row button, other keys and nested controls do not', () => {
  const { app } = uiContext();
  const activations = [];
  const row = { click: () => activations.push('click') };
  for (const key of ['Enter', ' ', 'Spacebar']) {
    let prevented = 0;
    app.rowKey({ key, currentTarget: row, target: row, preventDefault: () => prevented++ });
    assert.equal(prevented, 1, key + ' must not also scroll or submit');
  }
  assert.deepEqual(activations, ['click', 'click', 'click'], 'Keyboard activation runs the same action as the pointer');

  activations.length = 0;
  for (const key of ['Tab', 'a', 'ArrowDown', 'Escape']) app.rowKey({ key, currentTarget: row, target: row, preventDefault() {} });
  assert.deepEqual(activations, [], 'Unrelated keys never activate the row');

  const nested = { closest: selector => (selector.includes('a,') ? { tag: 'A' } : null) };
  app.rowKey({ key: 'Enter', currentTarget: row, target: nested, preventDefault() {} });
  assert.deepEqual(activations, [], 'A key pressed on a nested link/button is left to that control');
  app.rowKey(null);
});

test('DEF-063: Alerts rows expose a button role, focus order and a keyboard handler', () => {
  const { app, nodes, context } = uiContext({
    window: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture-key' },
    Auth: { currentUser: () => ({ id: 'member-A' }) },
    Social: {
      cloud: { notifs: [{ id: 'alert-B', uid: 'member-A', actor: 'member-B', type: 'like', post_id: 'post-B', ts: Date.now(), read: false }] },
      avatar: () => '<span class="av"></span>',
      cloudUser: () => ({ name: 'Other member', colors: ['#111', '#222'] }),
      timeAgo: () => '2m',
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cloud.js'), 'utf8') + '\nCloud.me = "member-A";', context);
  const listeners = new Map(), opened = [];
  const row = { dataset: { notifId: 'alert-B' }, addEventListener: (name, handler) => listeners.set(name, handler), click: () => listeners.get('click')() };
  const list = uiNode('notif-list');
  list.querySelectorAll = selector => selector === '[data-notif-id]' ? [row] : [];
  nodes.set('notif-list', list);
  app.openNotif = id => opened.push(id);
  app.renderNotifPanel();

  assert.match(list.innerHTML, /class="notif-item[^"]*"/, 'The row keeps its existing layout class');
  assert.match(list.innerHTML, /role="button"/, 'The clickable row exposes an action role');
  assert.match(list.innerHTML, /tabindex="0"/, 'The row is in the normal focus order');
  assert.equal(typeof listeners.get('keydown'), 'function', 'The row has a bound keyboard handler');
  listeners.get('keydown')({ key: 'Enter', currentTarget: row, target: row, preventDefault() {} });
  assert.deepEqual(opened, ['alert-B'], 'The keyboard activates the exact displayed notification');
  assert.equal((list.innerHTML.match(/<a /g) || []).length, 0, 'No nested link is introduced inside the row button');
});

test('DEF-068: the selected tab is programmatically identified, not only coloured', () => {
  const { app, tabs } = uiContext();
  app.selectTab('profile');
  const marked = tabs.filter(tab => tab.getAttribute('aria-current'));
  assert.deepEqual(marked.map(tab => tab.dataset.tab), ['profile'], 'Exactly one tab is current');
  assert.equal(marked[0].getAttribute('aria-current'), 'page');
  assert.ok(marked[0].classList.contains('active'), 'The visual state still matches');

  app.selectTab('alerts');
  assert.deepEqual(tabs.filter(tab => tab.getAttribute('aria-current')).map(tab => tab.dataset.tab), ['alerts']);
  assert.equal(tabs.find(tab => tab.dataset.tab === 'profile').getAttribute('aria-current'), null, 'The previous tab drops the state');
  assert.ok(!tabs.some(tab => tab.getAttribute('aria-selected')), 'No tablist semantics are claimed by plain nav buttons');
});

test('DEF-068: toast results are announced politely instead of visually only', () => {
  const { app, nodes, created } = uiContext();
  app.toast('Saved');
  const toast = created.at(-1);
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.getAttribute('aria-live'), 'polite');
  assert.equal(toast.textContent, 'Saved');

  const existing = uiNode('toast');
  nodes.set('toast', existing);
  app.toast('Profile saved');
  assert.equal(existing.getAttribute('role'), 'status', 'An already-created toast is upgraded too');
  assert.equal(existing.getAttribute('aria-live'), 'polite');
  assert.equal(existing.textContent, 'Profile saved');
});

test('DEF-067: a confirmed reset clears data and lands on Today without a removed-tab click', () => {
  const resets = [], navigation = [], toasts = [];
  const { app, selectors } = uiContext({
    confirm: () => true,
    Store: { reset() { resets.push('reset'); }, state: { profile: {} } },
  });
  app.goTab = tab => navigation.push(tab);
  app.toast = message => toasts.push(message);
  app.curTab = 'profile';
  app.session = { items: [] };
  app._profileDraft = { owner: {}, values: { 'p-name': 'stale' } };

  app.resetAll();

  assert.deepEqual(resets, ['reset'], 'The confirmed erase still happens');
  assert.deepEqual(navigation, ['today'], 'Navigation goes through the current Coach/Today abstraction');
  assert.equal(app.session, null);
  assert.equal(app._profileDraft, null, 'The erased profile cannot be repopulated from a stale draft');
  assert.ok(!selectors.some(selector => selector.includes('data-tab="today"')), 'The removed top-level Today tab is never queried: ' + JSON.stringify(selectors));
  assert.equal(toasts.length, 1);
});

test('DEF-067 control: dismissing the confirmation changes nothing', () => {
  const resets = [], navigation = [];
  const { app } = uiContext({ confirm: () => false, Store: { reset() { resets.push('reset'); }, state: { profile: {} } } });
  app.goTab = tab => navigation.push(tab);
  app.toast = () => {};
  const draft = { owner: {}, values: {} };
  app._profileDraft = draft;
  app.session = { items: [] };

  app.resetAll();

  assert.deepEqual(resets, []);
  assert.deepEqual(navigation, []);
  assert.equal(app._profileDraft, draft, 'A cancelled reset keeps the unsaved draft');
  assert.ok(app.session, 'A cancelled reset keeps the open session');
});
