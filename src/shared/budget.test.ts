import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHARD_BUDGET_USD, modelFactor, shardBudgetUsd } from './budget.js';

test('an unknown model is treated as sonnet, never guessed', () => {
  assert.equal(modelFactor(undefined), 1);
  assert.equal(modelFactor('some-future-model'), 1);
});

test('a pricier model gets a proportionally larger cap', () => {
  // The cap stops a runaway shard. Left unscaled it would abort every opus
  // shard mid-analysis, which is a total loss rather than a cheap run.
  assert.equal(shardBudgetUsd('sonnet'), SHARD_BUDGET_USD);
  assert.equal(shardBudgetUsd('opus'), SHARD_BUDGET_USD * 5);
});
