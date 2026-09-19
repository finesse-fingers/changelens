import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from './parse-diff.js';
import { extractUnits, matchUnits, type ReviewUnit } from './units.js';

const diff = (hunks: string[]) =>
  parseUnifiedDiff(
    ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', ...hunks, ''].join('\n'),
    'commit',
  )[0];

test('one display hunk splits into its separate change-runs', () => {
  // Two edits five context lines apart: git -U3 emits ONE hunk, but these are
  // two independent units and must review independently.
  const file = diff([
    '@@ -10,11 +10,11 @@ function f() {',
    ' a',
    '-old1',
    '+new1',
    ' b',
    ' c',
    ' d',
    ' e',
    '-old2',
    '+new2',
    ' f',
  ]);
  assert.equal(file.hunks.length, 1, 'git gives one -U3 hunk');
  const units = extractUnits(file);
  assert.equal(units.length, 2, 'but two independent review units');
  assert.equal(units[0].additions, 1);
  assert.equal(units[1].additions, 1);
  assert.notEqual(units[0].contentHash, units[1].contentHash);
});

test('THE resume case: an edit near a reviewed unit must not reset it', () => {
  // Snapshot 1: one edit.
  const before = extractUnits(diff([
    '@@ -10,7 +10,7 @@ function f() {',
    ' a', ' b', ' c',
    '-old1',
    '+new1',
    ' d', ' e',
  ]));

  // Snapshot 2: an agent adds a second edit four lines below. With -U3 hunk
  // identity this merges into one hunk and the reviewed unit's hash vanishes.
  const after = extractUnits(diff([
    '@@ -10,11 +10,12 @@ function f() {',
    ' a', ' b', ' c',
    '-old1',
    '+new1',
    ' d', ' e',
    '-old2',
    '+new2',
    ' f', ' g',
  ]));

  assert.equal(after.length, 2);
  const matches = matchUnits(before, after);
  const carried = matches.filter((m) => m.kind === 'unchanged' || m.kind === 'moved');
  const fresh = matches.filter((m) => m.kind === 'new');
  assert.equal(carried.length, 1, 'the already-reviewed unit carries over');
  assert.equal(fresh.length, 1, 'only the genuinely new edit is unreviewed');
});

test('a unit that only shifts position is "moved", not reset', () => {
  const mk = (start: number, ctx: string) =>
    extractUnits(diff([
      `@@ -${start},5 +${start},5 @@`,
      ` ${ctx}`,
      '-old',
      '+new',
      ` ${ctx}`,
    ]));
  const before = mk(10, 'same');
  const after = mk(400, 'same');
  const [m] = matchUnits(before, after);
  assert.equal(m.kind, 'unchanged', 'identical body and context is unchanged wherever it sits');

  const relocated = mk(400, 'different');
  const [m2] = matchUnits(before, relocated);
  assert.equal(m2.kind, 'moved', 'same body under new surroundings is moved, and still carries');
});

test('editing the body in place resets that unit and nothing else', () => {
  const before = extractUnits(diff([
    '@@ -10,5 +10,5 @@', ' ctx', '-old', '+v1', ' ctx2',
  ]));
  const after = extractUnits(diff([
    '@@ -10,5 +10,5 @@', ' ctx', '-old', '+v2', ' ctx2',
  ]));
  const [m] = matchUnits(before, after);
  assert.equal(m.kind, 'edited-in-place');
});

test('a removed unit is reported gone, not silently dropped', () => {
  const before = extractUnits(diff(['@@ -10,3 +10,3 @@', ' c', '-old', '+new', ' d']));
  const matches = matchUnits(before, []);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'gone');
});

test('identical bodies in one file stay distinct via ordinal', () => {
  const file = diff([
    '@@ -10,4 +10,4 @@',
    ' a',
    '-x',
    '+y',
    ' b',
    '@@ -50,4 +50,4 @@',
    ' a',
    '-x',
    '+y',
    ' b',
  ]);
  const units = extractUnits(file);
  assert.equal(units.length, 2);
  assert.equal(units[0].contentHash, units[1].contentHash, 'same body, same content hash');
  assert.notEqual(units[0].id, units[1].id, 'but distinct identities');
  assert.deepEqual([units[0].ordinal, units[1].ordinal], [0, 1]);
});

test('leading whitespace is significant — reindenting is a real change', () => {
  const a = extractUnits(diff(['@@ -1,2 +1,2 @@', ' c', '+  indented']));
  const b = extractUnits(diff(['@@ -1,2 +1,2 @@', ' c', '+    indented']));
  assert.notEqual(a[0].contentHash, b[0].contentHash);
});

test('trailing whitespace is not significant', () => {
  const a = extractUnits(diff(['@@ -1,2 +1,2 @@', ' c', '+code']));
  const b = extractUnits(diff(['@@ -1,2 +1,2 @@', ' c', '+code   ']));
  assert.equal(a[0].contentHash, b[0].contentHash);
});

test('a clean rebase preserves every unit — no special-case code needed', () => {
  // A rebase changes every commit SHA but preserves the net diff, so units
  // match on content and all review state survives.
  const units = extractUnits(diff(['@@ -10,4 +10,4 @@ f()', ' a', '-old', '+new', ' b']));
  const rebased: ReviewUnit[] = units.map((u) => ({ ...u })); // same content, new SHAs upstream
  const matches = matchUnits(units, rebased);
  assert.ok(matches.every((m) => m.kind === 'unchanged'));
});
