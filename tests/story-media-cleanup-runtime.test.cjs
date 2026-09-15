'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertRuntimeReport, runVerification, runtimeArgs } = require('../scripts/verify-story-media-cleanup-runtime.cjs');

test('cleanup runtime evidence cannot substitute missing or fabricated case counts for real execution', () => {
  const report = { network: 'denied', runtime: { deno: 'synthetic-schema-only' }, cases: [{ name: 'case', passed: true }], passed: 1, failed: 0, result: 'passed' };
  assert.equal(assertRuntimeReport(report), report);
  for (const change of [{ cases: [] }, { passed: 50 }, { failed: 2 }, { network: 'hosted' }, { runtime: {} }, { result: 'unknown' }]) {
    assert.throws(() => assertRuntimeReport({ ...report, ...change }));
  }
});

if (process.env.STORY_MEDIA_CLEANUP_RUNTIME === '1') {
  test('actual offline Deno cleanup handler and canonical SQL execute end to end', { timeout: 120000 }, async () => {
    const report = await runVerification();
    assert.equal(report.result, 'passed'); assert.equal(report.actualDenoExecuted, true);
    assert.ok(report.counts.denoUnit >= 16); assert.ok(report.counts.denoSqlIntegration >= 16); assert.equal(report.counts.failed, 0);
    assert.equal(report.sourceUnchanged, true); assert.equal(report.cleanup.denoChildClosed, true);
    assert.equal(report.physicalErasureVerified, false); assert.equal(report.productionChanged, false);
  });
} else {
  test('default cleanup gate checks only local configuration; zero Deno runtime cases are claimed', () => {
    const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/cleanup-story-media/index.ts'), 'utf8');
    assert.match(source, /read\("STORY_MEDIA_CLEANUP_ENABLED"\) === "true"/);
    for (const permission of ['--deny-net', '--deny-env', '--deny-read', '--deny-write', '--cached-only', '--no-prompt']) assert.ok(runtimeArgs.includes(permission));
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../supabase/functions/cleanup-story-media/deno.json'), 'utf8'));
    assert.equal(config.nodeModulesDir, 'none'); assert.equal(config.lock, false);
  });
}