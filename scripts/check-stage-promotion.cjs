'use strict';

// Stage-promotion gate. Two separable parts:
//   1. A pure policy check over the pull-request shape (base/head/sha/repository).
//   2. For the two stages that require prior acceptance, one bounded read of the GitHub deployment
//      records for the exact pull-request head commit. It never polls and never waits for a state change.
// It authorises nothing on its own: refusing is a gate, allowing only means the recorded evidence exists.

const fs = require('node:fs');

const API = 'https://api.github.com';
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_DEPLOYMENTS = 10;

// dev -> release -> beta -> main. Only the branch directly below a stage may promote into it.
const STAGES = Object.freeze({
  dev: Object.freeze({ heads: null, environment: null }),
  release: Object.freeze({ heads: Object.freeze(['dev']), environment: null }),
  beta: Object.freeze({ heads: Object.freeze(['release']), environment: 'formora-qat-accepted' }),
  main: Object.freeze({ heads: Object.freeze(['beta']), environment: 'formora-beta-accepted' })
});

const CAVEAT = 'A recorded acceptance deployment proves provenance only. Whether it stands for authorised human sign-off '
  + 'depends on that environment having separately configured reviewers and its own source-bound QA evidence; this check '
  + 'establishes neither.';

const quote = value => typeof value === 'string' ? JSON.stringify(value) : String(value);
const sameRepository = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Pure. `pull` = { base, head, sha, baseRepository, headRepository }.
function evaluatePolicy(pull) {
  const { base, head, sha, baseRepository, headRepository } = pull || {};
  const stage = typeof base === 'string' && Object.hasOwn(STAGES, base) ? STAGES[base] : null;
  const refusals = [];
  if (!stage) refusals.push('Base branch ' + quote(base) + ' is not a promotion target; expected one of ' + Object.keys(STAGES).join(', ') + '.');
  if (!sameRepository(baseRepository, headRepository)) {
    refusals.push('Head repository ' + quote(headRepository) + ' is not the base repository ' + quote(baseRepository)
      + '; a stage promotion must stay inside one repository.');
  }
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) {
    refusals.push('A full 40-character lowercase head commit SHA is required; received ' + quote(sha) + '.');
  }
  if (stage && stage.heads && !stage.heads.includes(head)) {
    refusals.push('Branch ' + quote(head) + ' cannot promote into ' + quote(base) + '; only ' + stage.heads.map(quote).join(', ') + ' may.');
  }
  return {
    base: base ?? null,
    head: head ?? null,
    sha: typeof sha === 'string' ? sha : null,
    repository: sameRepository(baseRepository, headRepository) ? baseRepository : null,
    requiredEnvironment: stage ? stage.environment : null,
    genericStage: !!stage && stage.heads === null,
    ok: refusals.length === 0,
    refusals
  };
}

// Pure. One deployment plus its latest status, judged against the exact environment and commit.
function evaluateDeployment({ environment, sha, deployment, status }) {
  const refusals = [];
  if (!deployment || typeof deployment !== 'object') return { ok: false, environmentUrl: null, refusals: ['No deployment record.'] };
  if (deployment.environment !== environment) {
    refusals.push('Deployment environment ' + quote(deployment.environment) + ' is not ' + quote(environment) + '.');
  }
  if (deployment.sha !== sha) {
    refusals.push('Deployment commit ' + quote(deployment.sha) + ' is not the pull-request head commit ' + quote(sha) + '.');
  }
  if (!status || typeof status !== 'object') {
    refusals.push('Deployment ' + quote(deployment.id) + ' has no status; a pending or unreported deployment is not acceptance.');
    return { ok: false, environmentUrl: null, refusals };
  }
  if (status.state !== 'success') {
    refusals.push('Latest deployment status is ' + quote(status.state) + '; only ' + quote('success') + ' is acceptance.');
  }
  if (typeof status.environment === 'string' && status.environment !== environment) {
    refusals.push('Status environment ' + quote(status.environment) + ' is not ' + quote(environment) + '.');
  }
  const environmentUrl = typeof status.environment_url === 'string' ? status.environment_url : '';
  let parsed = null;
  try {
    parsed = environmentUrl ? new URL(environmentUrl) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    refusals.push('Deployment evidence requires an HTTPS environment_url; received ' + quote(status.environment_url) + '.');
  }
  return { ok: refusals.length === 0, environmentUrl: parsed ? parsed.href : null, refusals };
}

// Pure. `records` = [{ deployment, status }] as read from the API, newest first.
function selectEvidence({ environment, sha, records }) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) {
    return {
      accepted: null,
      refusals: ['No ' + quote(environment) + ' deployment exists for commit ' + quote(sha) + '; that stage has not been recorded as accepted.']
    };
  }
  const record = list[0];
  const verdict = evaluateDeployment({ environment, sha, deployment: record.deployment, status: record.status });
  if (!verdict.ok) return { accepted: null, refusals: verdict.refusals };
  return {
    accepted: { environment, sha, deploymentId: record.deployment.id ?? null, environmentUrl: verdict.environmentUrl,
      createdAt: record.deployment.created_at ?? null, statusCreatedAt: record.status?.created_at ?? null },
    refusals: []
  };
}

// One bounded request sequence: the deployment list, then the latest status of each returned deployment.
async function fetchDeploymentEvidence({ repository, sha, environment, token, fetchImpl = globalThis.fetch, limit = MAX_DEPLOYMENTS }) {
  const request = async url => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'formora-stage-promotion'
      }
    });
    if (!response.ok) throw new Error('GitHub API ' + response.status + ' for ' + url);
    return response.json();
  };
  const listed = await request(API + '/repos/' + repository + '/deployments?sha=' + encodeURIComponent(sha)
    + '&environment=' + encodeURIComponent(environment) + '&per_page=' + limit);
  const deployments = (Array.isArray(listed) ? listed : []).slice(0, limit);
  const records = [];
  for (const deployment of deployments) {
    const statuses = await request(API + '/repos/' + repository + '/deployments/' + deployment.id + '/statuses?per_page=1');
    records.push({ deployment, status: Array.isArray(statuses) ? statuses[0] || null : null });
  }
  return records;
}

function readPullRequest(event, repository) {
  const pull = event && typeof event === 'object' ? event.pull_request : null;
  if (!pull || typeof pull !== 'object') return null;
  return {
    number: pull.number ?? null,
    base: pull.base?.ref ?? null,
    head: pull.head?.ref ?? null,
    sha: pull.head?.sha ?? null,
    baseRepository: pull.base?.repo?.full_name ?? event.repository?.full_name ?? repository ?? null,
    headRepository: pull.head?.repo?.full_name ?? null
  };
}

async function decide({ event, repository, token, fetchImpl }) {
  const pull = readPullRequest(event, repository);
  if (!pull) {
    return {
      applicable: false,
      decision: 'not-applicable',
      notes: ['This run has no pull_request payload. Branch state alone is not stage acceptance: a push records what a '
        + 'branch contains, never that the previous stage signed it off.'],
      refusals: []
    };
  }
  const policy = evaluatePolicy(pull);
  const result = {
    applicable: true,
    decision: policy.ok ? 'allowed' : 'refused',
    pullRequest: pull.number,
    base: policy.base,
    head: policy.head,
    sha: policy.sha,
    repository: policy.repository,
    requiredEnvironment: policy.requiredEnvironment,
    evidence: null,
    notes: [CAVEAT],
    refusals: [...policy.refusals]
  };
  if (!policy.ok || !policy.requiredEnvironment) {
    if (policy.ok && policy.genericStage) {
      result.notes.unshift('Promotions into ' + quote(policy.base) + ' carry no prior-stage acceptance requirement.');
    }
    return result;
  }
  if (!token) {
    result.decision = 'refused';
    result.refusals.push('No GitHub token is available to read the ' + quote(policy.requiredEnvironment)
      + ' deployment records, so acceptance cannot be verified.');
    return result;
  }
  let records;
  try {
    records = await fetchDeploymentEvidence({
      repository: policy.repository, sha: policy.sha, environment: policy.requiredEnvironment, token, fetchImpl
    });
  } catch (error) {
    result.decision = 'refused';
    result.refusals.push('Could not read deployment records: ' + error.message);
    return result;
  }
  const evidence = selectEvidence({ environment: policy.requiredEnvironment, sha: policy.sha, records });
  if (!evidence.accepted) {
    result.decision = 'refused';
    result.refusals.push(...evidence.refusals);
    return result;
  }
  result.evidence = evidence.accepted;
  return result;
}

function parseArguments(argv) {
  const options = { event: process.env.GITHUB_EVENT_PATH || '', repository: process.env.GITHUB_REPOSITORY || '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') options.json = true;
    else if (flag === '--event') options.event = argv[++index] || '';
    else if (flag === '--repo') options.repository = argv[++index] || '';
    else throw new Error('Unknown argument ' + quote(flag));
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.event) throw new Error('An event payload path is required (--event or GITHUB_EVENT_PATH).');
  const event = JSON.parse(fs.readFileSync(options.event, 'utf8'));
  const result = await decide({ event, repository: options.repository, token: process.env.GH_TOKEN || '' });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('Stage promotion: ' + result.decision
      + (result.applicable ? ' (' + quote(result.head) + ' -> ' + quote(result.base) + ' at ' + result.sha + ')' : ''));
    if (result.evidence) console.log('  accepted by ' + result.evidence.environment + ' at ' + result.evidence.environmentUrl);
    for (const note of result.notes) console.log('  note: ' + note);
    for (const refusal of result.refusals) console.log('  refused: ' + refusal);
  }
  process.exitCode = result.decision === 'refused' ? 1 : 0;
}

module.exports = { STAGES, CAVEAT, evaluatePolicy, evaluateDeployment, selectEvidence, fetchDeploymentEvidence, readPullRequest, decide, main };

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
