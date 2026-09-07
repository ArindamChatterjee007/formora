'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promotionDecision } = require('../scripts/promotion-policy.cjs');
const testedCommit = '1'.repeat(40);
const newerCommit = '2'.repeat(40);

test('Promotion follows development, QAT, beta and production in order', () => {
  for (const [source, target] of [['dev', 'release'], ['release', 'beta'], ['beta', 'main']]) {
    assert.deepEqual(promotionDecision(source, testedCommit, testedCommit), { target, eligible: true });
  }
});

test('A successful older CI run cannot promote a changed branch', () => {
  for (const source of ['dev', 'release', 'beta']) {
    assert.equal(promotionDecision(source, testedCommit, newerCommit).eligible, false);
  }
});

test('Unknown routes and incomplete commit evidence fail closed', () => {
  for (const source of ['main', 'production', 'feature/test', '__proto__', 'toString', null]) {
    assert.throws(() => promotionDecision(source, testedCommit, testedCommit), /Only dev/);
  }
  for (const commit of ['', '1234567', undefined, 'z'.repeat(40)]) {
    assert.throws(() => promotionDecision('dev', commit, testedCommit), /full tested/);
    assert.throws(() => promotionDecision('dev', testedCommit, commit), /full tested/);
  }
});