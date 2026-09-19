import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, languageOf } from './parse-diff.js';
import { classifyNoise } from './noise.js';
import { hashHunk } from './hash.js';

test('parses line numbers exactly — findings anchor to these', () => {
  const raw = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,5 @@ function doThing() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw, 'commit');
  assert.equal(file.path, 'src/a.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks[0].section, 'function doThing() {');

  const lines = file.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ],
  );
});

test('handles adds, deletes and renames', () => {
  const raw = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-bye',
    'diff --git a/old/p.ts b/new/p.ts',
    'similarity index 100%',
    'rename from old/p.ts',
    'rename to new/p.ts',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(raw, 'commit');
  assert.equal(files.length, 3);
  assert.equal(files[0].status, 'added');
  assert.equal(files[1].status, 'deleted');
  assert.equal(files[2].status, 'renamed');
  assert.equal(files[2].path, 'new/p.ts');
  assert.equal(files[2].oldPath, 'old/p.ts');
  assert.equal(files[2].similarity, 100);
});

test('binary files are flagged, not parsed as text', () => {
  const raw = [
    'diff --git a/img.png b/img.png',
    'index 111..222 100644',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw, 'commit');
  assert.equal(file.isBinary, true);
  assert.equal(file.hunks.length, 0);
});

test('"\\ No newline at end of file" is an annotation, not content', () => {
  const raw = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw, 'commit');
  assert.equal(file.hunks[0].lines.length, 2);
  assert.deepEqual(file.hunks[0].lines.map((l) => l.text), ['old', 'new']);
});

test('hunk hash ignores line numbers and context so review state survives shifts', () => {
  const shifted = (start: number) =>
    parseUnifiedDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        `@@ -${start},3 +${start},3 @@`,
        ' before',
        '-old',
        '+new',
        '',
      ].join('\n'),
      'commit',
    )[0].hunks[0];

  assert.equal(shifted(10).contentHash, shifted(400).contentHash);
});

test('hunk hash changes when the actual code changes', () => {
  const a = hashHunk([{ kind: 'add', oldLine: null, newLine: 1, text: 'const x = 1;' }]);
  const b = hashHunk([{ kind: 'add', oldLine: null, newLine: 1, text: 'const x = 2;' }]);
  assert.notEqual(a, b);
});

test('hunk hash ignores trailing whitespace', () => {
  const a = hashHunk([{ kind: 'add', oldLine: null, newLine: 1, text: 'const x = 1;' }]);
  const b = hashHunk([{ kind: 'add', oldLine: null, newLine: 1, text: 'const x = 1;   ' }]);
  assert.equal(a, b);
});

test('paths with spaces and quotes survive parsing', () => {
  const raw = [
    'diff --git a/my dir/file name.ts b/my dir/file name.ts',
    '--- a/my dir/file name.ts',
    '+++ b/my dir/file name.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(raw, 'commit');
  assert.equal(file.path, 'my dir/file name.ts');
});

test('noise classifier catches the buckets worth skipping', () => {
  const f = (path: string, extra: Partial<Parameters<typeof classifyNoise>[0]> = {}) =>
    classifyNoise(
      { path, status: 'modified', isBinary: false, additions: 1, deletions: 1, ...extra },
      new Set(),
    );

  assert.equal(f('pnpm-lock.yaml'), 'lockfile');
  assert.equal(f('packages/app/dist/main.js'), 'generated');
  assert.equal(f('src/api.pb.go'), 'generated');
  assert.equal(f('vendor/lib/x.go'), 'vendored');
  assert.equal(f('src/__snapshots__/a.snap'), 'snapshot-fixture');
  assert.equal(f('img.png', { isBinary: true }), 'binary');
  assert.equal(f('src/huge.ts', { additions: 3000, deletions: 0 }), 'oversized');
  assert.equal(f('src/real.ts'), null, 'ordinary source must not be classified as noise');
});

test('whitespace-only changes are noise', () => {
  const r = classifyNoise(
    { path: 'src/fmt.ts', status: 'modified', isBinary: false, additions: 4, deletions: 4 },
    new Set(['src/fmt.ts']),
  );
  assert.equal(r, 'whitespace-only');
});

test('pure renames are noise but renames with edits are not', () => {
  const pure = classifyNoise(
    { path: 'b.ts', status: 'renamed', isBinary: false, additions: 0, deletions: 0, similarity: 100 },
    new Set(),
  );
  const edited = classifyNoise(
    { path: 'b.ts', status: 'renamed', isBinary: false, additions: 5, deletions: 2, similarity: 82 },
    new Set(),
  );
  assert.equal(pure, 'pure-rename');
  assert.equal(edited, null);
});

test('language detection drives syntax highlighting', () => {
  assert.equal(languageOf('a/b/c.tsx'), 'tsx');
  assert.equal(languageOf('Dockerfile'), 'docker');
  assert.equal(languageOf('Makefile'), 'make');
  assert.equal(languageOf('x.unknownext'), undefined);
});
