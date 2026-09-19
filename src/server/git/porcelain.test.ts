import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumstatZ } from './porcelain.js';

test('numstat -z: rename rows carry two paths after an empty third field', () => {
  const raw = '5\t2\t\0old/a.ts\0new/b.ts\0';
  assert.deepEqual(parseNumstatZ(raw), [
    { added: 5, deleted: 2, path: 'new/b.ts', oldPath: 'old/a.ts', isBinary: false },
  ]);
});

test('numstat -z: ordinary rows keep the path inline', () => {
  const raw = '10\t3\tsrc/plain.ts\0';
  assert.deepEqual(parseNumstatZ(raw), [
    { added: 10, deleted: 3, path: 'src/plain.ts', isBinary: false },
  ]);
});

test('numstat -z: binary rows report "-" and are flagged, not NaN', () => {
  const [row] = parseNumstatZ('-\t-\timg.png\0');
  assert.equal(row.isBinary, true);
  assert.equal(row.added, 0);
  assert.equal(row.deleted, 0);
});

test('numstat -z: mixed stream stays aligned across a rename', () => {
  const raw = '1\t1\tfirst.ts\0' + '5\t2\t\0old/a.ts\0new/b.ts\0' + '7\t0\tlast.ts\0';
  const rows = parseNumstatZ(raw);
  assert.deepEqual(rows.map((r) => r.path), ['first.ts', 'new/b.ts', 'last.ts']);
});

test('numstat -z: non-ASCII paths survive verbatim (this repo has emoji filenames)', () => {
  const p = 'measurement_backend/pages/01_📊_dashboard.py';
  const [row] = parseNumstatZ(`3\t1\t${p}\0`);
  assert.equal(row.path, p);
});
