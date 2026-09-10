'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createParserSupervisor, limits } = require('../scripts/story-parser-supervisor.cjs');
const watchdog = process.env.STORY_MEDIA_TIMEOUT || (process.platform === 'darwin' ? '/opt/homebrew/bin/gtimeout' : '/usr/bin/timeout');
const fixture = path.join(__dirname, 'fixtures/story-parser-supervisor.cjs');
const supervisorFor = mode => createParserSupervisor({ watchdog, executable: process.execPath, args: [fixture, mode] });

test('An external watchdog kills non-yielding work and never accepts its early output', async () => {
  const supervisor = createParserSupervisor({ watchdog, executable: process.execPath,
    args: [path.join(__dirname, 'fixtures/story-parser-supervisor.cjs')] });
  const pending = supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 2000 });
  assert.equal(supervisor.active, true);
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'validation_timeout');
    assert.ok(error.evidence.stdoutBytes > 0);
    assert.equal(Object.hasOwn(error, 'output'), false);
    return true;
  });
  const evidence = await supervisor.cleanup;
  assert.equal(evidence.closeObserved, true);
  assert.ok(evidence.exitSignal === 'SIGKILL' || evidence.exitCode === 137);
  assert.equal(evidence.groupTerminationConfirmed, true);
  assert.equal(supervisor.active, false);
});

test('GNU watchdog alone stops non-yielding work without the supervisor timer', async () => {
  const child = spawn(watchdog, ['--signal=KILL', '2s', process.execPath, fixture], {
    detached: true, env: { LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let safetyFired = false, outputBytes = 0;
  const safety = setTimeout(() => {
    safetyFired = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 5000);
  child.stdout.on('data', chunk => { outputBytes += chunk.length; });
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        try {
          assert.ok(signal === 'SIGKILL' || code === 137);
          assert.ok(outputBytes > 0);
          assert.equal(safetyFired, false);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  } finally {
    clearTimeout(safety);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('Successful bytes are accepted only after process and group closure without inherited secrets', async () => {
  const supervisor = supervisorFor('success');
  const input = Buffer.from('synthetic-parser-input');
  const result = await supervisor.run(input, { deadline: performance.now() + 3000 });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.bytes, input.length);
  assert.equal(parsed.sha256, createHash('sha256').update(input).digest('hex'));
  assert.ok(parsed.environment.includes('LANG'));
  assert.ok(parsed.environment.includes('NO_COLOR'));
  const allowed = ['LANG', 'NO_COLOR', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  assert.ok(parsed.environment.every(name => allowed.includes(name)));
  assert.equal(result.evidence.closeObserved, true);
  assert.equal(result.evidence.groupTerminationConfirmed, true);
  assert.equal(result.evidence.closedBeforeDeadline, true);
  assert.equal(supervisor.active, false);
});

test('A successful direct child cannot leave its non-yielding descendant running', async () => {
  const result = await supervisorFor('descendant').run(Uint8Array.of(1), { deadline: performance.now() + 3000 });
  const { descendant } = JSON.parse(result.output);
  assert.ok(Number.isSafeInteger(descendant));
  assert.equal(result.evidence.groupTerminationConfirmed, true);
  assert.ok(result.evidence.groupMembers.every(member => member.state.startsWith('Z')));
  assert.equal(result.evidence.confirmationScope, 'process_group_only');
  assert.equal(result.evidence.descendantEscapePrevented, false);
});

test('Cancellation keeps admission occupied until actual cleanup and never publishes an ACK', async () => {
  const supervisor = supervisorFor('busy');
  const controller = new AbortController();
  const pending = supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 3000, signal: controller.signal });
  await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 3000 }), { code: 'parser_busy' });
  controller.abort();
  assert.equal(supervisor.active, true);
  await assert.rejects(pending, { code: 'validation_timeout' });
  assert.equal((await supervisor.cleanup).groupTerminationConfirmed, true);
  assert.equal(supervisor.active, false);
});

for (const mode of ['overflow', 'stderr']) {
  test(mode + ' is bounded and rejected before normal completion', async () => {
    await assert.rejects(supervisorFor(mode).run(Uint8Array.of(1), { deadline: performance.now() + 3000 }), error => {
      assert.equal(error.code, 'invalid_output');
      assert.equal(error.evidence.groupTerminationConfirmed, true);
      assert.equal(Object.hasOwn(error, 'output'), false);
      return true;
    });
  });
}

test('Expired admission, excessive bytes and extended deadlines allocate no job', async () => {
  const supervisor = supervisorFor('success');
  await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() - 1 }), { code: 'validation_timeout' });
  await assert.rejects(supervisor.run(Buffer.alloc(0), { deadline: performance.now() + 1000 }), { code: 'invalid_input' });
  await assert.rejects(supervisor.run(Buffer.alloc(limits.inputBytes + 1), { deadline: performance.now() + 1000 }), { code: 'invalid_input' });
  await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 20000 }), { code: 'invalid_deadline' });
  await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 1000, signal: {} }), { code: 'invalid_signal' });
  assert.equal(supervisor.active, false);
});

test('The complete 25 MiB input preserves byte identity within the retained deadline', async () => {
  const input = Buffer.alloc(limits.inputBytes, 17);
  const result = await supervisorFor('success').run(input, { deadline: performance.now() + limits.milliseconds });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.bytes, limits.inputBytes);
  assert.equal(parsed.sha256, createHash('sha256').update(input).digest('hex'));
  assert.equal(input.at(-1), 17);
  assert.equal(result.evidence.groupTerminationConfirmed, true);
});

test('An unavailable watchdog fails closed and does not occupy admission forever', async () => {
  const supervisor = createParserSupervisor({ watchdog: '/nonexistent/formora-watchdog', executable: process.execPath, args: [fixture] });
  await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 2000 }), { code: 'supervisor_unavailable' });
  assert.equal(supervisor.active, false);
});

test('An escaped pipe holder cannot delay deadline rejection or become a containment claim', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-supervisor-'));
  const pidFile = path.join(directory, 'owned-child.pid');
  const supervisor = createParserSupervisor({ watchdog, executable: process.execPath, args: [fixture, 'escaped', pidFile] });
  let escapedPid;
  try {
    await assert.rejects(supervisor.run(Uint8Array.of(1), { deadline: performance.now() + 2000 }), { code: 'validation_timeout' });
    escapedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
    const evidence = await supervisor.cleanup;
    assert.equal(evidence.confirmationScope, 'process_group_only');
    assert.equal(evidence.descendantEscapePrevented, false);
    assert.equal(evidence.groupTerminationConfirmed, true);
    assert.doesNotThrow(() => process.kill(escapedPid, 0));
  } finally {
    if (escapedPid) { try { process.kill(escapedPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A full input blocked on stdin still rejects as timeout and preserves caller bytes', async () => {
  const input = Buffer.alloc(limits.inputBytes, 19);
  const supervisor = supervisorFor('busy');
  await assert.rejects(supervisor.run(input, { deadline: performance.now() + 1000 }), { code: 'validation_timeout' });
  assert.equal((await supervisor.cleanup).groupTerminationConfirmed, true);
  assert.equal(input.at(0), 19);
  assert.equal(input.at(-1), 19);
});

test('Nonzero and empty responses fail distinctly, and successful cleanup permits reuse', async () => {
  await assert.rejects(supervisorFor('fail').run(Uint8Array.of(1), { deadline: performance.now() + 3000 }), { code: 'parser_failed' });
  await assert.rejects(supervisorFor('empty').run(Uint8Array.of(1), { deadline: performance.now() + 3000 }), { code: 'invalid_output' });
  const supervisor = supervisorFor('success');
  for (const value of [13, 21]) {
    const result = await supervisor.run(Uint8Array.of(value), { deadline: performance.now() + 3000 });
    assert.equal(JSON.parse(result.output).sha256, createHash('sha256').update(Uint8Array.of(value)).digest('hex'));
    assert.equal(supervisor.active, false);
  }
});