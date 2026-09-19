import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePrLists, relativeAge, type PrSummary } from './prlist.js';

const pr = (number: number, updatedAt: string): PrSummary => ({
  number,
  title: `PR ${number}`,
  isDraft: false,
  headRefName: `branch-${number}`,
  author: 'someone',
  updatedAt,
});

test('a PR you authored and were asked to review appears once, under yours', () => {
  const { mine, reviewing } = mergePrLists(
    [pr(1, '2026-09-18T00:00:00Z')],
    [pr(1, '2026-09-18T00:00:00Z'), pr(2, '2026-09-17T00:00:00Z')],
  );
  assert.deepEqual(mine.map((p) => p.number), [1]);
  assert.deepEqual(reviewing.map((p) => p.number), [2]);
});

test('each list is newest first', () => {
  const { mine } = mergePrLists(
    [pr(1, '2026-09-10T00:00:00Z'), pr(2, '2026-09-18T00:00:00Z'), pr(3, '2026-09-14T00:00:00Z')],
    [],
  );
  assert.deepEqual(mine.map((p) => p.number), [2, 3, 1]);
});

test('empty inputs give empty lists, not undefined', () => {
  assert.deepEqual(mergePrLists([], []), { mine: [], reviewing: [] });
});

test('the caller’s arrays are not reordered', () => {
  const input = [pr(1, '2026-09-10T00:00:00Z'), pr(2, '2026-09-18T00:00:00Z')];
  mergePrLists(input, []);
  assert.deepEqual(input.map((p) => p.number), [1, 2]);
});

test('age reads in the unit that fits the gap', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  assert.equal(relativeAge('2026-09-19T11:59:40Z', now), 'just now');
  assert.equal(relativeAge('2026-09-19T11:30:00Z', now), '30m ago');
  assert.equal(relativeAge('2026-09-19T04:00:00Z', now), '8h ago');
  assert.equal(relativeAge('2026-09-17T12:00:00Z', now), '2d ago');
  assert.equal(relativeAge('2026-07-19T12:00:00Z', now), '2mo ago');
  assert.equal(relativeAge('2024-09-19T12:00:00Z', now), '2y ago');
});

test('an unparseable timestamp renders nothing rather than NaN', () => {
  assert.equal(relativeAge('not a date'), '');
});
