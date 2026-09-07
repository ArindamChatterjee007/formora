'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createECDH, randomBytes, randomInt, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const WORKSPACE = path.resolve(__dirname, '..');
const BIN = '/opt/homebrew/opt/postgresql@17/bin';
const SOURCES = ['supabase/moderation-receipts.sql', 'supabase/moderation-lifecycle.sql',
  'supabase/billing-events.sql', 'supabase/push-subscriptions.sql', 'supabase/story-interactions.sql'];
const FIXTURES = ['tests/moderation-receipts.test.cjs', 'tests/moderation-lifecycle.test.cjs',
  'tests/billing-events.test.cjs', 'tests/push-delivery.test.cjs',
  'tests/story-interactions.test.cjs', 'tests/postgres-runner.test.cjs'];
const USERS = new Set(['fixture_superuser', 'fixture_member', 'fixture_service']);
const IDS = Object.freeze({
  reporter: '11111111-1111-4111-8111-111111111111',
  subject: '22222222-2222-4222-8222-222222222222',
  moderator: '33333333-3333-4333-8333-333333333333',
  other: '44444444-4444-4444-8444-444444444444',
  secondModerator: '55555555-5555-4555-8555-555555555555',
});

function cleanEnvironment(home) {
  return { PATH: `${BIN}:/usr/bin:/bin`, HOME: home, TMPDIR: home, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

function socketPath(directory, port) {
  assert.match(directory, /^\/tmp\/fm-pg-[A-Za-z0-9]+\/s$/);
  assert.ok(Number.isInteger(port) && port >= 20000 && port <= 59999 && port !== 5432);
  const filename = `${directory}/.s.PGSQL.${port}`;
  assert.ok(Buffer.byteLength(filename) <= 107, 'Unix socket pathname exceeds 107 bytes');
  return filename;
}

function connectionArgs(directory, port, user) {
  socketPath(directory, port);
  assert.ok(USERS.has(user), 'Only fixed synthetic fixture logins are permitted');
  return ['-X', '-w', '-q', '-A', '-t', '-h', directory, '-p', String(port), '-U', user, '-d', 'postgres'];
}

function assertWorkspace(cwd = process.cwd(), filename = __filename) {
  assert.equal(fs.realpathSync(cwd), WORKSPACE, 'Run from the explicitly approved GymCoach workspace');
  assert.equal(fs.realpathSync(filename), `${WORKSPACE}/scripts/verify-postgres-concurrency.cjs`);
}

function fingerprint() {
  const files = {};
  for (const filename of [...SOURCES, ...FIXTURES, 'scripts/verify-postgres-concurrency.cjs']) {
    const bytes = fs.readFileSync(path.join(WORKSPACE, filename));
    files[filename] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

function ownedDirectory(ownership) {
  assert.match(ownership.root, /^\/tmp\/fm-pg-[A-Za-z0-9]+$/);
  const info = fs.lstatSync(ownership.root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o700);
  assert.equal(info.dev, ownership.dev);
  assert.equal(info.ino, ownership.ino);
  assert.equal(fs.realpathSync(ownership.root), ownership.realpath);
  const marker = path.join(ownership.root, '.fm-pg-owner.json');
  assert.ok(fs.lstatSync(marker).isFile() && !fs.lstatSync(marker).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ownership);
  return ownership.root;
}

function sqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function errorDetails(error) {
  return { name: error.name, code: error.code || null, message: error.message, detail: error.detail || null };
}

class LocalCluster {
  constructor(report) {
    this.report = report;
    this.children = new Set();
    this.sessions = new Set();
    this.events = new EventEmitter();
    this.cancelled = false;
    this.started = false;
    this.root = null;
    this.port = randomInt(20000, 60000);
    this.sqlConnections = 0;
    this.peakConnections = 0;
    this.queryCount = 0;
    this.lockProbeCount = 0;
    this.notifications = [];
  }

  spawn(binary, args) {
    assert.ok(['initdb', 'postgres', 'pg_ctl', 'psql'].includes(binary));
    if (this.cancelled && binary !== 'pg_ctl') throw new Error('Run cancelled; cleanup required');
    const child = spawn(`${BIN}/${binary}`, args, {
      cwd: WORKSPACE, env: cleanEnvironment(this.root || '/tmp'), shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    if (binary === 'psql') {
      this.sqlConnections++;
      this.peakConnections = Math.max(this.peakConnections, this.sqlConnections);
      child.once('close', () => { this.sqlConnections--; });
      assert.ok(this.sqlConnections <= 8, 'Connection budget exceeded');
    }
    return child;
  }

  command(binary, args, input = '', timeout = 30000) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(binary, args);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeout);
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100000); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async setup() {
    this.report.executables = {};
    for (const binary of ['initdb', 'postgres', 'pg_ctl', 'psql']) {
      fs.accessSync(`${BIN}/${binary}`, fs.constants.X_OK);
      const resolved = fs.realpathSync(`${BIN}/${binary}`);
      assert.match(resolved, new RegExp(`^/opt/homebrew/Cellar/postgresql@17/17\\.11(?:_[0-9]+)?/bin/${binary}$`));
      const version = await this.command(binary, ['--version']);
      assert.equal(version.code, 0, version.stderr);
      assert.match(version.stdout, /\(PostgreSQL\) 17\.11(?:\s|$)/);
      this.report.executables[binary] = { path: `${BIN}/${binary}`, resolved, version: version.stdout };
    }
    this.root = fs.mkdtempSync('/tmp/fm-pg-');
    fs.chmodSync(this.root, 0o700);
    const info = fs.lstatSync(this.root);
    this.ownership = { root: this.root, realpath: fs.realpathSync(this.root), dev: info.dev, ino: info.ino,
      runId: this.report.runId, creatorPid: process.pid };
    fs.writeFileSync(path.join(this.root, '.fm-pg-owner.json'), JSON.stringify(this.ownership), { flag: 'wx', mode: 0o600 });
    this.data = path.join(this.root, 'data');
    this.socket = path.join(this.root, 's');
    fs.mkdirSync(this.socket, { mode: 0o700 });
    this.socketFile = socketPath(this.socket, this.port);
    this.report.cluster = { root: this.root, socketDirectory: this.socket, port: this.port,
      rootMode: '0700', socketDirectoryMode: '0700', authLocal: 'trust', authHost: 'reject',
      inheritedPgEnvironmentKeysRemoved: Object.keys(process.env).filter(key => /^PG/i.test(key)),
      childEnvironmentKeys: Object.keys(cleanEnvironment(this.root)), maxConnections: 8, sharedBuffers: '16MB' };
    const initialized = await this.command('initdb', ['-D', this.data, '-U', 'fixture_superuser',
      '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    assert.equal(initialized.code, 0, initialized.stderr);
    const options = `-h '' -k ${this.socket} -p ${this.port} -c unix_socket_permissions=0700` +
      ' -c shared_buffers=16MB -c max_connections=8 -c superuser_reserved_connections=0' +
      ' -c work_mem=1MB -c maintenance_work_mem=16MB -c max_wal_size=64MB -c min_wal_size=32MB' +
      ' -c autovacuum=off -c max_worker_processes=0 -c max_parallel_workers=0 -c jit=off' +
      ' -c ssl=off -c logging_collector=off -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000';
    this.report.cluster.startOptions = options;
    this.startAttempted = true;
    const started = await this.command('pg_ctl', ['-D', this.data, '-l', path.join(this.root, 'server.log'),
      'start', '-w', '-t', '20', '-o', options]);
    assert.equal(started.code, 0, started.stderr || started.stdout);
    this.started = true;
    this.postmasterPid = Number(fs.readFileSync(path.join(this.data, 'postmaster.pid'), 'utf8').split('\n')[0]);
    assert.ok(Number.isInteger(this.postmasterPid) && this.postmasterPid > 1);
    this.report.cluster.postmasterPid = this.postmasterPid;
    const baseline = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE ROLE fixture_member LOGIN NOINHERIT; GRANT authenticated TO fixture_member;
      CREATE ROLE fixture_service LOGIN NOINHERIT; GRANT service_role TO fixture_service;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fixture$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fixture$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES ('${IDS.reporter}'), ('${IDS.other}');
      CREATE TABLE public.posts(id text PRIMARY KEY, author text);
      CREATE TABLE public.comments(id text PRIMARY KEY, author text);
      CREATE TABLE public.profiles(uid text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb);
      CREATE TABLE public.messages(id text PRIMARY KEY, from_uid text NOT NULL, to_uid text NOT NULL,
        body text NOT NULL, ts timestamptz NOT NULL);
      CREATE TABLE public.entitlements (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, uid text NOT NULL UNIQUE,
        tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro','elite')),
        status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','trialing','canceled','inactive')),
        provider text, subscription_id text, current_period_end timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.billing_events (
        id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), uid text NOT NULL,
        type text NOT NULL, raw jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.entitlements TO authenticated;
      INSERT INTO public.posts VALUES ('post-1','${IDS.subject}');
      INSERT INTO public.comments VALUES ('comment-1','${IDS.subject}');
      INSERT INTO public.profiles(uid) VALUES ('${IDS.subject}');`;
    await this.install('synthetic auth and content fixtures', baseline);
    this.report.appliedMigrations = [];
    for (const filename of SOURCES) {
      const sql = fs.readFileSync(path.join(WORKSPACE, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      assert.equal(sha256, this.report.sourceBefore.files[filename].sha256, 'Source changed before migration execution');
      await this.install(filename, sql);
      this.report.appliedMigrations.push({ source: filename, sha256, transformations: [] });
    }
    this.admin = await this.session('admin', 'fixture_superuser');
    this.observer = await this.session('observer', 'fixture_superuser');
    await this.observer.query('SET default_transaction_read_only = on');
    await this.observer.query('LISTEN fm_probe');
    this.first = await this.session('member_a', 'fixture_member');
    this.second = await this.session('member_b', 'fixture_member');
    await this.first.identity(IDS.reporter);
    await this.second.identity(IDS.reporter);
    this.serviceFirst = await this.session('service_a', 'fixture_service');
    this.serviceSecond = await this.session('service_b', 'fixture_service');
    await this.serviceFirst.identity(null, 'service_role');
    await this.serviceSecond.identity(null, 'service_role');
    await this.admin.query(`INSERT INTO report_moderators(uid) VALUES ('${IDS.moderator}'), ('${IDS.secondModerator}')`);
    const settings = await this.observer.value(`jsonb_build_object('version', current_setting('server_version'),
      'versionNumber', current_setting('server_version_num')::int, 'listenAddresses', current_setting('listen_addresses'),
      'socketDirectories', current_setting('unix_socket_directories'), 'socketPermissions', current_setting('unix_socket_permissions'),
      'clientAddress', inet_client_addr(), 'serverAddress', inet_server_addr(), 'maxConnections', current_setting('max_connections')::int,
      'sharedBuffers', current_setting('shared_buffers'), 'database', current_database())`);
    assert.equal(settings.versionNumber, 170011);
    assert.equal(settings.listenAddresses, '');
    assert.equal(settings.socketDirectories, this.socket);
    assert.equal(settings.socketPermissions, '0700');
    assert.equal(settings.clientAddress, null);
    assert.equal(settings.serverAddress, null);
    assert.equal(settings.maxConnections, 8);
    assert.equal(settings.sharedBuffers, '16MB');
    assert.equal(fs.lstatSync(this.socket).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(this.data).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(this.socketFile).mode & 0o777, 0o700);
    const hba = await this.observer.value(`(SELECT jsonb_agg(jsonb_build_object('type', type, 'authMethod', auth_method, 'error', error)) FROM pg_hba_file_rules)`);
    assert.ok(hba.length > 0 && hba.every(rule => !rule.error && rule.authMethod === (rule.type === 'local' ? 'trust' : 'reject')));
    this.report.transport = { ...settings, hba, networkConnectionsAttempted: 0, unixSocketOnly: true };
    const hash = await this.observer.value("encode(pg_catalog.sha256(convert_to('fixture-native-sha256', 'UTF8')), 'hex')");
    assert.equal(hash, createHash('sha256').update('fixture-native-sha256').digest('hex'));
    this.report.hashSupport = { function: 'pg_catalog.sha256(bytea)', nativeHashVerified: true, extensionInstalledByRunner: false,
      pgcrypto: await this.observer.value("(SELECT jsonb_build_object('availableVersion', default_version, 'installedVersion', installed_version) FROM pg_available_extensions WHERE name = 'pgcrypto')") };
    this.report.fixtureBoundaries = { roles: 'Synthetic auth.uid() claim GUC; no token validation, GoTrue or PostgREST',
      schema: 'Only known fixture tables and the five unmodified source migrations',
      policies: 'Default disabled policies enabled only by explicit synthetic cases in this newly initialized cluster',
      network: 'No fetch, HTTP, TCP connection, provider SDK, hosted database or user configuration read' };
  }

  async install(source, sql) {
    const result = await this.command('psql', [...connectionArgs(this.socket, this.port, 'fixture_superuser'),
      '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], sql);
    if (result.code !== 0) {
      const error = new Error(`PostgreSQL fixture/migration failed: ${source}`);
      error.code = result.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
      error.detail = result.stderr;
      throw error;
    }
  }

  async session(name, user) {
    const session = new PsqlSession(this, name, user);
    this.sessions.add(session);
    session.pid = await session.value('pg_backend_pid()');
    await session.query(`SET application_name = ${sqlLiteral(`fm_${name}_${this.report.runId.slice(0, 8)}`)}`);
    return session;
  }

  async waitForLock(waiter, blocker, expectedType, advisoryKey) {
    const start = Date.now();
    let attempts = 0;
    const expectedKey = advisoryKey ? await this.observer.value(`jsonb_build_object(
      'classid', ((hashtextextended(${sqlLiteral(advisoryKey)}, 0) >> 32) & 4294967295)::text,
      'objid', (hashtextextended(${sqlLiteral(advisoryKey)}, 0) & 4294967295)::text, 'objsubid', 1)`) : null;
    while (Date.now() - start < 5000) {
      if (this.cancelled) throw new Error('Run cancelled');
      attempts++;
      this.lockProbeCount++;
      const state = await this.observer.value(`jsonb_build_object('waiterPid', ${waiter.pid}, 'blockerPid', ${blocker.pid},
        'blockers', pg_blocking_pids(${waiter.pid}), 'activity', (SELECT jsonb_build_object('state', state,
          'waitEventType', wait_event_type, 'waitEvent', wait_event) FROM pg_stat_activity WHERE pid=${waiter.pid}),
        'locks', (SELECT coalesce(jsonb_agg(jsonb_build_object('pid', pid, 'locktype', locktype, 'mode', mode,
          'granted', granted, 'classid', classid::text, 'objid', objid::text, 'objsubid', objsubid,
          'transactionid', transactionid::text, 'relation', relation::text, 'tuple', tuple)), '[]'::jsonb)
          FROM pg_locks WHERE pid IN (${waiter.pid}, ${blocker.pid}) AND locktype IN ('advisory','transactionid','tuple')))`);
      if (state.blockers.includes(blocker.pid) && state.activity?.waitEventType === 'Lock' &&
          state.locks.some(lock => lock.pid === waiter.pid && !lock.granted && lock.locktype === expectedType)) {
        const waiting = state.locks.find(lock => lock.pid === waiter.pid && !lock.granted && lock.locktype === expectedType);
        const matching = state.locks.some(lock => lock.pid === blocker.pid && lock.granted && lock.locktype === expectedType &&
          (expectedType === 'advisory' ? lock.classid === waiting.classid && lock.objid === waiting.objid && lock.objsubid === waiting.objsubid :
            lock.transactionid === waiting.transactionid));
        assert.equal(matching, true, 'The blocked backend must wait for the actual holder of the same lock');
        if (expectedKey) {
          assert.deepEqual({ classid: waiting.classid, objid: waiting.objid, objsubid: waiting.objsubid }, expectedKey);
        }
        return { ...state, advisoryKey: advisoryKey || null, expectedKey, attempts, elapsedMs: Date.now() - start };
      }
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          this.events.removeListener('cancel', finish);
          this.events.removeListener('notification', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(100, 10 * attempts));
        this.events.once('cancel', finish);
        this.events.once('notification', finish);
      });
    }
    throw new Error(`No ${expectedType} lock wait proved for backend ${waiter.pid} blocked by ${blocker.pid}`);
  }

  async race(context, first, second, firstSql, secondSql, expectedType, inspect) {
    let pending;
    try {
      await first.query('BEGIN');
      const winner = await first.value(firstSql);
      await second.value(`pg_notify('fm_probe', ${sqlLiteral(context.id)})`);
      pending = second.value(secondSql).then(value => ({ value }), error => ({ error: errorDetails(error) }));
      context.evidence.lock = await this.waitForLock(second, first, expectedType, context.advisoryKey);
      if (inspect) context.evidence.beforeCommit = await inspect();
      await first.query('COMMIT');
      const contender = await pending;
      context.evidence.winner = winner;
      context.evidence.contender = contender;
      return { winner, contender };
    } finally {
      if (!first.closed && !first.pending) await first.query('ROLLBACK').catch(() => {});
      if (pending) await pending;
    }
  }

  async cleanup() {
    const result = { stopAttempts: [], processStopped: !this.startAttempted, removedOwnedDirectory: false };
    this.report.cleanup = result;
    this.cleaning = true;
    for (const session of this.sessions) session.close();
    if (!this.root) return result;
    ownedDirectory(this.ownership);
    if (this.startAttempted) {
      if (!this.postmasterPid && fs.existsSync(path.join(this.data, 'postmaster.pid'))) {
        this.postmasterPid = Number(fs.readFileSync(path.join(this.data, 'postmaster.pid'), 'utf8').split('\n')[0]);
      }
      for (const mode of ['fast', 'immediate']) {
        const stopped = await this.command('pg_ctl', ['-D', this.data, 'stop', '-m', mode, '-w', '-t', '15']);
        result.stopAttempts.push({ mode, ...stopped });
        const status = await this.command('pg_ctl', ['-D', this.data, 'status']);
        result.status = status;
        if (status.code === 3) {
          result.processStopped = true;
          break;
        }
      }
      if (this.postmasterPid) {
        try { process.kill(this.postmasterPid, 0); result.postmasterAbsent = false; }
        catch (error) { if (error.code !== 'ESRCH') throw error; result.postmasterAbsent = true; }
        assert.equal(result.postmasterAbsent, true, 'Postmaster still exists; refusing directory removal');
      }
      assert.equal(result.processStopped, true, 'Cluster not confirmed stopped; refusing directory removal');
    }
    await Promise.all([...this.sessions].map(session => session.closedPromise));
    result.psqlChildrenClosed = [...this.sessions].every(session => session.closed);
    assert.equal(result.psqlChildrenClosed, true);
    result.socketAbsentAfterStop = !fs.existsSync(this.socketFile);
    assert.equal(result.socketAbsentAfterStop, true);
    ownedDirectory(this.ownership);
    fs.rmSync(this.root, { recursive: true, force: false });
    result.removedOwnedDirectory = !fs.existsSync(this.root);
    return result;
  }
}

class PsqlSession {
  constructor(cluster, name, user) {
    this.cluster = cluster;
    this.name = name;
    this.pending = null;
    this.closed = false;
    this.buffer = '';
    this.child = cluster.spawn('psql', [...connectionArgs(cluster.socket, cluster.port, user),
      '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose']);
    this.closedPromise = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (line.startsWith('Asynchronous notification')) {
          cluster.notifications.push({ session: name, line });
          cluster.events.emit('notification', line);
        } else if (this.pending && line.startsWith(this.pending.token + ' ')) {
          const operation = this.pending;
          this.pending = null;
          clearTimeout(operation.timer);
          const code = line.slice(operation.token.length + 1);
          if (code === '00000') operation.resolve(operation.lines);
          else {
            const error = new Error(`SQL failed in ${name}: ${code}`);
            error.code = code;
            error.detail = operation.stderr.trim();
            operation.reject(error);
          }
        } else if (this.pending && line) this.pending.lines.push(line);
      }
    });
    this.child.stderr.on('data', chunk => { if (this.pending) this.pending.stderr += chunk; });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => this.fail(error));
    this.child.once('close', (code, signal) => {
      this.closed = true;
      this.fail(new Error(`psql ${name} closed: ${code ?? signal}`));
    });
  }

  fail(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
  }

  query(sql) {
    assert.ok(!this.closed && !this.pending, `Session ${this.name} unavailable`);
    if (this.cluster.cancelled) return Promise.reject(new Error('Run cancelled'));
    this.cluster.queryCount++;
    return new Promise((resolve, reject) => {
      const token = 'FM_DONE_' + randomUUID().replaceAll('-', '');
      const timer = setTimeout(() => {
        this.fail(new Error(`SQL deadline exceeded in ${this.name}`));
        this.child.kill('SIGTERM');
      }, 20000);
      this.pending = { token, timer, resolve, reject, lines: [], stderr: '' };
      this.child.stdin.write(`${sql};\n\\echo ${token} :SQLSTATE\n`);
    });
  }

  async value(expression) {
    const lines = await this.query(`SELECT jsonb_build_object('value', (${expression}))::text`);
    assert.equal(lines.length, 1, `Expected one JSON result from ${this.name}`);
    return JSON.parse(lines[0]).value;
  }

  async identity(uid, role = 'authenticated') {
    assert.ok(['authenticated', 'service_role'].includes(role));
    await this.query('RESET ROLE');
    await this.value(`set_config('request.jwt.claim.sub', ${sqlLiteral(uid || '')}, false)`);
    await this.query('SET ROLE ' + role);
  }

  close() {
    if (this.closed) return;
    this.child.stdin.end('ROLLBACK;\n\\q\n');
    this.child.kill('SIGTERM');
  }
}

function reportDestination(runId) {
  const directory = path.join(WORKSPACE, 'dist', 'postgres-concurrency');
  for (const component of [path.join(WORKSPACE, 'dist'), directory]) {
    if (!fs.existsSync(component)) fs.mkdirSync(component, { mode: 0o700 });
    const info = fs.lstatSync(component);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Report directory must not be a symlink');
  }
  return path.join(directory, `${runId}.json`);
}

function submitSql(request = randomUUID(), reason = 'Synthetic concurrency fixture') {
  return `public.submit_report('${request}', 'post', 'post-1', ${sqlLiteral(reason)})`;
}

function reviewSql(receipt, status, request = randomUUID()) {
  return `public.review_report('${receipt.id}', ${receipt.version}, '${status}', 'Synthetic evidence reviewed', '${request}')`;
}

async function expectSqlError(session, expression, code, operation = 'value') {
  assert.ok(['value', 'query'].includes(operation));
  let failure;
  try { await session[operation](expression); } catch (error) { failure = error; }
  assert.ok(failure, `Expected SQLSTATE ${code}`);
  assert.equal(failure.code, code, failure.detail || failure.message);
  return errorDetails(failure);
}

async function resetReports(cluster) {
  await cluster.admin.query('TRUNCATE public.report_evidence_holds, public.report_deletion_audit, public.report_case_actions, public.report_cases');
  await cluster.admin.query('UPDATE public.report_limits SET reporter_per_minute=100, reporter_per_day=1000, target_per_minute=100, target_per_day=1000');
  await cluster.first.identity(IDS.reporter);
  await cluster.second.identity(IDS.other);
}

async function reportState(cluster) {
  return cluster.observer.value(`jsonb_build_object('cases', (SELECT count(*)::int FROM report_cases),
    'actions', (SELECT count(*)::int FROM report_case_actions), 'holds', (SELECT count(*)::int FROM report_evidence_holds),
    'deletionAudits', (SELECT count(*)::int FROM report_deletion_audit),
    'case', (SELECT jsonb_build_object('id', id, 'status', status, 'version', version) FROM report_cases ORDER BY id LIMIT 1))`);
}

async function closedReport(cluster) {
  let receipt = await cluster.first.value(submitSql());
  await cluster.first.identity(IDS.moderator);
  for (const status of ['under_review', 'no_action', 'closed']) receipt = await cluster.first.value(reviewSql(receipt, status));
  await cluster.admin.query(`UPDATE report_cases SET updated_at=clock_timestamp()-interval '3 days' WHERE id='${receipt.id}'`);
  const cutoff = await cluster.observer.value("(clock_timestamp()-interval '2 days')::text");
  const policy = await cluster.serviceFirst.value(`public.configure_report_lifecycle(true, true, 1,
    'closed_updated_at', '${randomUUID()}', false, NULL)`);
  assert.equal(policy.execution_enabled, true);
  return { receipt, policy, purge: `public.purge_report_lifecycle('retention', ARRAY['${receipt.id}']::uuid[],
    ${sqlLiteral(cutoff)}::timestamptz, NULL, '{}'::text[], false)` };
}

function billingSql(eventId, uid, tier = 'pro', raw = { fixture: true }, date = '2026-01-02T12:00:00Z') {
  return `public.apply_billing_event('razorpay', ${sqlLiteral(eventId)}, ${sqlLiteral(uid)}, 'payment.captured',
    '${date}'::timestamptz, 'order_fixture', '${tier}', 'active', NULL, ${sqlLiteral(JSON.stringify(raw))}::jsonb)`;
}

function billingState(cluster, uid) {
  const owner = sqlLiteral(uid);
  return cluster.observer.value(`jsonb_build_object('receipts', (SELECT count(*)::int FROM billing_event_receipts WHERE uid=${owner}),
    'audits', (SELECT count(*)::int FROM billing_events WHERE uid=${owner}),
    'entitlement', (SELECT to_jsonb(entitlement) FROM entitlements AS entitlement WHERE uid=${owner}))`);
}

function publicKey() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return key.getPublicKey().toString('base64url');
}

const STORY_CAPS = Object.freeze({ actor_minute: 100, actor_day: 500, target_minute: 200, target_day: 2000,
  recipient_minute: 100, recipient_day: 1000, cleanup_minute: 10, cleanup_day: 100,
  notification_per_minute: 20, notification_per_day: 100,
  notification_actor_per_minute: 5, notification_actor_per_day: 20 });
const STORY_TABLES = ['story_settings', 'stories_v2', 'story_content', 'story_interactions', 'story_blocks',
  'story_notification_preferences', 'story_rate_limits', 'story_action_receipts', 'story_message_context',
  'story_notifications', 'story_notification_events', 'story_reports'];
const STORY_POLICY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function resetStories(cluster, enabled = true) {
  await cluster.admin.query('TRUNCATE ' + [...STORY_TABLES.filter(name => name !== 'story_settings'), 'messages']
    .map(name => 'public.' + name).join(', '));
  await cluster.admin.query(`INSERT INTO public.profiles(uid,data) VALUES ${Object.entries(IDS).map(([name, uid]) =>
    `('${uid}',${sqlLiteral(JSON.stringify({ name: 'Synthetic ' + name, username: 'fixture_' + name, privacy: 'public' }))}::jsonb)`
  ).join(',')} ON CONFLICT (uid) DO UPDATE SET data=excluded.data`);
  await cluster.serviceFirst.query(`UPDATE public.story_settings SET enabled=${enabled}, permission_policy_approved=${enabled},
    media_audience_approved=${enabled}, public_media_approved=${enabled}, retention_approved=${enabled},
    operator_policy_ref=${enabled ? sqlLiteral(STORY_POLICY) : 'NULL'},
    media_origin=${enabled ? "'https://fixture.supabase.co'" : 'NULL'}, public_bucket=${enabled ? "'media'" : 'NULL'},
    ${Object.entries(STORY_CAPS).map(([name, maximum]) => `${name}=${maximum}`).join(',')}`);
  if (enabled) await cluster.admin.query(`INSERT INTO public.story_notification_preferences(uid,likes,replies,reply_permission)
    SELECT uid::uuid,true,true,'authenticated' FROM public.profiles WHERE uid IN (${Object.values(IDS).map(sqlLiteral).join(',')})`);
  await cluster.first.identity(IDS.reporter);
  await cluster.second.identity(IDS.other);
}

async function storyLimits(cluster, limits) {
  for (const [name, value] of Object.entries(limits)) {
    assert.ok(Object.hasOwn(STORY_CAPS, name), 'Only known synthetic Story limits may change');
    assert.ok(Number.isInteger(value) && value >= 1 && value <= STORY_CAPS[name], 'Only lower bounded fixture limits are permitted');
  }
  await cluster.serviceFirst.query('UPDATE public.story_settings SET ' +
    Object.entries(limits).map(([name, value]) => `${name}=${value}`).join(','));
}

async function seedStory(cluster, owner = IDS.subject) {
  const id = randomUUID();
  await cluster.admin.query(`INSERT INTO public.stories_v2(id,owner,kind,audience,created_at,expires_at)
    VALUES ('${id}','${owner}','photo','authenticated',statement_timestamp(),statement_timestamp()+interval '24 hours')`);
  await cluster.admin.query(`INSERT INTO public.story_content VALUES
    ('${id}','https://fixture.supabase.co/storage/v1/object/public/media/stories/${owner}/fixture.jpg')`);
  return id;
}

function storyViewSql(id, request = randomUUID()) {
  return `public.record_story_view(${sqlLiteral(id)},${sqlLiteral(request)})`;
}

function storyLikeSql(id, desired = true, request = randomUUID()) {
  return `public.set_story_like(${sqlLiteral(id)},${desired},${sqlLiteral(request)})`;
}

function storyReplySql(id, text = 'Synthetic reply', request = randomUUID()) {
  return `public.reply_to_story(${sqlLiteral(id)},${sqlLiteral(text)},${sqlLiteral(request)})`;
}

function storyDeleteSql(id, request = randomUUID()) {
  return `public.delete_story(${sqlLiteral(id)},${sqlLiteral(request)})`;
}

function storyState(cluster) {
  return cluster.observer.value(`jsonb_build_object(
    'stories', (SELECT count(*)::int FROM public.stories_v2),
    'deleted', (SELECT count(*)::int FROM public.stories_v2 WHERE deleted_at IS NOT NULL),
    'interactions', (SELECT count(*)::int FROM public.story_interactions),
    'views', (SELECT count(*)::int FROM public.story_interactions WHERE qualified_at IS NOT NULL),
    'likes', (SELECT count(*)::int FROM public.story_interactions WHERE liked),
    'messages', (SELECT count(*)::int FROM public.messages),
    'contexts', (SELECT count(*)::int FROM public.story_message_context),
    'notifications', (SELECT count(*)::int FROM public.story_notifications),
    'events', (SELECT count(*)::int FROM public.story_notification_events),
    'enqueued', (SELECT count(*)::int FROM public.story_notification_events WHERE enqueued),
    'receipts', (SELECT count(*)::int FROM public.story_action_receipts),
    'blocks', (SELECT count(*)::int FROM public.story_blocks),
    'rates', (SELECT coalesce(jsonb_agg(jsonb_build_object('scope',scope,'subject',subject,
      'minute',minute_count,'day',day_count) ORDER BY scope,subject),'[]'::jsonb) FROM public.story_rate_limits))`);
}

function storyRate(state, scope, subject) {
  return state.rates.find(rate => rate.scope === scope && rate.subject === subject);
}

function storyLockKey(cluster, subjects) {
  return cluster.observer.value(`(SELECT 'stories-v2:' || subject::text FROM
    unnest(ARRAY[${subjects.map(sqlLiteral).join(',')}]::uuid[]) AS scopes(subject)
    ORDER BY hashtextextended('stories-v2:' || subject::text,0),subject LIMIT 1)`);
}

async function storyRace(cluster, context, label, first, second, firstSql, secondSql, sharedSubjects,
  inspect = () => storyState(cluster)) {
  const evidence = { label };
  (context.evidence.races ||= []).push(evidence);
  const raceContext = { id: context.id + ':' + label, evidence,
    advisoryKey: await storyLockKey(cluster, sharedSubjects) };
  return { ...await cluster.race(raceContext, first, second, firstSql, secondSql, 'advisory', inspect), evidence };
}

const CASES = [
  { id: 'reporter-replay', parent: 'moderation-receipts', source: SOURCES[0], function: 'public.submit_report',
    control: 'Same reporter and request ID serialize to one case and identical receipts',
    async run(cluster, context) {
      await resetReports(cluster);
      await cluster.second.identity(IDS.reporter);
      const submit = submitSql();
      context.advisoryKey = 'report:' + IDS.reporter;
      const { winner, contender } = await cluster.race(context, cluster.first, cluster.second, submit, submit, 'advisory', () => reportState(cluster));
      assert.equal(context.evidence.beforeCommit.cases, 0);
      assert.equal(contender.error, undefined);
      assert.deepEqual(contender.value, winner);
      const receipts = await cluster.first.value('public.my_report_receipts()');
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].id, winner.id);
      context.evidence.afterCommit = await reportState(cluster);
      assert.equal(context.evidence.afterCommit.cases, 1);
      assert.equal(context.evidence.afterCommit.actions, 0);
    } },
  { id: 'target-limit-two-reporters', parent: 'moderation-receipts', source: SOURCES[0], function: 'public.submit_report',
    control: 'Cross-reporter target limit one is checked under the target lock',
    async run(cluster, context) {
      await resetReports(cluster);
      await cluster.admin.query('UPDATE public.report_limits SET target_per_minute=1');
      context.advisoryKey = 'report-target:post:post-1';
      const { winner, contender } = await cluster.race(context, cluster.first, cluster.second, submitSql(), submitSql(), 'advisory',
        () => cluster.observer.value(`jsonb_build_object('visibleCases', (SELECT count(*)::int FROM report_cases WHERE kind='post' AND target_id='post-1'),
          'configuredLimit', (SELECT target_per_minute FROM report_limits))`));
      assert.deepEqual(context.evidence.beforeCommit, { visibleCases: 0, configuredLimit: 1 });
      assert.equal(winner.status, 'received');
      assert.equal(contender.error?.code, 'PT429');
      context.evidence.afterCommit = await reportState(cluster);
      assert.equal(context.evidence.afterCommit.cases, 1);
      assert.equal(await cluster.observer.value('(SELECT count(*)::int FROM posts)'), 1);
    } },
  { id: 'moderator-same-version', parent: 'moderation-receipts', source: SOURCES[0], function: 'public.review_report',
    control: 'Two different moderators contend on the row; one version increment and one audit, loser PT409',
    async run(cluster, context) {
      await resetReports(cluster);
      const receipt = await cluster.first.value(submitSql());
      await cluster.first.identity(IDS.moderator);
      await cluster.second.identity(IDS.secondModerator);
      const firstDecision = reviewSql(receipt, 'under_review');
      const { winner, contender } = await cluster.race(context, cluster.first, cluster.second, firstDecision,
        reviewSql(receipt, 'under_review'), 'transactionid', () => reportState(cluster));
      assert.equal(context.evidence.beforeCommit.case.version, 1);
      assert.equal(context.evidence.beforeCommit.actions, 0);
      assert.equal(winner.version, 2);
      assert.equal(contender.error?.code, 'PT409');
      context.evidence.exactRetry = await cluster.first.value(firstDecision);
      assert.equal(context.evidence.exactRetry.duplicate, true);
      context.evidence.afterCommit = await reportState(cluster);
      assert.equal(context.evidence.afterCommit.case.version, 2);
      assert.equal(context.evidence.afterCommit.case.status, 'under_review');
      assert.equal(context.evidence.afterCommit.actions, 1);
      context.evidence.audit = await cluster.observer.value('(SELECT jsonb_build_object(\'actor\', actor, \'previousVersion\', previous_version) FROM report_case_actions)');
      assert.deepEqual(context.evidence.audit, { actor: IDS.moderator, previousVersion: 1 });
    } },
  { id: 'reporter-role-isolation', parent: 'moderation-receipts', source: SOURCES[0], function: 'public.my_report_receipts',
    mode: 'sequential',
    control: 'Separate non-superuser reporter connections cannot read each other or moderator-only data',
    async run(cluster, context) {
      await resetReports(cluster);
      const own = await cluster.first.value(submitSql());
      const other = await cluster.second.value(submitSql());
      context.evidence.roles = await cluster.first.value(`jsonb_build_object('currentUser', current_user, 'sessionUser', session_user,
        'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
        'bypassRls', (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user))`);
      assert.deepEqual(context.evidence.roles, { currentUser: 'authenticated', sessionUser: 'fixture_member', superuser: false, bypassRls: false });
      const ownReceipts = await cluster.first.value('public.my_report_receipts()');
      const otherReceipts = await cluster.second.value('public.my_report_receipts()');
      assert.deepEqual(ownReceipts.map(receipt => receipt.id), [own.id]);
      assert.deepEqual(otherReceipts.map(receipt => receipt.id), [other.id]);
      assert.notEqual(own.id, other.id);
      assert.ok(ownReceipts.every(receipt => !('reporter' in receipt) && !('reason' in receipt) && !('reported_uid' in receipt)));
      context.evidence.directReadDenied = await expectSqlError(cluster.first, `(SELECT count(*) FROM report_cases WHERE id='${other.id}')`, '42501');
      context.evidence.historyDenied = await expectSqlError(cluster.first, `public.report_decision_history('${other.id}', NULL)`, 'PT403');
      context.evidence.queueDenied = await expectSqlError(cluster.first, 'public.moderation_queue()', 'PT403');
      context.evidence.ownReceiptCounts = [ownReceipts.length, otherReceipts.length];
    } },
  { id: 'review-before-retention', parent: 'moderation-lifecycle', source: SOURCES[1], function: 'public.purge_report_lifecycle',
    control: 'Retention waits for review row lock, then rechecks closed_updated_at eligibility',
    async run(cluster, context) {
      await resetReports(cluster);
      const fixture = await closedReport(cluster);
      context.evidence.syntheticPolicy = fixture.policy;
      const { winner, contender } = await cluster.race(context, cluster.first, cluster.serviceFirst,
        reviewSql(fixture.receipt, 'under_review'), fixture.purge, 'transactionid', () => reportState(cluster));
      assert.equal(context.evidence.beforeCommit.case.status, 'closed');
      assert.equal(winner.version, 5);
      assert.equal(contender.error, undefined);
      assert.equal(contender.value.deleted_cases, 0);
      assert.equal(contender.value.eligible_cases, 0);
      assert.equal(contender.value.skipped_cases, 1);
      assert.equal(contender.value.audit_id, null);
      context.evidence.afterCommit = await reportState(cluster);
      assert.equal(context.evidence.afterCommit.case.status, 'under_review');
      assert.equal(context.evidence.afterCommit.case.version, 5);
      assert.equal(context.evidence.afterCommit.actions, 4);
      assert.equal(context.evidence.afterCommit.deletionAudits, 0);
    } },
  { id: 'hold-before-retention', parent: 'moderation-lifecycle', source: SOURCES[1], function: 'public.set_report_evidence_hold',
    control: 'Evidence hold holds the case row lock; retention must recheck holds after the wait',
    async run(cluster, context) {
      await resetReports(cluster);
      const fixture = await closedReport(cluster);
      context.evidence.syntheticPolicy = fixture.policy;
      const hold = `public.set_report_evidence_hold('${fixture.receipt.id}', '${randomUUID()}', true)`;
      const { winner, contender } = await cluster.race(context, cluster.serviceFirst, cluster.serviceSecond,
        hold, fixture.purge, 'transactionid', () => reportState(cluster));
      assert.equal(context.evidence.beforeCommit.holds, 0);
      assert.equal(winner.held, true);
      assert.equal(contender.error, undefined);
      assert.equal(contender.value.deleted_cases, 0);
      assert.equal(contender.value.eligible_cases, 0);
      assert.equal(contender.value.skipped_cases, 1);
      context.evidence.afterCommit = await reportState(cluster);
      assert.equal(context.evidence.afterCommit.cases, 1);
      assert.equal(context.evidence.afterCommit.holds, 1);
      assert.equal(context.evidence.afterCommit.actions, 3);
      assert.equal(context.evidence.afterCommit.deletionAudits, 0);
    } },
  { id: 'retention-before-review', parent: 'moderation-lifecycle', source: SOURCES[1], function: 'public.review_report',
    control: 'Committed purge beats a waiting review; missing case PT404 and exactly one aggregate deletion audit',
    async run(cluster, context) {
      await resetReports(cluster);
      const fixture = await closedReport(cluster);
      context.evidence.syntheticPolicy = fixture.policy;
      const { winner, contender } = await cluster.race(context, cluster.serviceFirst, cluster.first,
        fixture.purge, reviewSql(fixture.receipt, 'under_review'), 'transactionid', () => reportState(cluster));
      assert.equal(context.evidence.beforeCommit.cases, 1);
      assert.equal(context.evidence.beforeCommit.actions, 3);
      assert.equal(winner.deleted_cases, 1);
      assert.equal(winner.deleted_actions, 3);
      assert.equal(contender.error?.code, 'PT404');
      context.evidence.lateHoldDenied = await expectSqlError(cluster.serviceSecond,
        `public.set_report_evidence_hold('${fixture.receipt.id}', '${randomUUID()}', true)`, 'PT404');
      context.evidence.afterCommit = await reportState(cluster);
      assert.deepEqual(context.evidence.afterCommit, { cases: 0, actions: 0, holds: 0, deletionAudits: 1, case: null });
      context.evidence.audit = await cluster.observer.value('(SELECT to_jsonb(audit) FROM report_deletion_audit AS audit)');
      assert.equal(context.evidence.audit.deleted_cases, 1);
      assert.equal(context.evidence.audit.deleted_actions, 3);
      assert.equal(context.evidence.audit.executed_role, 'service_role');
      assert.equal(context.evidence.audit.policy_revision, fixture.policy.revision);
    } },
  { id: 'billing-concurrent-and-serial-replay', parent: 'billing-events', source: SOURCES[2], function: 'public.apply_billing_event',
    control: 'Concurrent identical event and later serial replay write one receipt, audit and entitlement',
    async run(cluster, context) {
      const uid = 'fixture_billing_replay';
      const event = billingSql('fixture_same_event', uid);
      context.advisoryKey = 'public.apply_billing_event:' + uid;
      const { winner, contender } = await cluster.race(context, cluster.serviceFirst, cluster.serviceSecond,
        event, event, 'advisory', () => billingState(cluster, uid));
      assert.deepEqual(context.evidence.beforeCommit, { receipts: 0, audits: 0, entitlement: null });
      assert.deepEqual(winner, { applied: true, duplicate: false });
      assert.equal(contender.error, undefined);
      assert.deepEqual(contender.value, { applied: false, duplicate: true });
      context.evidence.serialRetry = await cluster.serviceSecond.value(event);
      assert.deepEqual(context.evidence.serialRetry, { applied: false, duplicate: true });
      context.evidence.conflictingReplay = await expectSqlError(cluster.serviceSecond,
        billingSql('fixture_same_event', uid, 'elite'), '22023');
      context.evidence.afterCommit = await billingState(cluster, uid);
      assert.equal(context.evidence.afterCommit.receipts, 1);
      assert.equal(context.evidence.afterCommit.audits, 1);
      assert.equal(context.evidence.afterCommit.entitlement.tier, 'pro');
      assert.equal(context.evidence.afterCommit.entitlement.current_period_end, null);
    } },
  { id: 'billing-atomic-rollback', parent: 'billing-events', source: SOURCES[2], function: 'public.apply_billing_event',
    mode: 'sequential',
    control: 'Audit constraint failure rolls back receipt and entitlement; exact retry can then apply once',
    async run(cluster, context) {
      const uid = 'fixture_billing_rollback';
      await cluster.serviceFirst.value(billingSql('fixture_previous', uid, 'pro', { fixture: true }, '2026-01-01T12:00:00Z'));
      const before = await billingState(cluster, uid);
      const event = billingSql('fixture_atomic_failure', uid, 'elite', { fixture_failure: true });
      context.evidence.faultInjection = 'Synthetic audit CHECK constraint, installed and removed only in the private cluster';
      await cluster.admin.query("ALTER TABLE billing_events ADD CONSTRAINT fixture_reject_audit CHECK (raw->>'fixture_failure' IS DISTINCT FROM 'true') NOT VALID");
      try {
        context.evidence.expectedFailure = await expectSqlError(cluster.serviceSecond, event, '23514');
        context.evidence.afterFailure = await billingState(cluster, uid);
        assert.deepEqual(context.evidence.afterFailure, before);
      } finally {
        await cluster.admin.query('ALTER TABLE billing_events DROP CONSTRAINT fixture_reject_audit');
      }
      assert.deepEqual(await cluster.serviceSecond.value(event), { applied: true, duplicate: false });
      assert.deepEqual(await cluster.serviceFirst.value(event), { applied: false, duplicate: true });
      context.evidence.afterRetry = await billingState(cluster, uid);
      assert.equal(context.evidence.afterRetry.receipts, 2);
      assert.equal(context.evidence.afterRetry.audits, 2);
      assert.equal(context.evidence.afterRetry.entitlement.tier, 'elite');
    } },
  { id: 'push-contended-new-dispatch-budget', parent: 'push-subscriptions', source: SOURCES[3], function: 'public.enqueue_push_dispatch',
    control: 'Distinct dispatch keys for the same owner share the owner lock; full two-device fanout cannot exceed ten',
    async run(cluster, context) {
      const vapid = publicKey();
      await cluster.serviceFirst.value(`public.configure_push_subscriptions(true, '${vapid}', 30, true, 30)`);
      context.evidence.syntheticDeliveryEnabled = true;
      await cluster.first.identity(IDS.reporter);
      for (let revision = 0; revision < 2; revision++) {
        await cluster.first.value(`public.register_push_subscription('${randomUUID()}', '${randomUUID()}', ${revision},
          'https://fcm.googleapis.com/fcm/send/fixture_${randomBytes(24).toString('base64url')}',
          '${publicKey()}', '${randomBytes(16).toString('base64url')}', '${vapid}', 'push-generic-v1')`);
      }
      const enqueue = key => `public.enqueue_push_dispatch('${IDS.reporter}', 'account_notice', '${key}', 360)`;
      for (let index = 0; index < 4; index++) assert.equal((await cluster.serviceFirst.value(enqueue('fixture:seed:' + index))).queued, 2);
      const snapshot = () => cluster.observer.value(`jsonb_build_object(
        'receipts', (SELECT count(*)::int FROM push_dispatch_receipts WHERE owner_id='${IDS.reporter}'),
        'jobs', (SELECT count(*)::int FROM push_dispatches WHERE owner_id='${IDS.reporter}'),
        'winnerFanout', (SELECT count(*)::int FROM push_dispatches WHERE dedupe_key='fixture:new:a'),
        'loserFanout', (SELECT count(*)::int FROM push_dispatches WHERE dedupe_key='fixture:new:b'))`);
      context.advisoryKey = 'formora.push:' + IDS.reporter;
      const { winner, contender } = await cluster.race(context, cluster.serviceFirst, cluster.serviceSecond,
        enqueue('fixture:new:a'), enqueue('fixture:new:b'), 'advisory', snapshot);
      assert.deepEqual(context.evidence.beforeCommit, { receipts: 8, jobs: 8, winnerFanout: 0, loserFanout: 0 });
      assert.equal(winner.queued, 2);
      assert.equal(winner.daily_budget_remaining, 0);
      assert.equal(contender.error?.code, 'PT429');
      context.evidence.exactRetry = await cluster.serviceSecond.value(enqueue('fixture:new:a'));
      assert.equal(context.evidence.exactRetry.queued, 0);
      context.evidence.afterCommit = await snapshot();
      assert.deepEqual(context.evidence.afterCommit, { receipts: 10, jobs: 10, winnerFanout: 2, loserFanout: 0 });
    } },
];

const STORY_CASES = [
  { id: 'story-roles-defaults-and-references', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.story_action_receipt / public.story_reply_references', mode: 'sequential',
    control: 'Real local roles, effective grants, restrictive RLS, default-off gates, hard quota ceilings and owner-bound reference markers',
    async run(cluster, context) {
      context.evidence.sourceDefaults = await cluster.observer.value('(SELECT to_jsonb(settings) FROM public.story_settings AS settings)');
      for (const flag of ['enabled', 'permission_policy_approved', 'media_audience_approved', 'public_media_approved', 'retention_approved']) {
        assert.equal(context.evidence.sourceDefaults[flag], false, flag);
      }
      assert.equal(context.evidence.sourceDefaults.operator_policy_ref, null);
      for (const [name, maximum] of Object.entries(STORY_CAPS)) assert.equal(context.evidence.sourceDefaults[name], maximum, name);
      await resetStories(cluster, false);
      context.evidence.roles = await cluster.first.value(`jsonb_build_object('currentUser',current_user,'sessionUser',session_user,
        'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user))`);
      assert.deepEqual(context.evidence.roles, { currentUser: 'authenticated', sessionUser: 'fixture_member', superuser: false, bypassRls: false });
      context.evidence.gated = await expectSqlError(cluster.first, `public.get_story('${randomUUID()}')`, 'PT503');
      await cluster.first.identity(null);
      context.evidence.noIdentity = await expectSqlError(cluster.first, 'public.story_feed()', 'PT401');
      await cluster.first.identity(randomUUID());
      context.evidence.noProfile = await expectSqlError(cluster.first, 'public.story_feed()', 'PT403');
      await cluster.first.identity(IDS.reporter);
      context.evidence.grants = await cluster.observer.value(`(SELECT jsonb_agg(jsonb_build_object('name',proname,
        'member',has_function_privilege('authenticated',procedure.oid,'EXECUTE'),
        'service',has_function_privilege('service_role',procedure.oid,'EXECUTE'),
        'anon',has_function_privilege('anon',procedure.oid,'EXECUTE'),
        'public',EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner)))
          WHERE grantee=0 AND privilege_type='EXECUTE')) ORDER BY proname)
        FROM pg_proc AS procedure WHERE pronamespace='public'::regnamespace AND proname ~ '(^|_)story(_|$)')`);
      const memberFunctions = ['get_story', 'publish_story', 'delete_story', 'record_story_view', 'set_story_like', 'reply_to_story',
        'resolve_story_reply_context', 'story_reply_references', 'get_story_notification_preferences', 'set_story_notification_preferences',
        'set_story_block', 'story_feed', 'story_viewers', 'list_story_notifications', 'mark_story_notifications_read',
        'story_action_receipt', 'report_story_content'];
      assert.deepEqual(context.evidence.grants.filter(entry => entry.member).map(entry => entry.name).sort(), memberFunctions.sort());
      assert.deepEqual(context.evidence.grants.filter(entry => entry.service).map(entry => entry.name), ['cleanup_story_rate_limits']);
      assert.ok(context.evidence.grants.every(entry => !entry.anon && !entry.public));
      await cluster.admin.query('SET ROLE anon');
      try { context.evidence.anonDenied = await expectSqlError(cluster.admin, 'public.story_feed()', '42501'); }
      finally { await cluster.admin.query('RESET ROLE'); }
      context.evidence.rawDenied = {};
      for (const table of STORY_TABLES) {
        context.evidence.rawDenied[table] = await expectSqlError(cluster.first, `(SELECT count(*) FROM public.${table})`, '42501');
      }
      context.evidence.helperDenied = await expectSqlError(cluster.first, 'public._story_actor()', '42501');
      context.evidence.serviceOnlyDenied = await expectSqlError(cluster.first, 'public.cleanup_story_rate_limits(1)', '42501');
      context.evidence.memberPolicyWriteDenied = await expectSqlError(cluster.first,
        'UPDATE public.story_settings SET enabled=true', '42501', 'query');
      context.evidence.policyCheck = await expectSqlError(cluster.serviceFirst,
        'UPDATE public.story_settings SET enabled=true', '23514', 'query');
      context.evidence.ceilingChecks = [];
      for (const [name, maximum] of Object.entries(STORY_CAPS)) {
        for (const value of [0, maximum + 1]) context.evidence.ceilingChecks.push({ name, value,
          error: await expectSqlError(cluster.serviceFirst, `UPDATE public.story_settings SET ${name}=${value}`, '23514', 'query') });
      }
      assert.equal(await cluster.serviceFirst.value('public.cleanup_story_rate_limits(1)'), 0);
      await resetStories(cluster);
      const story = await seedStory(cluster);
      const request = randomUUID();
      const reply = await cluster.first.value(storyReplySql(story, 'Synthetic role-isolation message', request));
      assert.deepEqual(await cluster.first.value(`public.story_action_receipt('${request}')`), { ...reply, duplicate: true });
      context.evidence.foreignReceiptDenied = await expectSqlError(cluster.second, `public.story_action_receipt('${request}')`, 'PT404');
      context.evidence.foreignViewersDenied = await expectSqlError(cluster.first, `public.story_viewers('${story}')`, 'PT404');
      const references = `public.story_reply_references(ARRAY['${reply.id}']::text[])`;
      assert.deepEqual(await cluster.first.value(references), { message_ids: [reply.id] });
      assert.deepEqual(await cluster.second.value(references), { message_ids: [] });
      await cluster.second.identity(IDS.subject);
      assert.deepEqual(await cluster.second.value(references), { message_ids: [reply.id] });
      const forged = randomUUID();
      await cluster.admin.query(`INSERT INTO public.messages VALUES ('${forged}','${IDS.reporter}','${IDS.other}','Synthetic wrong owner',clock_timestamp())`);
      await cluster.admin.query(`INSERT INTO public.story_message_context VALUES ('${forged}','${story}')`);
      context.evidence.wrongOwnerReference = await cluster.first.value(`public.story_reply_references(ARRAY['${forged}']::text[])`);
      assert.deepEqual(context.evidence.wrongOwnerReference, { message_ids: [] });
      context.evidence.referenceBounds = [await expectSqlError(cluster.first, "public.story_reply_references('{}'::text[])", '22023'),
        await expectSqlError(cluster.first, `public.story_reply_references(array_fill('${reply.id}'::text,ARRAY[51]))`, '22023')];
      await cluster.admin.query('CREATE POLICY fixture_legacy_read ON public.story_action_receipts FOR SELECT TO authenticated USING (true)');
      try {
        await cluster.admin.query('GRANT SELECT ON public.story_action_receipts TO authenticated');
        context.evidence.restrictiveRls = { fixturePermissivePolicyAdded: true,
          adminRows: await cluster.observer.value('(SELECT count(*)::int FROM public.story_action_receipts)'),
          memberRows: await cluster.first.value('(SELECT count(*)::int FROM public.story_action_receipts)') };
        assert.equal(context.evidence.restrictiveRls.adminRows, 1);
        assert.equal(context.evidence.restrictiveRls.memberRows, 0);
      } finally {
        await cluster.admin.query('REVOKE SELECT ON public.story_action_receipts FROM authenticated');
        await cluster.admin.query('DROP POLICY fixture_legacy_read ON public.story_action_receipts');
      }
      context.evidence.limits = 'Synthetic claim GUC and minimal messages schema; not token verification, hosted RLS or legacy message policies';
    } },
  { id: 'story-view-pair-different-requests', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.record_story_view', mode: 'contention',
    control: 'Same viewer/story with different request UUIDs commits two receipts but one qualified interaction and timestamp',
    async run(cluster, context) {
      await resetStories(cluster);
      await cluster.second.identity(IDS.reporter);
      const story = await seedStory(cluster);
      const { winner, contender, evidence } = await storyRace(cluster, context, 'different-requests', cluster.first, cluster.second,
        storyViewSql(story), storyViewSql(story), [IDS.reporter, story, IDS.subject]);
      assert.equal(evidence.beforeCommit.views, 0);
      assert.equal(evidence.beforeCommit.receipts, 0);
      assert.equal(contender.error, undefined);
      assert.equal(winner.qualified, true);
      assert.equal(contender.value.qualified_at, winner.qualified_at);
      assert.equal(contender.value.duplicate, false);
      assert.notEqual(contender.value.request_id, winner.request_id);
      evidence.afterCommit = await storyState(cluster);
      assert.equal(evidence.afterCommit.views, 1);
      assert.equal(evidence.afterCommit.interactions, 1);
      assert.equal(evidence.afterCommit.receipts, 2);
      assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.reporter).day, 2);
      assert.equal(evidence.afterCommit.notifications, 0);
    } },
  { id: 'story-like-reply-replay-and-conflict', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.set_story_like / public.reply_to_story', mode: 'contention',
    control: 'Concurrent like/reply replay writes once; concurrent changed payload and serial cross-action reuse fail PT409',
    async run(cluster, context) {
      for (const action of ['like', 'reply']) {
        for (const conflict of [false, true]) {
          await resetStories(cluster);
          await cluster.second.identity(IDS.reporter);
          const story = await seedStory(cluster);
          const request = randomUUID();
          const firstSql = action === 'like' ? storyLikeSql(story, true, request) : storyReplySql(story, 'Synthetic first reply', request);
          const secondSql = !conflict ? firstSql : action === 'like' ? storyLikeSql(story, false, request) : storyReplySql(story, 'Synthetic changed reply', request);
          const { winner, contender, evidence } = await storyRace(cluster, context, `${action}-${conflict ? 'conflict' : 'replay'}`,
            cluster.first, cluster.second, firstSql, secondSql, [IDS.reporter, story, IDS.subject]);
          assert.equal(evidence.beforeCommit.receipts, 0);
          assert.equal(evidence.beforeCommit.messages, 0);
          assert.equal(evidence.beforeCommit.notifications, 0);
          assert.equal(winner.committed, true);
          assert.equal(winner.duplicate, false);
          if (conflict) assert.equal(contender.error?.code, 'PT409');
          else assert.deepEqual(contender.value, { ...winner, duplicate: true });
          assert.deepEqual(await cluster.second.value(firstSql), { ...winner, duplicate: true });
          evidence.crossActionConflict = await expectSqlError(cluster.second, action === 'like' ?
            storyReplySql(story, 'Synthetic cross-action reply', request) : storyLikeSql(story, true, request), 'PT409');
          evidence.afterCommit = await storyState(cluster);
          assert.equal(evidence.afterCommit.receipts, 1);
          assert.equal(evidence.afterCommit.likes, action === 'like' ? 1 : 0);
          assert.equal(evidence.afterCommit.messages, action === 'reply' ? 1 : 0);
          assert.equal(evidence.afterCommit.contexts, action === 'reply' ? 1 : 0);
          assert.equal(evidence.afterCommit.views, 0);
          assert.equal(evidence.afterCommit.notifications, 1);
          assert.equal(evidence.afterCommit.enqueued, 1);
          assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.reporter).day, 1);
        }
      }
    } },
  { id: 'story-actor-mixed-target-budget', parent: 'story-interactions', source: SOURCES[4],
    function: 'public._story_budget / public.set_story_like / public.reply_to_story', mode: 'contention',
    control: 'A view plus fresh like/reply requests across three owners cannot exceed the shared actor ceiling of two',
    async run(cluster, context) {
      await resetStories(cluster);
      await cluster.second.identity(IDS.reporter);
      context.evidence.loweredLimits = { actor_minute: 2, actor_day: 2 };
      await storyLimits(cluster, context.evidence.loweredLimits);
      const seed = await seedStory(cluster, IDS.other);
      const firstStory = await seedStory(cluster, IDS.subject);
      const secondStory = await seedStory(cluster, IDS.moderator);
      await cluster.first.value(storyViewSql(seed));
      const rejectedRequest = randomUUID();
      const { winner, contender, evidence } = await storyRace(cluster, context, 'actor-ceiling', cluster.first, cluster.second,
        storyLikeSql(firstStory), storyReplySql(secondStory, 'Synthetic over-budget reply', rejectedRequest), [IDS.reporter]);
      assert.equal(evidence.beforeCommit.receipts, 1);
      assert.equal(evidence.beforeCommit.likes, 0);
      assert.equal(winner.liked, true);
      assert.equal(contender.error?.code, 'PT429');
      evidence.afterCommit = await storyState(cluster);
      assert.equal(evidence.afterCommit.receipts, 2);
      assert.equal(evidence.afterCommit.views, 1);
      assert.equal(evidence.afterCommit.likes, 1);
      assert.equal(evidence.afterCommit.messages, 0);
      assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.reporter).day, 2);
      assert.ok(storyRate(evidence.afterCommit, 'actor', IDS.reporter).minute <= 2);
      assert.equal(storyRate(evidence.afterCommit, 'target', secondStory), undefined);
      assert.equal(storyRate(evidence.afterCommit, 'recipient', IDS.moderator), undefined);
      evidence.noFailedReceipt = await expectSqlError(cluster.second, `public.story_action_receipt('${rejectedRequest}')`, 'PT404');
      evidence.freshIdStillLimited = await expectSqlError(cluster.second, storyViewSql(secondStory), 'PT429');
      assert.deepEqual(await storyState(cluster), evidence.afterCommit);
    } },
  { id: 'story-recipient-budget-across-actors', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.reply_to_story', mode: 'contention',
    control: 'Different actors replying to different stories share the recipient lock and one aggregate reply unit',
    async run(cluster, context) {
      await resetStories(cluster);
      context.evidence.loweredLimits = { recipient_minute: 1, recipient_day: 1 };
      await storyLimits(cluster, context.evidence.loweredLimits);
      const firstStory = await seedStory(cluster);
      const secondStory = await seedStory(cluster);
      const { winner, contender, evidence } = await storyRace(cluster, context, 'recipient-ceiling', cluster.first, cluster.second,
        storyReplySql(firstStory), storyReplySql(secondStory), [IDS.subject]);
      assert.equal(evidence.beforeCommit.messages, 0);
      assert.equal(evidence.beforeCommit.receipts, 0);
      assert.equal(winner.committed, true);
      assert.equal(contender.error?.code, 'PT429');
      evidence.afterCommit = await storyState(cluster);
      assert.equal(evidence.afterCommit.messages, 1);
      assert.equal(evidence.afterCommit.contexts, 1);
      assert.equal(evidence.afterCommit.receipts, 1);
      assert.equal(storyRate(evidence.afterCommit, 'recipient', IDS.subject).day, 1);
      assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.other), undefined);
      assert.equal(storyRate(evidence.afterCommit, 'target', secondStory), undefined);
      evidence.freshIdStillLimited = await expectSqlError(cluster.second, storyReplySql(secondStory), 'PT429');
      assert.deepEqual(await storyState(cluster), evidence.afterCommit);
    } },
  { id: 'story-target-exhaustion-owner-access', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.get_story / public.story_viewers / public.record_story_view / public.delete_story', mode: 'contention',
    control: 'Contended target exhaustion denies a fresh sender but cannot consume the owner read, viewer-list, own-view or delete allowance',
    async run(cluster, context) {
      await resetStories(cluster);
      context.evidence.loweredLimits = { target_minute: 1, target_day: 1 };
      await storyLimits(cluster, context.evidence.loweredLimits);
      const story = await seedStory(cluster);
      const { contender, evidence } = await storyRace(cluster, context, 'target-ceiling', cluster.first, cluster.second,
        storyViewSql(story), storyReplySql(story), [story, IDS.subject]);
      assert.equal(evidence.beforeCommit.views, 0);
      assert.equal(contender.error?.code, 'PT429');
      const saturated = await storyState(cluster);
      assert.equal(storyRate(saturated, 'target', story).day, 1);
      assert.equal(saturated.messages, 0);
      await cluster.second.identity(IDS.subject);
      context.evidence.ownerRead = await cluster.second.value(`public.get_story('${story}')`);
      assert.equal(context.evidence.ownerRead.mine, true);
      assert.equal(context.evidence.ownerRead.view_count, 1);
      context.evidence.ownerViewers = await cluster.second.value(`public.story_viewers('${story}')`);
      assert.deepEqual(context.evidence.ownerViewers.items.map(viewer => viewer.id), [IDS.reporter]);
      context.evidence.ownerView = await cluster.second.value(storyViewSql(story));
      assert.equal(context.evidence.ownerView.qualified, false);
      context.evidence.ownerDelete = await cluster.second.value(storyDeleteSql(story));
      assert.equal(context.evidence.ownerDelete.committed, true);
      evidence.afterCommit = await storyState(cluster);
      assert.equal(evidence.afterCommit.deleted, 1);
      assert.equal(evidence.afterCommit.interactions, 1);
      assert.equal(evidence.afterCommit.views, 1);
      assert.equal(evidence.afterCommit.receipts, 3);
      assert.equal(storyRate(evidence.afterCommit, 'target', story).day, 1);
      assert.equal(storyRate(evidence.afterCommit, 'cleanup', IDS.subject).day, 1);
    } },
  { id: 'story-notification-enqueue-caps', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.reply_to_story / public._story_notify', mode: 'contention',
    control: 'Actual notification enqueues obey both pair and recipient caps across stories/actors while both messages, contexts and receipts commit',
    async run(cluster, context) {
      for (const scope of ['pair', 'recipient']) {
        await resetStories(cluster);
        const secondActor = scope === 'pair' ? IDS.reporter : IDS.other;
        await cluster.second.identity(secondActor);
        const limits = scope === 'pair' ? { notification_actor_per_minute: 1, notification_actor_per_day: 1 } :
          { notification_per_minute: 1, notification_per_day: 1 };
        await storyLimits(cluster, limits);
        const firstStory = await seedStory(cluster);
        const secondStory = await seedStory(cluster);
        const secondSql = storyReplySql(secondStory, 'Synthetic second committed reply');
        const { winner, contender, evidence } = await storyRace(cluster, context, scope + '-enqueue-ceiling', cluster.first, cluster.second,
          storyReplySql(firstStory, 'Synthetic first committed reply'), secondSql,
          scope === 'pair' ? [IDS.reporter, IDS.subject] : [IDS.subject]);
        evidence.loweredLimits = limits;
        assert.equal(evidence.beforeCommit.messages, 0);
        assert.equal(evidence.beforeCommit.notifications, 0);
        assert.equal(evidence.beforeCommit.enqueued, 0);
        assert.equal(winner.committed, true);
        assert.equal(contender.error, undefined);
        assert.equal(contender.value.committed, true);
        assert.equal(contender.value.duplicate, false);
        assert.notEqual(winner.id, contender.value.id);
        evidence.afterCommit = await storyState(cluster);
        assert.equal(evidence.afterCommit.messages, 2);
        assert.equal(evidence.afterCommit.contexts, 2);
        assert.equal(evidence.afterCommit.receipts, 2);
        assert.equal(evidence.afterCommit.events, 2);
        assert.equal(evidence.afterCommit.notifications, 1);
        assert.equal(evidence.afterCommit.enqueued, 1);
        evidence.matchedMessageContextReceipts = await cluster.observer.value(`(SELECT count(*)::int
          FROM public.story_action_receipts AS receipt JOIN public.messages AS message ON receipt.response->>'id'=message.id
          JOIN public.story_message_context AS context ON context.message_id=message.id
          WHERE receipt.action='reply' AND receipt.actor::text=message.from_uid AND receipt.response->>'to'=message.to_uid
            AND receipt.response->>'story_id'=context.story_id::text)`);
        assert.equal(evidence.matchedMessageContextReceipts, 2);
        assert.deepEqual(await cluster.second.value(secondSql), { ...contender.value, duplicate: true });
        assert.deepEqual(await storyState(cluster), evidence.afterCommit);
      }
    } },
  { id: 'story-cleanup-after-ordinary-budget', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.delete_story', mode: 'contention',
    control: 'A full ordinary actor budget leaves one independent cleanup unit; concurrent own deletes cannot exceed that unit',
    async run(cluster, context) {
      await resetStories(cluster);
      await cluster.first.identity(IDS.subject);
      await cluster.second.identity(IDS.subject);
      context.evidence.loweredLimits = { actor_minute: 1, actor_day: 1, cleanup_minute: 1, cleanup_day: 1 };
      await storyLimits(cluster, context.evidence.loweredLimits);
      const firstStory = await seedStory(cluster);
      const secondStory = await seedStory(cluster);
      await cluster.first.value(`public.get_story('${firstStory}')`);
      const firstSql = storyDeleteSql(firstStory);
      const { winner, contender, evidence } = await storyRace(cluster, context, 'independent-cleanup-ceiling', cluster.first, cluster.second,
        firstSql, storyDeleteSql(secondStory), [IDS.subject]);
      assert.equal(evidence.beforeCommit.deleted, 0);
      assert.equal(storyRate(evidence.beforeCommit, 'actor', IDS.subject).day, 1);
      assert.equal(winner.committed, true);
      assert.equal(contender.error?.code, 'PT429');
      evidence.afterCommit = await storyState(cluster);
      assert.equal(evidence.afterCommit.deleted, 1);
      assert.equal(evidence.afterCommit.receipts, 1);
      assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.subject).day, 1);
      assert.equal(storyRate(evidence.afterCommit, 'cleanup', IDS.subject).day, 1);
      assert.deepEqual(await cluster.second.value(firstSql), { ...winner, duplicate: true });
      evidence.ordinaryStillLimited = await expectSqlError(cluster.second, `public.get_story('${secondStory}')`, 'PT429');
      evidence.freshCleanupStillLimited = await expectSqlError(cluster.second, storyDeleteSql(secondStory), 'PT429');
      assert.equal(await cluster.observer.value(`(SELECT deleted_at IS NULL FROM public.stories_v2 WHERE id='${secondStory}')`), true);
      assert.deepEqual(await storyState(cluster), evidence.afterCommit);
    } },
  { id: 'story-queued-invalidation', parent: 'story-interactions', source: SOURCES[4],
    function: 'public.reply_to_story / public.set_story_block / public.delete_story', mode: 'contention',
    control: 'Replies queued behind block, expiry or delete recheck eligibility after the actual lock wait and commit no message or receipt',
    async run(cluster, context) {
      for (const invalidation of ['block', 'expiry', 'delete']) {
        await resetStories(cluster);
        await cluster.first.identity(IDS.subject);
        await cluster.second.identity(IDS.reporter);
        const story = await seedStory(cluster);
        const request = randomUUID();
        const firstSql = invalidation === 'block' ? `public.set_story_block('${IDS.reporter}',true,'${randomUUID()}')` :
          invalidation === 'delete' ? storyDeleteSql(story) : `public.get_story('${story}')`;
        const inspect = async () => {
          const before = await storyState(cluster);
          if (invalidation === 'expiry') {
            assert.equal(await cluster.observer.value(`(SELECT expires_at>clock_timestamp() FROM public.stories_v2 WHERE id='${story}')`), true);
            await cluster.admin.query(`UPDATE public.stories_v2 SET created_at=statement_timestamp()-interval '25 hours',
              expires_at=statement_timestamp()-interval '1 hour' WHERE id='${story}'`);
            before.fixtureExpiryAdvancedWhileBlocked = true;
            assert.equal(await cluster.observer.value(`(SELECT expires_at>clock_timestamp() FROM public.stories_v2 WHERE id='${story}')`), false);
          }
          return before;
        };
        const { contender, evidence } = await storyRace(cluster, context, invalidation + '-before-reply', cluster.first, cluster.second,
          firstSql, storyReplySql(story, 'Synthetic queued fresh reply', request),
          invalidation === 'block' ? [IDS.subject, IDS.reporter] : [story, IDS.subject], inspect);
        assert.equal(evidence.beforeCommit.messages, 0);
        assert.equal(evidence.beforeCommit.receipts, 0);
        assert.equal(contender.error?.code, 'PT404');
        evidence.afterCommit = await storyState(cluster);
        assert.equal(evidence.afterCommit.messages, 0);
        assert.equal(evidence.afterCommit.contexts, 0);
        assert.equal(evidence.afterCommit.notifications, 0);
        assert.equal(evidence.afterCommit.receipts, invalidation === 'expiry' ? 0 : 1);
        assert.equal(storyRate(evidence.afterCommit, 'actor', IDS.reporter), undefined);
        evidence.failedReceiptAbsent = await expectSqlError(cluster.second, `public.story_action_receipt('${request}')`, 'PT404');
        evidence.laterFreshSendDenied = await expectSqlError(cluster.second, storyReplySql(story), 'PT404');
        assert.deepEqual(await storyState(cluster), evidence.afterCommit);
      }
    } },
  { id: 'story-mutual-replies-sorted-locks', parent: 'story-interactions', source: SOURCES[4],
    function: 'public._story_lock / public.reply_to_story', mode: 'contention',
    control: 'Opposite-direction replies are both queued on the smaller common lock without holding the larger one, then commit without deadlock',
    async run(cluster, context) {
      await resetStories(cluster);
      await cluster.second.identity(IDS.subject);
      const reporterStory = await seedStory(cluster, IDS.reporter);
      const subjectStory = await seedStory(cluster, IDS.subject);
      const gateKey = await storyLockKey(cluster, [IDS.reporter, IDS.subject]);
      const gateSubject = gateKey.slice('stories-v2:'.length);
      const higherSubject = gateSubject === IDS.reporter ? IDS.subject : IDS.reporter;
      const higherKey = sqlLiteral('stories-v2:' + higherSubject);
      context.evidence.participantLockOrder = [gateKey, 'stories-v2:' + higherSubject];
      let peerPending;
      const peerEvidence = { label: 'mutual-peer-on-same-gate' };
      try {
        const { contender, evidence } = await storyRace(cluster, context, 'mutual-first-on-gate', cluster.admin, cluster.first,
          `pg_advisory_xact_lock(hashtextextended(${sqlLiteral(gateKey)},0))`,
          storyReplySql(subjectStory, 'Synthetic reporter to subject'), [gateSubject], async () => {
            await cluster.second.value(`pg_notify('fm_probe',${sqlLiteral(context.id + ':peer')})`);
            peerPending = cluster.second.value(storyReplySql(reporterStory, 'Synthetic subject to reporter'))
              .then(value => ({ value }), error => ({ error: errorDetails(error) }));
            context.evidence.races.push(peerEvidence);
            peerEvidence.lock = await cluster.waitForLock(cluster.second, cluster.admin, 'advisory', gateKey);
            const higherLockHolders = await cluster.observer.value(`(SELECT coalesce(jsonb_agg(pid),'[]'::jsonb) FROM pg_locks
              WHERE pid IN (${cluster.first.pid},${cluster.second.pid}) AND locktype='advisory' AND granted AND objsubid=1
                AND classid::text=((hashtextextended(${higherKey},0)>>32)&4294967295)::text
                AND objid::text=(hashtextextended(${higherKey},0)&4294967295)::text)`);
            assert.deepEqual(higherLockHolders, [], 'A reciprocal sender took the higher common lock before the lower one');
            return { ...await storyState(cluster), higherCommonLockHolders: higherLockHolders,
              queuedMemberPids: [cluster.first.pid, cluster.second.pid], fixtureGatePid: cluster.admin.pid };
          });
        peerEvidence.contender = await peerPending;
        assert.equal(evidence.beforeCommit.messages, 0);
        assert.equal(evidence.beforeCommit.receipts, 0);
        assert.equal(contender.error, undefined);
        assert.equal(peerEvidence.contender.error, undefined);
        assert.equal(contender.value.committed, true);
        assert.equal(peerEvidence.contender.value.committed, true);
        assert.equal(contender.value.from, IDS.reporter);
        assert.equal(contender.value.to, IDS.subject);
        assert.equal(peerEvidence.contender.value.from, IDS.subject);
        assert.equal(peerEvidence.contender.value.to, IDS.reporter);
        assert.notEqual(contender.value.id, peerEvidence.contender.value.id);
        evidence.afterCommit = await storyState(cluster);
        assert.equal(evidence.afterCommit.messages, 2);
        assert.equal(evidence.afterCommit.contexts, 2);
        assert.equal(evidence.afterCommit.receipts, 2);
        assert.equal(evidence.afterCommit.notifications, 2);
        context.evidence.deadlockObserved = false;
      } finally { if (peerPending) await peerPending; }
    } },
];

const CHECKS = [...CASES.map(definition => ({ mode: 'contention', ...definition })), ...STORY_CASES];

async function runCases(cluster, report) {
  for (const definition of CHECKS) {
    if (cluster.cancelled) throw new Error('Run deadline or signal interrupted remaining cases');
    const context = report.cases.find(item => item.id === definition.id);
    const started = Date.now();
    context.status = 'running';
    try {
      await definition.run(cluster, context);
      context.status = 'passed';
    } catch (error) {
      context.status = 'failed';
      context.error = errorDetails(error);
      report.findings.push({ parent: context.parent, source: context.source, function: context.function, control: context.control,
        caseId: context.id, classification: 'real-postgres-contract-failure-requires-code-triage', ...errorDetails(error) });
    }
    context.durationMs = Date.now() - started;
    console.log(`${context.status.toUpperCase()} ${context.id}`);
  }
}

async function main() {
  assertWorkspace();
  assert.equal(process.argv.length, 2, 'No connection strings, flags or external targets are accepted');
  const report = { schemaVersion: 2, runId: randomUUID(), startedAt: new Date().toISOString(),
    scope: 'Synthetic local PostgreSQL only; not GoTrue, PostgREST, staging or production approval',
    productionApproval: false, implementationComplete: true, plannedCaseCount: CHECKS.length, status: 'running',
    cases: CHECKS.map(({ run, ...definition }) => ({ ...definition, status: 'not_run', evidence: {} })), findings: [],
    sourceBefore: fingerprint() };
  assert.equal(CASES.length, 10, 'The original ten cases must remain');
  assert.equal(STORY_CASES.length, 10, 'The bounded Stories plan must contain ten cases');
  report.storyFixturePolicy = { enabledOnlyInDisposableCluster: true, operatorPolicyRef: STORY_POLICY,
    flags: ['enabled', 'permission_policy_approved', 'media_audience_approved', 'public_media_approved', 'retention_approved'],
    mediaOrigin: 'https://fixture.supabase.co', mediaFetched: false,
    quotaWindows: 'Lowered minute/day ceilings; elapsed-window rollover and production load are not exercised',
    expiry: 'Fixture timestamps changed while a real reply waits; no elapsed 24-hour or retention-worker claim',
    mutualReplies: 'Two member senders plus an administrative gate and read-only observer; not exhaustive interleavings' };
  const destination = reportDestination(report.runId);
  const descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const writeReport = () => {
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, JSON.stringify(report, null, 2) + '\n', 0, 'utf8');
    fs.fsyncSync(descriptor);
  };
  writeReport();
  const cluster = new LocalCluster(report);
  const cancel = () => {
    if (cluster.cleaning) return;
    cluster.cancelled = true;
    cluster.events.emit('cancel');
    for (const child of cluster.children) child.kill('SIGTERM');
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const deadline = setTimeout(cancel, 180000);
  try {
    await cluster.setup();
    await runCases(cluster, report);
  } catch (error) {
    report.findings.push({ scope: 'runner-or-migration', ...errorDetails(error) });
  } finally {
    clearTimeout(deadline);
    try { report.cleanup = await cluster.cleanup(); }
    catch (error) { report.cleanup = { ...report.cleanup, error: errorDetails(error) }; }
    report.sourceAfter = fingerprint();
    report.sourcesUnchanged = report.sourceBefore.sha256 === report.sourceAfter.sha256;
    report.counts = { tested: report.cases.filter(item => ['passed', 'failed'].includes(item.status)).length,
      passed: report.cases.filter(item => item.status === 'passed').length,
      failed: report.cases.filter(item => item.status === 'failed').length, sqlQueries: cluster.queryCount,
      notRun: report.cases.filter(item => !['passed', 'failed'].includes(item.status)).length,
      contentionPassed: report.cases.filter(item => item.status === 'passed' && item.mode === 'contention').length,
      sequentialPassed: report.cases.filter(item => item.status === 'passed' && item.mode === 'sequential').length,
      observedLockWaits: report.cases.reduce((count, item) => count + Number(Boolean(item.evidence.lock)) +
        (item.evidence.races || []).filter(race => race.lock).length, 0),
      lockProbes: cluster.lockProbeCount, notificationCount: cluster.notifications.length, peakConnections: cluster.peakConnections };
    report.coverage = Object.fromEntries(['legacy', 'stories'].map(scope => {
      const cases = report.cases.filter(item => (item.parent === 'story-interactions') === (scope === 'stories'));
      return [scope, { planned: cases.length, passed: cases.filter(item => item.status === 'passed').length,
        contentionPassed: cases.filter(item => item.status === 'passed' && item.mode === 'contention').length,
        sequentialPassed: cases.filter(item => item.status === 'passed' && item.mode === 'sequential').length }];
    }));
    report.notifications = cluster.notifications;
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.status = report.counts.failed || report.counts.notRun || report.findings.length || !report.sourcesUnchanged ||
      !report.cleanup.processStopped || !report.cleanup.removedOwnedDirectory ? 'failed' :
      report.implementationComplete ? 'passed' : 'incomplete';
    writeReport();
    fs.closeSync(descriptor);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    console.log(JSON.stringify({ report: path.relative(WORKSPACE, destination), status: report.status,
      counts: report.counts, findings: report.findings, caseFailures: report.cases.filter(item => item.status === 'failed'),
      cleanup: report.cleanup, sourcesUnchanged: report.sourcesUnchanged }, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}

module.exports = { cleanEnvironment, socketPath, connectionArgs, assertWorkspace, ownedDirectory };
if (require.main === module) main().catch(error => { console.error(JSON.stringify(errorDetails(error))); process.exitCode = 1; });