'use strict';

const targets = Object.freeze({ dev: 'release', release: 'beta', beta: 'main' });

function promotionDecision(source, testedCommit, currentCommit) {
  const target = Object.hasOwn(targets, source) ? targets[source] : null;
  if (!target) throw new Error('Only dev, release and beta can be promoted.');
  if (![testedCommit, currentCommit].every(value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value))) {
    throw new Error('Promotion requires full tested and current commit hashes.');
  }
  return { target, eligible: testedCommit === currentCommit };
}

module.exports = { promotionDecision };

if (require.main === module) {
  try {
    const result = promotionDecision(...process.argv.slice(2));
    process.stdout.write(result.eligible ? 'current\n' : 'stale\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}