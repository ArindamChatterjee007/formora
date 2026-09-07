'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  evaluatePolicy, evaluateDeployment, selectEvidence, fetchDeploymentEvidence, readPullRequest, decide
} = require('../scripts/check-stage-promotion.cjs');

const repository = 'ArindamChatterjee007/formora';
const sha = 'a'.repeat(40);
const cli = path.join(__dirname, '..', 'scripts', 'check-stage-promotion.cjs');

const pull = (base, head, overrides = {}) => ({
  base, head, sha, baseRepository: repository, headRepository: repository, ...overrides
});

const deployment = (overrides = {}) => ({ id: 41, environment: 'formora-beta-accepted', sha, created_at: '2026-09-07T00:00:00Z', ...overrides });
const status = (overrides = {}) => ({
  state: 'success', environment: 'formora-beta-accepted', environment_url: 'https://formora-beta.pages.dev/',
  created_at: '2026-09-07T00:05:00Z', ...overrides
});

const event = (base, head, overrides = {}) => ({
  repository: { full_name: repository },
  pull_request: {
    number: 7,
    base: { ref: base, repo: { full_name: repository } },
    head: { ref: head, sha, repo: { full_name: repository } },
    ...overrides
  }
});

test('Only the branch directly below a stage may promote into it', () => {
  assert.equal(evaluatePolicy(pull('release', 'dev')).ok, true);
  assert.equal(evaluatePolicy(pull('beta', 'release')).ok, true);
  assert.equal(evaluatePolicy(pull('main', 'beta')).ok, true);
  for (const [base, head] of [['release', 'beta'], ['beta', 'dev'], ['main', 'dev'], ['main', 'release'], ['release', 'feature/x']]) {
    const verdict = evaluatePolicy(pull(base, head));
    assert.equal(verdict.ok, false, base + ' <- ' + head);
    assert.match(verdict.refusals.join(' '), /cannot promote into/);
  }
  const unknown = evaluatePolicy(pull('production', 'beta'));
  assert.equal(unknown.ok, false);
  assert.match(unknown.refusals.join(' '), /not a promotion target/);
  assert.equal(evaluatePolicy(pull('__proto__', 'beta')).ok, false);
});

test('Promotions into dev are generic and require no prior-stage acceptance', () => {
  const verdict = evaluatePolicy(pull('dev', 'feature/story-media'));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.genericStage, true);
  assert.equal(verdict.requiredEnvironment, null);
});

test('Only beta and main require a recorded acceptance environment', () => {
  assert.equal(evaluatePolicy(pull('release', 'dev')).requiredEnvironment, null);
  assert.equal(evaluatePolicy(pull('beta', 'release')).requiredEnvironment, 'formora-qat-accepted');
  assert.equal(evaluatePolicy(pull('main', 'beta')).requiredEnvironment, 'formora-beta-accepted');
});

test('A full head commit SHA and one repository are required', () => {
  for (const bad of ['aaaaaaa', sha.toUpperCase(), '', null, undefined, 'z'.repeat(40)]) {
    assert.equal(evaluatePolicy(pull('main', 'beta', { sha: bad })).ok, false, String(bad));
  }
  const fork = evaluatePolicy(pull('main', 'beta', { headRepository: 'someone-else/formora' }));
  assert.equal(fork.ok, false);
  assert.match(fork.refusals.join(' '), /stay inside one repository/);
  assert.equal(evaluatePolicy(pull('main', 'beta', { headRepository: null })).ok, false);
});

test('Acceptance evidence must match the environment, the commit, a success status and an HTTPS url', () => {
  const environment = 'formora-beta-accepted';
  assert.equal(evaluateDeployment({ environment, sha, deployment: deployment(), status: status() }).ok, true);
  const cases = [
    [{ deployment: deployment({ environment: 'formora-beta' }), status: status({ environment: 'formora-beta' }) }, /is not "formora-beta-accepted"/],
    [{ deployment: deployment({ sha: 'b'.repeat(40) }), status: status() }, /not the pull-request head commit/],
    [{ deployment: deployment(), status: status({ state: 'pending' }) }, /Latest deployment status is "pending"/],
    [{ deployment: deployment(), status: status({ state: 'failure' }) }, /"failure"/],
    [{ deployment: deployment(), status: null }, /no status/],
    [{ deployment: deployment(), status: status({ environment_url: 'http://formora-beta.pages.dev/' }) }, /HTTPS environment_url/],
    [{ deployment: deployment(), status: status({ environment_url: '' }) }, /HTTPS environment_url/],
    [{ deployment: deployment(), status: status({ environment_url: 'not a url' }) }, /HTTPS environment_url/]
  ];
  for (const [record, pattern] of cases) {
    const verdict = evaluateDeployment({ environment, sha, ...record });
    assert.equal(verdict.ok, false);
    assert.match(verdict.refusals.join(' '), pattern);
  }
});

test('Missing or newer unaccepted records cannot fall back to an older success', () => {
  const environment = 'formora-beta-accepted';
  const empty = selectEvidence({ environment, sha, records: [] });
  assert.equal(empty.accepted, null);
  assert.match(empty.refusals.join(' '), /has not been recorded as accepted/);
  const mixed = selectEvidence({
    environment, sha,
    records: [
      { deployment: deployment({ id: 1 }), status: status({ state: 'pending' }) },
      { deployment: deployment({ id: 2 }), status: status() }
    ]
  });
  assert.equal(mixed.accepted, null);
  assert.match(mixed.refusals.join(' '), /pending/);
  const current = selectEvidence({ environment, sha, records: [{ deployment: deployment(), status: status() }] });
  assert.equal(current.accepted.deploymentId, 41);
  assert.equal(current.accepted.environmentUrl, 'https://formora-beta.pages.dev/');
  assert.equal(selectEvidence({ environment, sha, records: [{ deployment: deployment(), status: status({ state: 'error' }) }] }).accepted, null);
});

test('The deployment read is one bounded request sequence, never a poll', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const body = url.includes('/statuses') ? [status()] : [deployment()];
    return { ok: true, status: 200, json: async () => body };
  };
  const records = await fetchDeploymentEvidence({ repository, sha, environment: 'formora-beta-accepted', token: 't', fetchImpl });
  assert.equal(records.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/deployments\?sha=a{40}&environment=formora-beta-accepted&per_page=10$/);
  assert.match(calls[1], /\/deployments\/41\/statuses\?per_page=1$/);
});

test('A valid accepted deployment allows the promotion and reports its evidence', async () => {
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => (url.includes('/statuses') ? [status()] : [deployment()]) });
  const result = await decide({ event: event('main', 'beta'), repository, token: 'token', fetchImpl });
  assert.equal(result.decision, 'allowed');
  assert.deepEqual(result.refusals, []);
  assert.equal(result.requiredEnvironment, 'formora-beta-accepted');
  assert.equal(result.evidence.deploymentId, 41);
  assert.equal(result.evidence.environmentUrl, 'https://formora-beta.pages.dev/');
  assert.match(result.notes.join(' '), /provenance only/);
});

test('A wrong environment, a wrong commit or an unreadable API refuses the promotion', async () => {
  const wrongEnvironment = await decide({
    event: event('beta', 'release'), repository, token: 'token',
    fetchImpl: async url => ({ ok: true, status: 200, json: async () => (url.includes('/statuses')
      ? [status({ environment: 'formora-qat' })]
      : [deployment({ environment: 'formora-qat' })]) })
  });
  assert.equal(wrongEnvironment.decision, 'refused');
  assert.equal(wrongEnvironment.requiredEnvironment, 'formora-qat-accepted');

  const wrongCommit = await decide({
    event: event('main', 'beta'), repository, token: 'token',
    fetchImpl: async url => ({ ok: true, status: 200, json: async () => (url.includes('/statuses') ? [status()] : [deployment({ sha: 'c'.repeat(40) })]) })
  });
  assert.equal(wrongCommit.decision, 'refused');

  const unreadable = await decide({
    event: event('main', 'beta'), repository, token: 'token',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) })
  });
  assert.equal(unreadable.decision, 'refused');
  assert.match(unreadable.refusals.join(' '), /Could not read deployment records: GitHub API 403/);
});

test('Without a token an acceptance-gated promotion is refused, never assumed', async () => {
  let called = false;
  const result = await decide({
    event: event('main', 'beta'), repository, token: '', fetchImpl: async () => { called = true; throw new Error('unreachable'); }
  });
  assert.equal(result.decision, 'refused');
  assert.equal(called, false);
  assert.match(result.refusals.join(' '), /cannot be verified/);
});

test('A push payload is explicitly not stage acceptance', async () => {
  const result = await decide({ event: { repository: { full_name: repository }, ref: 'refs/heads/beta', after: sha }, repository, token: 'token' });
  assert.equal(result.applicable, false);
  assert.equal(result.decision, 'not-applicable');
  assert.match(result.notes.join(' '), /Branch state alone is not stage acceptance/);
  assert.equal(readPullRequest({ repository: { full_name: repository } }, repository), null);
});

test('The CLI parses a raw event payload and reports a machine-readable decision', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formora-promotion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, payload) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
  };
  const run = (file, env = {}) => {
    const options = { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_EVENT_PATH: '', ...env } };
    try {
      return { code: 0, output: execFileSync(process.execPath, [cli, '--event', file, '--json'], options) };
    } catch (error) {
      return { code: error.status, output: error.stdout || '' };
    }
  };

  const allowed = run(write('dev.json', event('dev', 'feature/x')));
  assert.equal(allowed.code, 0);
  const parsed = JSON.parse(allowed.output);
  assert.equal(parsed.decision, 'allowed');
  assert.equal(parsed.base, 'dev');
  assert.equal(parsed.sha, sha);
  assert.equal(parsed.requiredEnvironment, null);
  assert.equal(parsed.evidence, null);

  const refused = run(write('main.json', event('main', 'dev')));
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.output).decision, 'refused');

  const push = run(write('push.json', { repository: { full_name: repository }, ref: 'refs/heads/dev' }));
  assert.equal(push.code, 0);
  assert.equal(JSON.parse(push.output).decision, 'not-applicable');
});
