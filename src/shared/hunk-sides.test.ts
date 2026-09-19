import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiffLine } from './types.js';
import { mapHunkSides } from './hunk-sides.js';

/** Terse hunk builder: `c`ontext, `a`dd, `d`el. */
function lines(spec: [kind: 'c' | 'a' | 'd', text: string][]): DiffLine[] {
  const kindOf = { c: 'context', a: 'add', d: 'del' } as const;
  return spec.map(([k, text]) => ({
    kind: kindOf[k],
    oldLine: k === 'a' ? null : 1,
    newLine: k === 'd' ? null : 1,
    text,
  }));
}

/**
 * A reader standing in for the tokenizer: one result per line, carrying the
 * line's own text. Anything misplaced by the mapping shows up as a result whose
 * text is not the text of the line it landed on.
 */
const echo = (code: string) => code.split('\n');

/** Records what each side was actually asked to read. */
function recording() {
  const seen: string[][] = [];
  return {
    seen,
    read: (code: string) => {
      const out = code.split('\n');
      seen.push(out);
      return out;
    },
  };
}

test('every line gets back its own text, across both sides', () => {
  const hunk = lines([
    ['c', '/**'],
    ['d', ' * old prose'],
    ['a', ' * new prose'],
    ['c', ' */'],
    ['d', 'const x = 1;'],
    ['a', 'const x = 2;'],
  ]);
  const out = mapHunkSides(hunk, echo);
  assert.ok(out);
  assert.deepEqual(out, hunk.map((l) => l.text));
});

test('a hunk with changes on one side only reads that side once', () => {
  const adds = recording();
  const added = lines([['c', 'before'], ['a', 'new line'], ['c', 'after']]);
  assert.deepEqual(mapHunkSides(added, adds.read), added.map((l) => l.text));
  assert.equal(adds.seen.length, 1, 'pure additions should not read the old side');
  assert.deepEqual(adds.seen[0], ['before', 'new line', 'after']);

  const dels = recording();
  const removed = lines([['c', 'before'], ['d', 'gone line'], ['c', 'after']]);
  assert.deepEqual(mapHunkSides(removed, dels.read), removed.map((l) => l.text));
  assert.equal(dels.seen.length, 1, 'pure deletions should not read the new side');
  assert.deepEqual(dels.seen[0], ['before', 'gone line', 'after']);
});

test('each side sees only its own lines', () => {
  const r = recording();
  mapHunkSides(lines([['c', 'ctx'], ['d', 'old'], ['a', 'new']]), r.read);
  assert.equal(r.seen.length, 2);
  assert.deepEqual(r.seen, [['ctx', 'old'], ['ctx', 'new']]);
});

test('an empty line keeps its row rather than collapsing it', () => {
  const hunk = lines([['a', 'x'], ['c', ''], ['a', 'y']]);
  const out = mapHunkSides(hunk, echo);
  assert.ok(out);
  assert.equal(out.length, 3);
  assert.equal(out[1], '');
});

test('a reader returning the wrong number of lines aborts the whole hunk', () => {
  // Misaligned colours are confident nonsense; no colours is honest.
  const short = (code: string) => code.split('\n').slice(1);
  assert.equal(mapHunkSides(lines([['a', 'one'], ['a', 'two']]), short), null);
  assert.equal(mapHunkSides(lines([['a', 'one']]), () => null), null);
});

test('an all-context hunk still resolves every line', () => {
  const hunk = lines([['c', 'a'], ['c', 'b']]);
  assert.deepEqual(mapHunkSides(hunk, echo), ['a', 'b']);
});
