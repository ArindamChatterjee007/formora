'use strict';
// Opt-in test/fingerprint separation for the PUBLIC customer-app repository.
// Selection is a fixed, reviewed list: nothing here scans test sources to decide what runs.

const PUBLIC_SCOPE = 'public-product';
const FULL_SCOPE = 'full';

// Test files that read, write or serve real private office records under office/.
const PRIVATE_RECORD_TESTS = [
  { file: 'tests/account-rights-data-scope.test.cjs', records: ['office/account-data-scope.json'], gap: 'Account rights data-scope matrix conformance to the private office record' },
  { file: 'tests/benefit-audit.test.cjs', records: ['office/benefit-audit-2026-09-05.json', 'office/board.json'], gap: 'Benefit/paid-entitlement audit reconciliation against the private benefit audit record' },
  { file: 'tests/billing-reconciliation.test.cjs', records: ['office/billing-reconciliation-contract.json'], gap: 'Billing reconciliation report conformance to the private reconciliation contract' },
  { file: 'tests/claim-register.test.cjs', records: ['office/claim-register.json'], gap: 'Public marketing/claim wording conformance to the private claim register' },
  { file: 'tests/dependency-audit.test.cjs', records: ['office/dependency-audit.json'], gap: 'Dependency audit conformance to the private dependency record' },
  { file: 'tests/funnel-events.test.cjs', records: ['office/measurement-contract.json', 'office/board.json'], gap: 'Funnel/measurement event conformance to the private measurement contract' },
  { file: 'tests/moderation-lifecycle.test.cjs', records: ['office/operations-2026-09-05.json'], gap: 'Moderation lifecycle conformance to the private operations record' },
  { file: 'tests/office-assignments.test.cjs', records: ['office/dashboard-model.js', 'office/board.json', 'office/planning-2026-09-05.json'], gap: 'Office assignment/workload rules' },
  { file: 'tests/office-dashboard.e2e.cjs', records: ['office/dashboard.html', 'office/dashboard.js', 'office/dashboard-model.js', 'office/board.json'], gap: 'Office dashboard browser behaviour' },
  { file: 'tests/office-dashboard.test.cjs', records: ['office/dashboard-model.js', 'office/board.json', 'office/dashboard.html', 'office/dashboard.js'], gap: 'Office dashboard model and board validation' },
  { file: 'tests/office-hosting.test.cjs', records: ['office/hosting/worker.mjs', 'office/hosting/wrangler.json'], gap: 'Private office hosting worker authorization' },
  { file: 'tests/office-launch-planning.test.cjs', records: ['office/planning-2026-09-06.json', 'office/board.json', 'office/dashboard-model.js'], gap: 'Launch planning/release-gate bookkeeping' },
  { file: 'tests/office-operations.test.cjs', records: ['office/operations-2026-09-05.json'], gap: 'Office operations record integrity' },
  { file: 'tests/office-planning.test.cjs', records: ['office/planning-2026-09-05.json', 'office/revenue-model.cjs', 'office/board.json'], gap: 'Office planning and revenue-model arithmetic' },
  { file: 'tests/office-private-snapshot.test.cjs', records: ['office/board.json', 'office/dashboard.js'], gap: 'Private snapshot allowlisting and secret exclusion' },
  { file: 'tests/office-review-coverage.test.cjs', records: ['office/qa-review-2026-09-07.json', 'office/board.json'], gap: 'Office review-coverage bookkeeping against the private QA review record' },
  { file: 'tests/office-workflow.test.cjs', records: ['office/dashboard-model.js', 'office/board.json'], gap: 'Office workflow state transitions' },
  { file: 'tests/push-subscriptions.test.cjs', records: ['office/push-rollout.json'], gap: 'Push subscription conformance to the private push rollout record' },
  { file: 'tests/qa-conventions-report.test.cjs', records: ['office/qa-conventions-2026-09-06.json', 'office/board.json'], gap: 'QA conventions report conformance to the private QA record' },
  { file: 'tests/stories-app.e2e.cjs', records: ['office/story-interactions-rollout.json'], gap: 'Story application browser flows that assert the private story interactions rollout contract' },
  { file: 'tests/stories-client.test.cjs', records: ['office/story-interactions-rollout.json'], gap: 'Story client conformance to the private story interactions rollout contract' },
  { file: 'tests/stories-viewer.e2e.cjs', records: ['office/story-interactions-rollout.json'], gap: 'Story viewer browser flows that assert the private story interactions rollout contract' },
  { file: 'tests/story-interactions.test.cjs', records: ['office/story-interactions-rollout.json'], gap: 'Story interaction API conformance to the private story interactions rollout contract' }
].map(entry => ({ ...entry, category: 'private-office-record', reason: 'Reads private office records (' + entry.records.join(', ') + ') that must not be read or published by public CI' }));

// Tests whose subject is an office-only script deliberately kept outside the public fingerprint.
const OFFICE_TOOLING_TESTS = [
  { file: 'tests/office-server.test.cjs', records: [], subject: 'scripts/office-server.cjs', gap: 'Local office preview server behaviour', category: 'office-tooling',
    reason: 'Exercises office-only tooling (scripts/office-server.cjs) that is excluded from the public fingerprint, so a public run could not detect changes to its subject' }
];

// Test files that mention an office/ path only as their own throwaway fixture, never a repository office record.
const FIXTURE_ONLY_OFFICE_LITERALS = ['tests/native-bundle.test.cjs', 'tests/public-test-scope.test.cjs', 'tests/stage-site.test.cjs'];

const EXCLUDED_TESTS = [...PRIVATE_RECORD_TESTS, ...OFFICE_TOOLING_TESTS].sort((a, b) => a.file < b.file ? -1 : 1);
const EXCLUDED_FILES = new Set(EXCLUDED_TESTS.map(entry => entry.file));

// Repository paths that carry private office data, developer identities or office-only tooling.
const PRIVATE_PATH_PREFIXES = ['office/', 'backups/', 'dist/', '.github/agents/', 'supabase/.temp/'];
const PRIVATE_PATHS = ['.github/copilot-instructions.md', 'scripts/office-server.cjs', 'scripts/prepare-private-office.cjs', 'scripts/gen-agents.js'];

// Reviewed public application surface. Anything outside it is classified as unreviewed rather than assumed publishable.
const PUBLIC_PATH_PREFIXES = ['.github/workflows/', 'android/', 'assets/', 'css/', 'docs/', 'download/', 'guides/', 'hosting/', 'icons/', 'ios/', 'js/', 'scripts/', 'supabase/', 'tests/', 'tools/', 'www/'];
const PUBLIC_ROOT_FILES = ['.gitignore', 'PIPELINE.md', 'README.md', 'SECURITY.md', 'SOCIAL_SPEC.md', 'capacitor.config.json', 'index.html', 'legal.html',
  'manifest.webmanifest', 'package-lock.json', 'package.json', 'push-worker.js', 'robots.txt', 'sitemap.xml', 'version.txt'];
const SECRET_LIKE = /(^|\/)(\.env[^/]*|\.ssh|\.npmrc|id_[a-z]+|[^/]*(secret|credential|password)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks|mobileprovision))(\/|$)/i;

function isPrivatePath(file) {
  return PRIVATE_PATHS.includes(file) || EXCLUDED_FILES.has(file) || PRIVATE_PATH_PREFIXES.some(prefix => file.startsWith(prefix));
}

function privatePathReason(file) {
  if (EXCLUDED_FILES.has(file)) return EXCLUDED_TESTS.find(entry => entry.file === file).reason;
  if (file.startsWith('office/')) return 'Private office records and dashboard';
  if (file.startsWith('backups/') || file.startsWith('dist/') || file.startsWith('supabase/.temp/')) return 'Local snapshot or build output, never a published source input';
  if (file.startsWith('.github/agents/') || file === '.github/copilot-instructions.md') return 'Generated office/agent configuration and developer working instructions';
  return 'Office-only tooling that reads private office records';
}

// Rejects paths that a reviewed public list can never legitimately contain.
function candidateRejection(file) {
  if (typeof file !== 'string' || !file.length) return 'Empty or non-string path';
  if (/^([A-Za-z]:)?[\\/]/.test(file)) return 'Absolute path';
  if (file.includes('\\')) return 'Backslash path separator';
  if (/(^|\/)\.\.(\/|$)/.test(file)) return 'Parent-directory traversal';
  if (/(^|\/)\.(\/|$)/.test(file) || file.includes('//') || file.endsWith('/')) return 'Non-canonical path';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(file) || file.trim() !== file) return 'Control or padding character in path';
  if (/(^|\/)\.git(\/|$)/.test(file)) return 'Git metadata path';
  if (SECRET_LIKE.test(file)) return 'Credential or secret-like path';
  return null;
}

// Advisory, allowlist-first data classification of a caller-supplied file list. Performs no git, network or file IO.
// It is NOT a staging safety boundary: git staging must still use an explicit, reviewed file list. Unknown paths are
// reported as unreviewed (default deny) instead of being silently treated as publishable.
function classifyCandidateFiles(files) {
  const publicFiles = [], privateFiles = [], unreviewedFiles = [];
  for (const file of [...files].sort()) {
    const rejection = candidateRejection(file);
    if (rejection) unreviewedFiles.push({ file, reason: rejection });
    else if (isPrivatePath(file)) privateFiles.push({ file, reason: privatePathReason(file) });
    else if (PUBLIC_ROOT_FILES.includes(file) || PUBLIC_PATH_PREFIXES.some(prefix => file.startsWith(prefix))) publicFiles.push(file);
    else unreviewedFiles.push({ file, reason: 'Outside the reviewed public application allowlist; classification defaults to deny' });
  }
  return { publicFiles, privateFiles, unreviewedFiles };
}

// Pure: callers pass FORMORA_QA_SCOPE explicitly so scope never leaks in from an ambient environment.
function resolveScope(requested) {
  if (requested === undefined || requested === null || requested === '' || requested === FULL_SCOPE) return FULL_SCOPE;
  if (requested === PUBLIC_SCOPE) return PUBLIC_SCOPE;
  throw new Error('Unknown FORMORA_QA_SCOPE "' + requested + '"; use "' + FULL_SCOPE + '" or "' + PUBLIC_SCOPE + '"');
}

// Public fingerprint: every shipped application, test, runtime and workflow input, minus private office inputs
// and minus every catalogued private-office test file, which must never enter a public fingerprint or file list.
function publicPathspecs(pathspecs) {
  const kept = pathspecs.filter(spec => !isPrivatePath(spec.endsWith('/') ? spec : spec + '/'));
  return [...kept, ...PRIVATE_PATHS.map(file => ':(exclude)' + file), ...EXCLUDED_TESTS.map(entry => ':(exclude)' + entry.file),
    ...PRIVATE_PATH_PREFIXES.map(prefix => ':(exclude)' + prefix.replace(/\/$/, ''))];
}

// Splits an already-discovered file list. `suffix` selects the fixed catalogue slice for this suite so that an
// exclusion is still reported when the checkout does not contain the file at all.
function partition(files, scopeName, suffix) {
  if (resolveScope(scopeName) === FULL_SCOPE) return { files, excluded: [] };
  const slice = EXCLUDED_TESTS.filter(entry => suffix ? entry.file.endsWith(suffix) : files.includes(entry.file));
  return { files: files.filter(file => !EXCLUDED_FILES.has(file)), excluded: slice.map(entry => ({ ...entry, present: files.includes(entry.file) })) };
}

// A reviewed public checkout deliberately omits private suites, so absence is an unverified gap, never a failure.
function reviewExclusions(discovered) {
  const has = entry => discovered.includes(entry.file);
  return { present: EXCLUDED_TESTS.filter(has).map(entry => entry.file), absent: EXCLUDED_TESTS.filter(entry => !has(entry)).map(entry => entry.file) };
}

// Drift guard input: the fixed catalogue intersected with what this checkout actually has. Anything a scan detects
// beyond this set is a new, unreviewed private-record reader and must fail.
function expectedPrivateRecordTests(discovered) {
  return PRIVATE_RECORD_TESTS.filter(entry => discovered.includes(entry.file)).map(entry => entry.file).sort();
}

// Always reports the complete fixed catalogue; `present: false` marks files this checkout does not contain.
function describe(excluded = []) {
  const reported = new Map(excluded.map(entry => [entry.file, entry]));
  const catalog = EXCLUDED_TESTS.map(entry => ({ file: entry.file, category: entry.category, reason: entry.reason,
    records: entry.records, unverified: entry.gap, present: reported.get(entry.file)?.present === true }));
  const byCategory = category => catalog.filter(entry => entry.category === category).length;
  const absent = catalog.filter(entry => !entry.present).map(entry => entry.file);
  return {
    scope: PUBLIC_SCOPE,
    headline: 'Scoped public-product fixtures only. This is NOT full candidate approval and NOT release acceptance.',
    excludedTestCount: catalog.length,
    excludedPrivateOfficeRecordTests: byCategory('private-office-record'),
    excludedOfficeToolingTests: byCategory('office-tooling'),
    excludedFilesPresent: catalog.length - absent.length,
    excludedFilesAbsent: absent.length,
    absentFiles: absent,
    absenceSemantics: 'Absent exclusions are unverified, not passing. A public checkout may omit these files entirely; their absence is not evidence and does not fail this run.',
    catalog,
    coverageGaps: [...new Set(catalog.map(entry => entry.unverified))].sort(),
    fingerprintExcludes: [...PRIVATE_PATHS, ...PRIVATE_PATH_PREFIXES, ...EXCLUDED_TESTS.map(entry => entry.file)].sort()
  };
}

module.exports = { PUBLIC_SCOPE, FULL_SCOPE, EXCLUDED_TESTS, FIXTURE_ONLY_OFFICE_LITERALS, PRIVATE_PATHS, PRIVATE_PATH_PREFIXES,
  PUBLIC_PATH_PREFIXES, PUBLIC_ROOT_FILES, isPrivatePath, candidateRejection, classifyCandidateFiles, resolveScope, publicPathspecs,
  partition, reviewExclusions, expectedPrivateRecordTests, describe };
