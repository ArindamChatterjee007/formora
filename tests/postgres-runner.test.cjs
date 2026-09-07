'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspace = path.resolve(__dirname, '..');
const filename = path.join(workspace, 'scripts/verify-postgres-concurrency.cjs');
const source = fs.readFileSync(filename, 'utf8');
const root = '/tmp/fm-pg-Guard123';
const marker = path.join(root, '.fm-pg-owner.json');
const ownership = Object.freeze({ root, realpath: '/private' + root, dev: 42, ino: 123,
  runId: 'fixture-run-nonce', creatorPid: 234 });

function load(filesystem = new Proxy({}, { get() { throw new Error('Unexpected filesystem access during import'); } }), probe = '') {
  const moduleRecord = { exports: {} };
  const fixtureRequire = name => {
    if (name === 'node:fs') return filesystem;
    if (name === 'node:child_process') return { spawn() { throw new Error('Unit guards must never spawn'); } };
    assert.ok(['node:assert/strict', 'node:path', 'node:crypto', 'node:events'].includes(name));
    return require(name);
  };
  new vm.Script(source + '\n' + probe, { filename }).runInNewContext({
    require: fixtureRequire, module: moduleRecord, __filename: filename, __dirname: path.dirname(filename),
    process: { cwd: () => workspace, getuid: () => 501,
      env: new Proxy({}, { get() { throw new Error('Do not read inherited environment values'); } }) },
    console: { log() { throw new Error('Import must not run the checker'); } },
    setTimeout() { throw new Error('Import must not schedule background work'); },
    Buffer, JSON,
  }, { timeout: 1000 });
  return moduleRecord.exports;
}

function ownedFilesystem(overrides = {}) {
  return {
    lstatSync(target) {
      if (target === root) return {
        isDirectory: () => true, isSymbolicLink: () => false,
        uid: 501, mode: 0o40700, dev: 42, ino: 123, ...overrides.directory,
      };
      assert.equal(target, marker);
      return { isFile: () => true, isSymbolicLink: () => false, ...overrides.marker };
    },
    realpathSync(target) {
      assert.equal(target, root);
      return overrides.realpath || ownership.realpath;
    },
    readFileSync(target) {
      assert.equal(target, marker);
      return JSON.stringify(overrides.contents || ownership);
    },
  };
}

test('importing the checker performs no filesystem access, spawning or background work', () => {
  assert.deepEqual(Object.keys(load()).sort(),
    ['assertWorkspace', 'cleanEnvironment', 'connectionArgs', 'ownedDirectory', 'socketPath'].sort());
});

test('Stories uses the existing exact-file migration path and minimal synthetic bootstrap', () => {
  assert.match(source, /const SOURCES = \[[\s\S]*?'supabase\/story-interactions\.sql'\];/);
  assert.match(source, /const FIXTURES = \[[\s\S]*?'tests\/story-interactions\.test\.cjs', 'tests\/postgres-runner\.test\.cjs'\];/);
  assert.match(source, /CREATE TABLE public\.profiles\(uid text PRIMARY KEY, data jsonb NOT NULL DEFAULT '\{\}'::jsonb\)/);
  assert.match(source, /CREATE TABLE public\.messages\(id text PRIMARY KEY, from_uid text NOT NULL, to_uid text NOT NULL,\s*body text NOT NULL, ts timestamptz NOT NULL\)/);
  assert.match(source, /await this\.install\(filename, sql\);\s*this\.report\.appliedMigrations\.push\(\{ source: filename, sha256, transformations: \[\] \}\)/);
  assert.match(source, /proname ~ '\(\^\|_\)story\(_\|\$\)'/);
  assert.doesNotMatch(source, /proname LIKE '%story%'/);
});

test('the case plan preserves all ten legacy checks and labels sequential Stories checks honestly', () => {
  const plan = load(undefined, 'module.exports = CHECKS.map(({run,...definition}) => ({...definition,executable:typeof run === "function"}));');
  assert.deepEqual(Array.from(plan.slice(0, 10), entry => entry.id), ['reporter-replay', 'target-limit-two-reporters',
    'moderator-same-version', 'reporter-role-isolation', 'review-before-retention', 'hold-before-retention',
    'retention-before-review', 'billing-concurrent-and-serial-replay', 'billing-atomic-rollback', 'push-contended-new-dispatch-budget']);
  assert.equal(plan.slice(0, 10).filter(entry => entry.mode === 'contention').length, 8);
  const stories = plan.filter(entry => entry.parent === 'story-interactions');
  assert.equal(stories.length, 10);
  assert.equal(stories.filter(entry => entry.mode === 'contention').length, 9);
  assert.equal(stories.filter(entry => entry.mode === 'sequential').length, 1);
  assert.ok(stories.every(entry => entry.source === 'supabase/story-interactions.sql' && entry.executable));
  assert.deepEqual(Array.from(stories, entry => entry.id), ['story-roles-defaults-and-references', 'story-view-pair-different-requests',
    'story-like-reply-replay-and-conflict', 'story-actor-mixed-target-budget', 'story-recipient-budget-across-actors',
    'story-target-exhaustion-owner-access', 'story-notification-enqueue-caps', 'story-cleanup-after-ordinary-budget',
    'story-queued-invalidation', 'story-mutual-replies-sorted-locks']);
  assert.equal(new Set(plan.map(entry => entry.id)).size, plan.length);
});

test('Story fixture overrides only lower known integer ceilings without enabling policy', async () => {
  const { storyLimits } = load(undefined, 'module.exports = {storyLimits};');
  const statements = [];
  const cluster = { serviceFirst: { async query(sql) { statements.push(sql); } } };
  await storyLimits(cluster, { actor_minute: 2, actor_day: 2 });
  assert.deepEqual(statements, ['UPDATE public.story_settings SET actor_minute=2,actor_day=2']);
  for (const limits of [{ enabled: true }, { actor_minute: 101 }, { actor_day: 501 }, { actor_minute: 0 },
    { actor_minute: 1.5 }, { actor_minute: '2' }, { notification_per_minute: 21 }]) {
    await assert.rejects(storyLimits(cluster, limits));
  }
  assert.equal(statements.length, 1);
});

test('Story races delegate to the existing advisory-lock barrier and preserve per-race evidence', async () => {
  const { storyRace } = load(undefined, 'module.exports = {storyRace};');
  const first = {}, second = {}, context = { id: 'fixture-case', evidence: {} };
  const key = 'stories-v2:11111111-1111-4111-8111-111111111111';
  const cluster = {
    observer: { async value(sql) { assert.match(sql, /ORDER BY hashtextextended/); return key; } },
    async race(raceContext, holder, waiter, winnerSql, contenderSql, lockType, inspect) {
      assert.equal(holder, first);
      assert.equal(waiter, second);
      assert.equal(winnerSql, 'winner()');
      assert.equal(contenderSql, 'contender()');
      assert.equal(lockType, 'advisory');
      assert.equal(raceContext.advisoryKey, key);
      assert.equal(raceContext.id, 'fixture-case:fixture-race');
      raceContext.evidence.lock = { unitFixture: true };
      raceContext.evidence.beforeCommit = await inspect();
      return { winner: 1, contender: { value: 2 } };
    },
  };
  const result = await storyRace(cluster, context, 'fixture-race', first, second, 'winner()', 'contender()',
    [key.slice('stories-v2:'.length)], async () => ({ visible: 0 }));
  assert.equal(result.evidence, context.evidence.races[0]);
  assert.equal(result.evidence.beforeCommit.visible, 0);
  assert.equal(result.winner, 1);
  assert.equal(result.contender.value, 2);
});

test('the expanded runner retains fixed PostgreSQL version, resource bounds, lock proof and finally cleanup', () => {
  assert.match(source, /settings\.versionNumber, 170011/);
  assert.match(source, /shared_buffers=16MB -c max_connections=8/);
  assert.match(source, /this\.sqlConnections <= 8/);
  assert.match(source, /setTimeout\(cancel, 180000\)/);
  assert.match(source, /pg_blocking_pids\(/);
  assert.match(source, /FROM pg_locks/);
  assert.match(source, /LISTEN fm_probe/);
  assert.match(source, /finally \{\s*clearTimeout\(deadline\);\s*try \{ report\.cleanup = await cluster\.cleanup\(\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(|new PGlite\s*\(|brew services|postgres:\/\//);
});

test('child environment is a fixed allowlist, without PG credentials, services or inherited startup options', () => {
  const environment = load().cleanEnvironment(root);
  assert.deepEqual(Object.keys(environment).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);
  assert.equal(environment.HOME, root);
  assert.equal(environment.TMPDIR, root);
  assert.equal(environment.PATH, '/opt/homebrew/opt/postgresql@17/bin:/usr/bin:/bin');
  assert.equal(environment.LC_ALL, 'C');
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE',
    'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGSYSCONFDIR', 'DATABASE_URL', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']) {
    assert.equal(environment[name], undefined, name);
  }
});

test('socket pathname includes PostgreSQL suffix and is bounded to 107 bytes', () => {
  const { socketPath } = load();
  assert.equal(socketPath(root + '/s', 25432), root + '/s/.s.PGSQL.25432');
  const prefix = '/tmp/fm-pg-';
  const suffix = '/s/.s.PGSQL.25432';
  const longest = prefix + 'a'.repeat(107 - Buffer.byteLength(prefix + suffix)) + '/s';
  assert.equal(Buffer.byteLength(socketPath(longest, 25432)), 107);
  assert.throws(() => socketPath(longest.replace('/s', 'a/s'), 25432), /107 bytes/);
});

test('socket guard rejects TCP hosts, existing clusters, traversal, malformed paths and default ports', () => {
  const { socketPath } = load();
  for (const directory of ['localhost', '127.0.0.1', '::1', '/tmp', '/opt/homebrew/var/postgresql@17',
    root + '/../s', root + '/s/', root + '/s other', '/tmp/fm-pg-a/b/s', '/tmp/fm-pg-/s']) {
    assert.throws(() => socketPath(directory, 25432));
  }
  for (const port of [5432, 0, 19999, 60000, -1, 25432.5, '25432', NaN]) {
    assert.throws(() => socketPath(root + '/s', port));
  }
});

test('every SQL client pins host, nondefault port, fixture login, database and no-password/no-psqlrc flags', () => {
  const { connectionArgs } = load();
  for (const user of ['fixture_superuser', 'fixture_member', 'fixture_service']) {
    const args = Array.from(connectionArgs(root + '/s', 25432, user));
    assert.deepEqual(args, ['-X', '-w', '-q', '-A', '-t', '-h', root + '/s', '-p', '25432', '-U', user, '-d', 'postgres']);
  }
  for (const user of ['postgres', 'service_role', '', 'fixture_member -h localhost']) {
    assert.throws(() => connectionArgs(root + '/s', 25432, user), /fixture logins/);
  }
});

test('execution guard requires both the exact workspace root and the approved runner file', () => {
  const { assertWorkspace } = load({ realpathSync: target => target });
  assert.doesNotThrow(() => assertWorkspace(workspace, filename));
  assert.throws(() => assertWorkspace('/tmp', filename), /approved GymCoach/);
  assert.throws(() => assertWorkspace(workspace + '/scripts', filename), /approved GymCoach/);
  assert.throws(() => assertWorkspace(workspace, workspace + '/scripts/other.cjs'));
});

test('cleanup accepts only its matching private inode, owner, path and nonce marker', () => {
  assert.equal(load(ownedFilesystem()).ownedDirectory(ownership), root);
  assert.throws(() => load(ownedFilesystem()).ownedDirectory({ ...ownership, root: '/tmp' }));
  assert.throws(() => load(ownedFilesystem()).ownedDirectory({ ...ownership, root: '/opt/homebrew/var/postgresql@17' }));
});

test('cleanup fails closed on symlinks, permissive modes, foreign inode/owner or changed markers', () => {
  const mutations = [
    { directory: { isDirectory: () => false } },
    { directory: { isSymbolicLink: () => true } },
    { directory: { uid: 502 } },
    { directory: { mode: 0o40755 } },
    { directory: { ino: 999 } },
    { directory: { dev: 999 } },
    { realpath: '/private/tmp/other-cluster' },
    { marker: { isFile: () => false } },
    { marker: { isSymbolicLink: () => true } },
    { contents: { ...ownership, runId: 'someone-elses-run' } },
    { contents: { ...ownership, creatorPid: 999 } },
  ];
  for (const mutation of mutations) assert.throws(() => load(ownedFilesystem(mutation)).ownedDirectory(ownership));
});