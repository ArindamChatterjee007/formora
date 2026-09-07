'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixtures, runRuntime, assertRuntimeReport } = require('../scripts/verify-story-media-runtime.cjs');

test('runtime report counts must match actual parsed cases; empty or fabricated totals never pass', () => {
  const actual = { result: 'passed', network: 'denied', runtime: { deno: 'synthetic-report-contract' }, cases: [{ name: 'one', passed: true }], passed: 1, failed: 0 };
  assert.equal(assertRuntimeReport(actual), actual);
  for (const patch of [{ passed: 37 }, { cases: [] }, { cases: [actual.cases[0], actual.cases[0]] }, { cases: [{ name: 'one', passed: 'true' }] },
    { result: 'passed', failed: 1 }, { network: 'allowed' }]) assert.throws(() => assertRuntimeReport({ ...actual, ...patch }));
});

if (process.env.STORY_MEDIA_RUNTIME === '1') test('real Deno parser workers and actual handler pass binary and hostile transport cases with network denied', { timeout: 60000 }, async context => {
  const directory = await createFixtures();
  const result = runRuntime(directory);
  assert.equal(result.network, 'denied'); assert.equal(result.failed, 0);
  assert.equal(result.actualRuntimeExecuted, true); assert.equal(result.sourceUnchanged, true); assert.ok(result.cases.length >= 41);
  context.diagnostic(JSON.stringify({ passedRuntimeCases: result.passed, evidence: result.evidence, runtime: result.runtime }));
});
else test('contract only: Story parsers are NOT executed without STORY_MEDIA_RUNTIME=1', context => {
  const folder = path.join(__dirname, '../supabase/functions/validate-story-media');
  const config = JSON.parse(fs.readFileSync(path.join(folder, 'deno.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(folder, 'deno.lock'), 'utf8'));
  assert.equal(config.imports['file-type'], 'npm:file-type@22.0.2');
  assert.equal(config.imports['mediainfo.js'], 'npm:mediainfo.js@0.3.7');
  for (const specifier of Object.values(config.imports)) assert.equal(lock.specifiers[specifier], specifier.split('@').at(-1));
  assert.match(lock.npm['mediainfo.js@0.3.7'].integrity, /^sha512-/);
  context.diagnostic(JSON.stringify({ actualRuntimeExecuted: false, actualRuntimeCases: 0,
    requires: 'STORY_MEDIA_RUNTIME=1, Deno with frozen cached dependencies, FFmpeg and installed Playwright Chromium; missing prerequisites fail, never skip.' }));
});