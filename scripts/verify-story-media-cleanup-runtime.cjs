'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { database, identity, rpc, reserve, upload, claim: validationClaim, approve, owner, hash } = require('../tests/story-media-sql.test.cjs');
const { holdsFixture, prepare, confirm } = require('../tests/story-media-cleanup.test.cjs');
const root = path.resolve(__dirname, '..');
const deno = process.env.STORY_MEDIA_DENO || (fs.existsSync('/opt/homebrew/bin/deno') ? '/opt/homebrew/bin/deno' : 'deno');
const origin = 'https://cleanup-fixture.supabase.co';
const serviceKey = 'synthetic-local-cleanup-service-key-000000000000';
const files = ['supabase/story-media.sql', 'supabase/story-interactions.sql', 'supabase/account-rights.sql',
  'supabase/functions/cleanup-story-media/index.ts', 'supabase/functions/cleanup-story-media/deno.json',
  'scripts/verify-story-media-cleanup-runtime.ts', 'scripts/verify-story-media-cleanup-runtime.cjs',
  'tests/story-media-cleanup.test.cjs', 'tests/story-media-cleanup-runtime.test.cjs', 'tests/story-media-sql.test.cjs', 'tests/story-media-independent.test.cjs'];
const sourceHashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const cleanEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C',
  DENO_DIR: path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/deno' : '.cache/deno') };
const runtimeArgs = ['run', '--no-prompt', '--cached-only', '--deny-net', '--deny-env', '--deny-read', '--deny-write',
  '--config', path.join(root, 'supabase/functions/cleanup-story-media/deno.json'), path.join(root, 'scripts/verify-story-media-cleanup-runtime.ts')];
const rpcArguments = {
  claim_story_media_cleanup: ['p_operation_id', 'p_claim_id'],
  request_story_media_cleanup_object: ['p_operation_id', 'p_claim_id', 'p_intent_id', 'p_lease_token'],
  finish_story_media_cleanup_object: ['p_operation_id', 'p_claim_id', 'p_intent_id', 'p_lease_token', 'p_result', 'p_delete_status', 'p_ack', 'p_get_status']
};

function assertRuntimeReport(report) {
  assert.equal(report?.network, 'denied'); assert.equal(typeof report.runtime?.deno, 'string');
  assert.ok(Array.isArray(report.cases) && report.cases.length > 0 && report.cases.length <= 128);
  assert.equal(new Set(report.cases.map(entry => entry.name)).size, report.cases.length);
  for (const entry of report.cases) { assert.equal(typeof entry.name, 'string'); assert.ok(entry.name); assert.equal(typeof entry.passed, 'boolean'); }
  assert.equal(report.passed, report.cases.filter(entry => entry.passed).length);
  assert.equal(report.failed, report.cases.filter(entry => !entry.passed).length);
  assert.equal(report.result, report.failed ? 'failed' : 'passed');
  return report;
}

async function startBridge(network) {
  const child = spawn(deno, [...runtimeArgs, '--bridge'], { cwd: root, env: cleanEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', diagnostic = '', sequence = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const send = message => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const fail = error => {
    readyReject(error);
    for (const held of pending.values()) { clearTimeout(held.timer); held.reject(error); }
    pending.clear();
  };
  child.on('error', fail); child.stdin.on('error', fail);
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.on('exit', () => fail(new Error('Synthetic Deno bridge exited: ' + diagnostic)));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 65536) { fail(new Error('Synthetic bridge output exceeded bound')); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); } catch (error) { fail(error); child.kill(); return; }
      buffer = buffer.slice(newline + 1);
      if (message.type === 'ready') readyResolve(message);
      else if (message.type === 'result') {
        const held = pending.get(message.id); pending.delete(message.id);
        if (held) { clearTimeout(held.timer); held.resolve(message); }
      } else if (message.type === 'fetch') {
        Promise.resolve().then(() => network(message)).then(response => send({ type: 'response', id: message.id, ...response }))
          .catch(() => send({ type: 'response', id: message.id, error: true }));
      } else { fail(new Error('Unknown synthetic bridge frame')); child.kill(); }
    }
  });
  const timer = setTimeout(() => { fail(new Error('Synthetic bridge startup deadline')); child.kill(); }, 5000);
  let metadata;
  try { metadata = await ready; } finally { clearTimeout(timer); }
  return {
    metadata,
    invoke(body, headers = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic handler deadline')); child.kill(); }, 22000);
        pending.set(id, { resolve, reject, timer }); send({ type: 'invoke', id, body, headers });
      });
    },
    async close() {
      child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000);
      try { return await closed; } finally { clearTimeout(timer); }
    }
  };
}

async function syntheticFixture(kind = 'cancelled', mode = 'normal', approved = true) {
  const db = await database();
  try {
    const reservation = await reserve(db), privateObject = await upload(db, reservation);
    let publicObjectId;
    if (kind === 'published') {
      await approve(db, reservation); publicObjectId = reservation.public_object_id;
      await identity(db); const story = await rpc(db, 'publish_validated_story', [reservation.request_id, reservation.reservation_id, hash]);
      await rpc(db, 'delete_story', [story.id, randomUUID()]);
    } else if (kind === 'failed') {
      const lease = await validationClaim(db, reservation);
      await rpc(db, 'attest_story_media', [owner, reservation.request_id, lease.epoch, lease.lease_token, null, null, null, null, null, null, 'invalid_media']);
    } else await rpc(db, 'cancel_story_media', [reservation.request_id]);
    await holdsFixture(db); await db.exec('RESET ROLE');
    const row = (await db.query('SELECT epoch FROM public.story_media_reservations WHERE id=$1', [reservation.reservation_id])).rows[0];
    const ids = [privateObject.id, ...(publicObjectId ? [publicObjectId] : [])];
    const plan = await prepare(db, { ...reservation, epoch: row.epoch, stored: privateObject }, ids);
    if (approved) await confirm(db, plan);
    const sentinel = await reserve(db), kept = await upload(db, sentinel);
    await db.exec('RESET ROLE');
    const bytes = new Map((await db.query('SELECT id,bucket_id,name,version FROM storage.objects')).rows.map(object =>
      [object.bucket_id + '/' + object.name, { id: object.id, version: object.version, bytes: Buffer.alloc(500, 90) }]));
    const calls = []; let apiDeletes = 0, finalizeLost = false, mutationApplied = false;
    const response = (status, value) => ({ status, body: value === null ? null : JSON.stringify(value) });
    async function hold() {
      await db.exec('RESET ROLE');
      const report = randomUUID();
      await db.query('INSERT INTO public.report_cases VALUES($1,$2,$3)', [report, owner, owner]);
      await db.query('INSERT INTO public.report_evidence_holds VALUES($1,$2)', [report, randomUUID()]);
      await identity(db, null, 'service_role');
    }
    return {
      db, plan, reservation, bytes, calls, sentinel: kept.id,
      get apiDeletes() { return apiDeletes; },
      async expireWorker() {
        await db.exec('RESET ROLE');
        await db.query("UPDATE public.story_media_cleanup_plans SET worker_lease_until=now()-interval '1 second' WHERE id=$1", [plan.plan_id]);
      },
      async network(message) {
        calls.push({ method: message.method, route: new URL(message.url).pathname });
        assert.equal(new URL(message.url).origin, origin); assert.equal(new URL(message.url).search, '');
        assert.equal(message.redirect, 'error'); assert.equal(message.credentials, 'omit');
        assert.equal(message.headers.apikey, serviceKey); assert.equal(message.headers.authorization, 'Bearer ' + serviceKey);
        const route = new URL(message.url).pathname;
        await identity(db, null, 'service_role');
        if (route.startsWith('/rest/v1/rpc/')) {
          const name = route.slice('/rest/v1/rpc/'.length), parameters = rpcArguments[name];
          assert.ok(parameters, 'Fixed RPC allowlist'); assert.equal(message.method, 'POST');
          const body = JSON.parse(message.body); assert.deepEqual(Object.keys(body).sort(), [...parameters].sort());
          if (name === 'request_story_media_cleanup_object' && !mutationApplied) {
            mutationApplied = true;
            if (mode === 'hold_before_request') await hold();
            else if (mode === 'policy_before_request') await db.exec('UPDATE public.story_media_settings SET cleanup_enabled=false');
            else if (mode === 'owner_before_request') {
              await db.exec('RESET ROLE');
              await db.query('UPDATE public.story_media_reservations SET owner=$1 WHERE id=$2', [randomUUID(), reservation.reservation_id]);
              await identity(db, null, 'service_role');
            }
          }
          let result;
          try { result = await rpc(db, name, parameters.map(parameter => body[parameter])); }
          catch (error) { return response(/^PT\d{3}$/.test(error.code) ? Number(error.code.slice(2)) : error.code === '42501' ? 403 : 500, { code: error.code }); }
          if (mode === 'reply_version_changed' && name === 'request_story_media_cleanup_object') result.objects[0].object_version = 'changed-service-reply-version';
          if (mode === 'hold_between_objects' && name === 'finish_story_media_cleanup_object' && body.p_result === 'storage_api_deleted' && apiDeletes === 1) await hold();
          if (mode === 'finalize_ack_lost' && name === 'finish_story_media_cleanup_object' && body.p_result === 'storage_api_deleted' && !finalizeLost) {
            finalizeLost = true; throw new Error('Synthetic finalized SQL ACK lost');
          }
          return response(200, result);
        }
        if (message.method === 'DELETE') {
          apiDeletes++;
          const bucket = route.slice('/storage/v1/object/'.length), body = JSON.parse(message.body);
          assert.equal(route, '/storage/v1/object/' + bucket);
          assert.deepEqual(Object.keys(body), ['prefixes']); assert.equal(body.prefixes.length, 1);
          const target = plan.objects.find(object => object.bucket === bucket && object.object_key === body.prefixes[0]);
          assert.ok(target, 'Only exact planned object keys may be removed');
          if (mode === 'hold_before_delete') await hold();
          if (mode === 'false_ack_and_404') return response(200, [{ id: target.object_id, name: target.object_key, bucket_id: target.bucket }]);
          const deleted = (await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING id,name,bucket_id', [bucket, body.prefixes[0]])).rows;
          if (mode === 's3_failure') return response(500, { error: 'Synthetic backend failure after catalog commit' });
          for (const object of deleted) bytes.delete(object.bucket_id + '/' + object.name);
          if (mode === 'storage_ack_lost') throw new Error('Synthetic Storage ACK lost');
          if (mode === 'empty_ack') return response(200, []);
          if (mode === 'empty_204') return response(204, null);
          return response(200, deleted);
        }
        assert.equal(message.method, 'GET'); assert.ok(route.startsWith('/storage/v1/object/authenticated/'));
        const key = route.slice('/storage/v1/object/authenticated/'.length), separator = key.indexOf('/');
        const bucket = key.slice(0, separator), name = key.slice(separator + 1);
        const metadata = (await db.query('SELECT id FROM storage.objects WHERE bucket_id=$1 AND name=$2', [bucket, name])).rows;
        if (mode === 'false_ack_and_404') return response(404, null);
        return response(metadata.length && bytes.has(key) ? 200 : 404, null);
      },
      close: () => db.close()
    };
  } catch (error) { await db.close(); throw error; }
}

async function runVerification() {
  const before = sourceHashes(), parent = path.join(root, 'dist/story-media-cleanup');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); assert.equal(fs.realpathSync(parent), parent);
  const directory = fs.mkdtempSync(path.join(parent, 'run-')), cases = [];
  const result = spawnSync(deno, runtimeArgs, { cwd: root, env: cleanEnv, shell: false, timeout: 30000, maxBuffer: 262144, encoding: 'utf8' });
  if (result.error) throw new Error('Actual Deno is required, never silently skipped: ' + result.error.code);
  const unit = assertRuntimeReport(JSON.parse(result.stdout));
  cases.push(...unit.cases);
  let currentFixture, termination;
  const bridge = await startBridge(message => {
    assert.ok(currentFixture, 'No network operation outside synthetic fixture lifetime');
    return currentFixture.network(message);
  });
  async function check(name, kind, mode, work, approved = true) {
    try {
      currentFixture = await syntheticFixture(kind, mode, approved);
      await work(currentFixture, () => bridge.invoke({ operation_id: currentFixture.plan.operation_id, claim_id: currentFixture.plan.plan_id }));
      await currentFixture.db.exec('RESET ROLE');
      assert.equal((await currentFixture.db.query('SELECT id FROM storage.objects WHERE id=$1', [currentFixture.sentinel])).rows.length, 1);
      assert.ok(currentFixture.calls.every(call => !/auth\/|account|billing/.test(call.route)));
      cases.push({ name, passed: true });
    } catch (error) { cases.push({ name, passed: false, error: error.message.slice(0, 512) }); }
    finally { if (currentFixture) await currentFixture.close(); currentFixture = null; }
  }
  try {
    for (const kind of ['cancelled', 'failed', 'published']) await check('Deno + SQL: exact ' + kind + ' cleanup and replay', kind, 'normal', async (fixture, invoke) => {
      const response = await invoke(), expected = kind === 'published' ? 2 : 1;
      assert.equal(response.status, 200); assert.equal(response.body.completed, expected); assert.equal(response.body.result, 'storage_api_deleted');
      assert.equal(response.body.physical_delete_confirmed, false); assert.equal(response.body.account_deleted, false);
      assert.equal(fixture.apiDeletes, expected); assert.ok(fixture.calls.length <= 10);
      const replay = await invoke(); assert.deepEqual(replay.body, response.body); assert.equal(fixture.apiDeletes, expected);
      assert.equal(fixture.bytes.size, 1);
    });
    await check('Deno + SQL: unconfirmed dry run cannot execute', 'cancelled', 'normal', async (fixture, invoke) => {
      assert.equal((await invoke()).status, 409); assert.equal(fixture.apiDeletes, 0);
    }, false);
    for (const mode of ['s3_failure', 'storage_ack_lost', 'empty_ack', 'empty_204']) {
      await check('Deno + SQL: durable recovery after ' + mode, 'cancelled', mode, async (fixture, invoke) => {
        const first = await invoke(); assert.notEqual(first.status, 200); assert.equal(fixture.apiDeletes, 1);
        await fixture.expireWorker();
        const second = await invoke(); assert.equal(second.status, 202); assert.equal(second.body.result, 'storage_api_absent_backend_unknown');
        assert.equal(second.body.pending, 1); assert.equal(second.body.completed, 0); assert.equal(fixture.apiDeletes, 1);
        assert.equal(second.body.operation_id, fixture.plan.operation_id); assert.equal(second.body.claim_id, fixture.plan.plan_id);
        assert.equal(fixture.bytes.size, mode === 's3_failure' ? 2 : 1);
        const inventory = await rpc(fixture.db, 'preview_story_media_cleanup', [null, 10]);
        assert.equal(inventory.items[0].pending_intents[0].state, 'unknown');
        assert.equal(inventory.items[0].pending_intents[0].outcome, 'storage_api_absent_backend_unknown');
      });
    }
    await check('Deno + SQL: lost final SQL ACK replays completion without another delete', 'cancelled', 'finalize_ack_lost', async (fixture, invoke) => {
      assert.notEqual((await invoke()).status, 200);
      const replay = await invoke(); assert.equal(replay.status, 200); assert.equal(replay.body.result, 'storage_api_deleted');
      assert.equal(fixture.apiDeletes, 1);
    });
    for (const mode of ['hold_before_request', 'owner_before_request', 'policy_before_request', 'reply_version_changed']) {
      await check('Deno + SQL: rechecks ' + mode + ' before body write', 'cancelled', mode, async (fixture, invoke) => {
        assert.notEqual((await invoke()).status, 200); assert.equal(fixture.apiDeletes, 0); assert.equal(fixture.bytes.size, 2);
      });
    }
    await check('Deno + SQL: a hold after worker recheck still blocks the actual metadata DELETE', 'cancelled', 'hold_before_delete', async (fixture, invoke) => {
      assert.notEqual((await invoke()).status, 200); assert.equal(fixture.apiDeletes, 1); assert.equal(fixture.bytes.size, 2);
      await fixture.db.exec('RESET ROLE');
      assert.equal((await fixture.db.query('SELECT id FROM storage.objects')).rows.length, 2);
    });
    await check('Deno + SQL: a hold between public and quarantine deletes preserves the second object', 'published', 'hold_between_objects', async (fixture, invoke) => {
      assert.notEqual((await invoke()).status, 200); assert.equal(fixture.apiDeletes, 1); assert.equal(fixture.bytes.size, 2);
      await fixture.db.exec('RESET ROLE');
      const intents = (await fixture.db.query('SELECT state FROM public.story_media_cleanup_intents WHERE plan_id=$1', [fixture.plan.plan_id])).rows;
      assert.equal(intents.filter(intent => intent.state === 'completed').length, 1);
      assert.equal(intents.filter(intent => intent.state === 'claimed').length, 1);
    });
    await check('Deno + SQL: matching ACK and GET 404 cannot replace missing catalog-delete audit', 'cancelled', 'false_ack_and_404', async (fixture, invoke) => {
      assert.notEqual((await invoke()).status, 200); assert.equal(fixture.bytes.size, 2);
      await fixture.db.exec('RESET ROLE');
      const intent = (await fixture.db.query('SELECT state,metadata_deleted_at FROM public.story_media_cleanup_intents WHERE plan_id=$1', [fixture.plan.plan_id])).rows[0];
      assert.equal(intent.state, 'unknown'); assert.equal(intent.metadata_deleted_at, null);
    });
  } finally { termination = await bridge.close(); }
  const after = sourceHashes();
  const report = { result: result.status === 0 && cases.every(entry => entry.passed) && JSON.stringify(before) === JSON.stringify(after)
      && termination.code === 0 ? 'passed' : 'failed', actualDenoExecuted: true, runtime: unit.runtime, network: 'denied',
    scope: 'Actual Deno handler + PGlite executing candidate SQL; all Storage and RPC fetches are synthetic stubs over private stdio. No hosted resources or actual Storage bytes.',
    cases, counts: { denoUnit: unit.cases.length, denoSqlIntegration: cases.length - unit.cases.length,
      passed: cases.filter(entry => entry.passed).length, failed: cases.filter(entry => !entry.passed).length },
    sourceHashesBefore: before, sourceHashesAfter: after, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
    cleanup: { denoChildClosed: true, termination, syntheticDatabasesClosed: true, serversStarted: 0 },
    physicalErasureVerified: false, accountErasurePerformed: false, productionChanged: false, releaseApproval: 'not_authorized' };
  const artifact = path.join(directory, 'verification.json');
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (report.result !== 'passed') throw new Error('Local cleanup verification failed: ' + path.relative(root, artifact) + ': '
    + JSON.stringify(cases.filter(entry => !entry.passed)));
  return { ...report, artifact: path.relative(root, artifact) };
}

module.exports = { assertRuntimeReport, runVerification, runtimeArgs };
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--local') throw new Error('Only --local is supported; no endpoint or credential arguments');
  runVerification().then(report => console.log(JSON.stringify({ result: report.result, artifact: report.artifact, counts: report.counts,
    sourceUnchanged: report.sourceUnchanged, cleanup: report.cleanup }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}