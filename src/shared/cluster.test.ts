import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterFiles, declaredNames, isTestPath, stemOf, type ClusterFile } from './cluster.js';

const file = (p: Partial<ClusterFile> & { path: string }): ClusterFile => ({
  additions: 5,
  deletions: 1,
  salience: 3,
  symbols: [],
  addedText: [],
  allText: [],
  sessionIds: [],
  ...p,
});

/** The group a path landed in, so tests assert on partitioning not on order. */
const groupOf = (groups: ReturnType<typeof clusterFiles>, path: string) =>
  groups.find((g) => g.paths.includes(path));

test('stems pair an implementation with its test', () => {
  assert.equal(stemOf('src/git/units.ts'), 'units');
  assert.equal(stemOf('src/git/units.test.ts'), 'units');
  assert.equal(stemOf('src/git/__tests__/units.ts'), 'units');
  assert.equal(stemOf('src/web/Foo.module.css'), 'foo');
  assert.ok(isTestPath('src/git/units.test.ts'));
  assert.ok(isTestPath('tests/smoke.ts'));
  assert.ok(!isTestPath('src/git/units.ts'));
});

test('a source file and its test group together', () => {
  const groups = clusterFiles([
    file({ path: 'src/git/units.ts' }),
    file({ path: 'src/git/units.test.ts' }),
    file({ path: 'docs/README.md' }),
  ]);
  const g = groupOf(groups, 'src/git/units.ts');
  assert.ok(g, 'source file is in a group');
  assert.ok(g.paths.includes('src/git/units.test.ts'), 'its test came with it');
  assert.ok(!g.paths.includes('docs/README.md'), 'an unrelated doc did not');
});

test('a definition and its call site group on the shared symbol', () => {
  const groups = clusterFiles([
    file({
      path: 'src/git/resolve.ts',
      addedText: ['export function resolveBaseRef(repo: string) {'],
      allText: ['export function resolveBaseRef(repo: string) {'],
    }),
    file({
      path: 'src/server/snapshot.ts',
      addedText: ['  const ref = await resolveBaseRef(root)'],
      allText: ['  const ref = await resolveBaseRef(root)'],
    }),
  ]);
  assert.equal(groups.length, 1, 'definition and call site are one change');
  assert.match(groups[0].reason, /resolveBaseRef|shared symbols/);
});

test('common identifiers never union unrelated files', () => {
  // `data` and `init` appear everywhere. If these union, one bad edge collapses
  // the whole diff into a single group and the feature is worse than useless.
  const groups = clusterFiles([
    file({
      path: 'src/alpha/one.ts',
      addedText: ['const data = 1', 'function init() {}'],
      allText: ['const data = 1', 'function init() {}'],
    }),
    file({
      path: 'src/beta/two.ts',
      addedText: ['const data = 2'],
      allText: ['const data = 2', 'init()'],
    }),
  ]);
  assert.equal(groups.length, 2, 'different directories, no meaningful shared name');
});

test('a session touching most of the diff is not used as a signal', () => {
  // One long-lived agent run that edited everything partitions nothing.
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) =>
    file({ path: `src/${n}/${n}.ts`, sessionIds: ['sess-1'], sessionLabel: 'Big refactor' }),
  );
  const groups = clusterFiles(files);
  assert.ok(groups.length > 1, 'the non-discriminating session did not merge everything');
  for (const g of groups) {
    assert.ok(!g.reasons.includes('session'), 'and no group claims session as its reason');
  }
});

test('a small shared session does group, and names the group', () => {
  const groups = clusterFiles([
    file({ path: 'src/alpha/one.ts', sessionIds: ['s1'], sessionLabel: 'Forward-test change-map' }),
    file({ path: 'src/beta/two.ts', sessionIds: ['s1'], sessionLabel: 'Forward-test change-map' }),
    file({ path: 'src/gamma/three.ts' }),
    file({ path: 'src/delta/four.ts' }),
    file({ path: 'src/epsilon/five.ts' }),
  ]);
  const g = groupOf(groups, 'src/alpha/one.ts');
  assert.ok(g!.paths.includes('src/beta/two.ts'));
  assert.equal(g!.label, 'Forward-test change-map');
  assert.match(g!.reason, /same agent session/);
});

test('reading order puts the definition first and the test last', () => {
  const groups = clusterFiles([
    file({
      path: 'src/git/units.test.ts',
      salience: 1,
      allText: ['expect(resolveBaseRef(x))'],
    }),
    file({
      path: 'src/server/snapshot.ts',
      salience: 9,
      allText: ['const ref = await resolveBaseRef(root)'],
    }),
    file({
      path: 'src/git/units.ts',
      salience: 5,
      addedText: ['export function resolveBaseRef(repo: string) {'],
      allText: ['export function resolveBaseRef(repo: string) {'],
    }),
  ]);
  assert.equal(groups.length, 1);
  // snapshot.ts has the highest salience, but it USES resolveBaseRef, so the
  // file defining it must come first for the group to read as a story.
  assert.deepEqual(groups[0].paths, [
    'src/git/units.ts',
    'src/server/snapshot.ts',
    'src/git/units.test.ts',
  ]);
});

test('with no detectable edges the order is exactly salience order', () => {
  const groups = clusterFiles([
    file({ path: 'src/one/a.ts', salience: 2 }),
    file({ path: 'src/one/b.ts', salience: 8 }),
    file({ path: 'src/one/c.ts', salience: 5 }),
  ]);
  assert.equal(groups.length, 1, 'same directory is the fallback grouping');
  assert.deepEqual(groups[0].paths, ['src/one/b.ts', 'src/one/c.ts', 'src/one/a.ts']);
});

test('mutual references do not drop a file', () => {
  // A cycle strands nodes in Kahn's algorithm. Showing a file out of order is
  // survivable; silently losing one from the review is not.
  const groups = clusterFiles([
    file({
      path: 'src/x/alpha.ts',
      addedText: ['export function alphaThing() { betaThing() }'],
      allText: ['export function alphaThing() { betaThing() }'],
    }),
    file({
      path: 'src/x/beta.ts',
      addedText: ['export function betaThing() { alphaThing() }'],
      allText: ['export function betaThing() { alphaThing() }'],
    }),
  ]);
  const all = groups.flatMap((g) => g.paths);
  assert.equal(all.length, 2);
  assert.deepEqual([...all].sort(), ['src/x/alpha.ts', 'src/x/beta.ts']);
});

test('every file appears in exactly one group', () => {
  const paths = [
    'src/git/units.ts', 'src/git/units.test.ts', 'src/git/snapshot.ts',
    'src/web/DiffView.tsx', 'src/web/theme.css', 'docs/README.md',
    'package.json', 'src/server/index.ts',
  ];
  const groups = clusterFiles(paths.map((p) => file({ path: p })));
  const seen = groups.flatMap((g) => g.paths);
  assert.equal(seen.length, paths.length, 'no duplicates and nothing lost');
  assert.deepEqual([...seen].sort(), [...paths].sort());
});

test('a rename keeps the old and new path together', () => {
  const groups = clusterFiles([
    file({ path: 'src/new/home.ts', oldPath: 'src/old/home.ts' }),
    file({ path: 'src/old/home.ts' }),
  ]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].reasons.includes('rename'));
});

test('a local binding inside a function body is not a definition', () => {
  // A real failure this pins: `const usage = ...` two spaces deep inside a test
  // made that test look like the definition of `usage`, which every caller names
  // — so the test sorted ahead of the source it tests.
  const local = declaredNames(['  const usage = deltas.findLast((d) => d.usage)?.usage']);
  assert.ok(!local.has('usage'), 'an indented, unexported binding declares nothing');

  const groups = clusterFiles([
    file({
      path: 'src/codecs/encode.ts',
      salience: 8,
      addedText: ['        usage: { input_tokens: 0 },'],
      allText: ['        usage: { input_tokens: 0 },', 'createProjector()'],
    }),
    file({
      path: 'src/codecs/encode.integration.test.ts',
      salience: 1,
      addedText: ['  const usage = deltas.findLast((d) => d.usage)?.usage'],
      allText: ['  const usage = deltas.findLast((d) => d.usage)?.usage', 'createProjector()'],
    }),
  ]);
  assert.equal(groups.length, 1, 'still grouped, on the genuinely shared symbol');
  assert.deepEqual(groups[0].paths, [
    'src/codecs/encode.ts',
    'src/codecs/encode.integration.test.ts',
  ], 'and the source comes before the test');
});

test('declaration detection covers the common forms', () => {
  const names = declaredNames([
    'export function resolveBase() {}',
    'class SnapshotEngine {}',
    'export const reviewUnits = []',
    'interface ClusterGroup {}',
    'def compute_digest(x):',
    'const x = 1',
  ]);
  assert.ok(names.has('resolveBase'));
  assert.ok(names.has('SnapshotEngine'));
  assert.ok(names.has('reviewUnits'));
  assert.ok(names.has('ClusterGroup'));
  assert.ok(names.has('compute_digest'));
  assert.ok(!names.has('x'), 'single-character bindings are noise');
});
