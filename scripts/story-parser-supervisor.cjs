'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const limits = Object.freeze({ milliseconds: 10000, cleanupReserveFraction: 0.1,
  inputBytes: 26214400, outputBytes: 2048, errorBytes: 1024 });

class SupervisorFailure extends Error {
  constructor(code, evidence = {}) {
    super(code);
    this.code = code;
    this.evidence = evidence;
  }
}

function inspectGroup(group) {
  if (!group) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const probe = spawn('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
      env: { LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, killSignal: 'SIGKILL',
    });
    const chunks = [];
    let size = 0, failed = false;
    probe.on('error', () => { failed = true; });
    probe.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 131072) { failed = true; probe.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    probe.on('close', (code, signal) => {
      if (failed || code !== 0 || signal) { reject(new SupervisorFailure('termination_unconfirmed')); return; }
      const members = [];
      for (const line of Buffer.concat(chunks).toString('ascii').trim().split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) { reject(new SupervisorFailure('termination_unconfirmed')); return; }
        if (Number(match[2]) === group) members.push({ pid: Number(match[1]), state: match[3] });
      }
      resolve(members);
    });
  });
}

function createParserSupervisor({ watchdog, executable, args = [], cacheDirectory }) {
  if (!['darwin', 'linux'].includes(process.platform) || !path.isAbsolute(watchdog) || !path.isAbsolute(executable)
    || !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))
    || (cacheDirectory !== undefined && !path.isAbsolute(cacheDirectory))) {
    throw new SupervisorFailure('invalid_configuration');
  }
  const commandArgs = [...args];
  let active = false;
  let cleanup = Promise.resolve(null);
  return {
    get active() { return active; },
    get cleanup() { return cleanup; },
    async run(input, { deadline, signal } = {}) {
      const started = performance.now();
      if (!Number.isFinite(deadline) || deadline - started > limits.milliseconds) throw new SupervisorFailure('invalid_deadline');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new SupervisorFailure('invalid_signal');
      if (signal?.aborted || deadline <= started) throw new SupervisorFailure('validation_timeout');
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > limits.inputBytes) {
        throw new SupervisorFailure('invalid_input');
      }
      if (active) throw new SupervisorFailure('parser_busy');
      active = true;
      let ownedInput, spawned = false;
      let completeCleanup;
      try {
        ownedInput = Buffer.from(input);
        const cleanupReserveMs = Math.ceil((deadline - started) * limits.cleanupReserveFraction);
        const executionDeadline = deadline - cleanupReserveMs;
        const remaining = Math.floor(executionDeadline - performance.now());
        if (remaining < 1) throw new SupervisorFailure('validation_timeout');
        cleanup = new Promise(resolve => { completeCleanup = resolve; });
        return await new Promise((resolve, reject) => {
          let failure, timer, executionTimer, responseSettled = false, groupSignalSent = false, stdoutBytes = 0, stderrBytes = 0;
          const chunks = [];
          const child = spawn(watchdog, ['--signal=KILL', remaining / 1000 + 's', executable, ...commandArgs], {
            detached: true, shell: false, env: { LANG: 'C', NO_COLOR: '1', ...(cacheDirectory ? { DENO_DIR: cacheDirectory } : {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          spawned = true;
          const evidence = { deadlineBudgetMs: deadline - started, processGroup: child.pid ?? null, closeObserved: false,
            executionBudgetMs: executionDeadline - started, cleanupReserveMs,
            confirmationScope: 'process_group_only', descendantEscapePrevented: false };
          function killGroup() {
            if (!child.pid || groupSignalSent) return;
            try { process.kill(-child.pid, 'SIGKILL'); groupSignalSent = true; }
            catch (error) {
              evidence.groupSignalError = error.code;
              if (error.code !== 'ESRCH') evidence.directChildSignalSent = child.kill('SIGKILL');
            }
          }
          function stop(code, rejectNow = false) {
            failure ||= code;
            killGroup();
            if (rejectNow) {
              if (code === 'validation_timeout') failure = code;
              child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
              if (!responseSettled) {
                responseSettled = true;
                reject(new SupervisorFailure(failure, { ...evidence, stdoutBytes, stderrBytes,
                  groupTerminationConfirmed: false, cleanupPending: true, elapsedMs: performance.now() - started }));
              }
            }
          }
          const abort = () => stop('validation_timeout', true);
          executionTimer = setTimeout(() => stop('validation_timeout'), Math.max(1, executionDeadline - performance.now()));
          timer = setTimeout(abort, Math.max(1, deadline - performance.now()));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          child.on('error', () => stop('supervisor_unavailable'));
          child.stdin.on('error', () => stop('input_unavailable'));
          child.stdout.on('error', () => stop('invalid_output'));
          child.stderr.on('error', () => stop('invalid_output'));
          child.stdout.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > limits.outputBytes) stop('invalid_output');
            else if (performance.now() >= deadline) stop('validation_timeout');
            else if (!failure) chunks.push(chunk);
          });
          child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > limits.errorBytes) stop('invalid_output');
          });
          child.on('exit', killGroup);
          child.on('close', async (exitCode, exitSignal) => {
            const closed = performance.now();
            Object.assign(evidence, { closeObserved: true, exitCode, exitSignal, stdoutBytes, stderrBytes,
              groupSignalSent, closedElapsedMs: closed - started, closedBeforeDeadline: closed <= deadline });
            let groupTerminationConfirmed;
            try {
              evidence.groupChecks = [];
              for (let attempt = 0; attempt < 3; attempt++) {
                evidence.groupMembers = await inspectGroup(child.pid);
                evidence.groupChecks.push({ members: evidence.groupMembers, elapsedMs: performance.now() - started });
                groupTerminationConfirmed = evidence.groupMembers.every(member => member.state.startsWith('Z'));
                if (groupTerminationConfirmed || !groupSignalSent) break;
              }
            } catch { groupTerminationConfirmed = false; }
            clearTimeout(timer);
            clearTimeout(executionTimer);
            signal?.removeEventListener('abort', abort);
            Object.assign(evidence, { groupTerminationConfirmed, cleanupPending: false, elapsedMs: performance.now() - started });
            if (signal?.aborted || performance.now() >= deadline || !evidence.closedBeforeDeadline) failure = 'validation_timeout';
            if ((exitSignal === 'SIGKILL' || exitCode === 137) && (!failure || failure === 'input_unavailable')) failure = 'validation_timeout';
            if (!groupTerminationConfirmed) failure = 'termination_unconfirmed';
            if (exitCode !== 0 || exitSignal) failure ||= 'parser_failed';
            if (!stdoutBytes) failure ||= 'invalid_output';
            if (exitCode === 1 && !exitSignal && stdoutBytes <= limits.outputBytes) {
              try {
                const diagnostic = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (Object.keys(diagnostic).sort().join(',') === 'error,phase'
                  && ['invalid_media', 'size_mismatch', 'parser_unavailable'].includes(diagnostic.error)
                  && ['permissions', 'environment', 'request', 'input', 'resource', 'inspection'].includes(diagnostic.phase)) {
                  evidence.parserDiagnostic = diagnostic;
                }
              } catch {}
            }
            ownedInput.fill(0);
            evidence.elapsedMs = performance.now() - started;
            if (performance.now() >= deadline) failure = 'validation_timeout';
            active = !groupTerminationConfirmed;
            completeCleanup(evidence);
            if (responseSettled) return;
            responseSettled = true;
            if (failure) reject(new SupervisorFailure(failure, evidence));
            else resolve({ output: Buffer.concat(chunks), evidence });
          });
          child.stdin.end(ownedInput);
        });
      } catch (error) {
        if (!spawned) {
          ownedInput?.fill(0);
          active = false;
          completeCleanup?.({ closeObserved: false, jobStarted: false });
        }
        throw error;
      }
    },
  };
}

module.exports = { createParserSupervisor, SupervisorFailure, limits };