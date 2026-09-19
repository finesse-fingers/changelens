import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSnapshot } from '../git/snapshot.js';
import { extractAllUnits } from '../git/units.js';
import { persistSnapshot, setUnitState, open } from './index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changelens-resume-'));
  git(dir, 'init', '-q', '-b', 'main', '.');
  writeFileSync(join(dir, 'a.ts'), ['one', 'two', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  return dir;
}

async function snapshotOf(dir: string) {
  const { snapshot, diff } = await resolveSnapshot({ kind: 'local', repoRoot: dir, baseRef: 'main' });
  return { snapshot, units: extractAllUnits(diff.files) };
}

test('an agent pushing more commits does not reset an in-progress review', async (t) => {
  const dir = setupRepo();
  const dbFile = join(dir, 'test.sqlite');
  open(dbFile);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // First pass: one edit, which the reviewer signs off on.
  writeFileSync(join(dir, 'a.ts'), ['one', 'TWO', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'first edit');

  const first = await snapshotOf(dir);
  assert.equal(first.units.length, 1);
  const p1 = persistSnapshot(first.snapshot, first.units);
  const u = first.units[0];
  setUnitState(p1.reviewId, p1.snapshotId, u.filePath, u.contentHash, u.ordinal, 'reviewed');

  // An agent pushes a second commit touching a DIFFERENT part of the same file.
  writeFileSync(join(dir, 'a.ts'), ['one', 'TWO', 'three', 'four', 'five', 'SIX'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'second edit');

  const second = await snapshotOf(dir);
  const p2 = persistSnapshot(second.snapshot, second.units);

  assert.equal(second.units.length, 2, 'two independent change-runs now');
  assert.equal(p2.resume.carriedReviewed, 1, 'the already-reviewed change stays reviewed');
  assert.equal(p2.resume.newUnits, 1, 'only the genuinely new change is unreviewed');
  assert.equal(p2.states[second.units.find((x) => x.contentHash === u.contentHash)!.id], 'reviewed');
});

test('a clean rebase preserves review state without special-case code', async (t) => {
  const dir = setupRepo();
  open(join(dir, 'test.sqlite'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'a.ts'), ['one', 'TWO', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'feature work');

  const before = await snapshotOf(dir);
  const p1 = persistSnapshot(before.snapshot, before.units);
  for (const unit of before.units) {
    setUnitState(p1.reviewId, p1.snapshotId, unit.filePath, unit.contentHash, unit.ordinal, 'reviewed');
  }

  // Upstream advances, then the feature branch rebases onto it. Every commit
  // SHA changes; the net diff does not.
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'unrelated.ts'), 'upstream\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'upstream work');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'rebase', '-q', 'main');

  const after = await snapshotOf(dir);
  const p2 = persistSnapshot(after.snapshot, after.units);

  assert.notEqual(after.snapshot.baseSha, before.snapshot.baseSha, 'the base really moved');
  assert.equal(p2.resume.baseMoved, true);
  assert.equal(p2.resume.newUnits, 0, 'a rebase introduces no new units');
  assert.equal(p2.resume.carriedReviewed, before.units.length, 'all review state survives');
});

test('re-resolving an unchanged target reuses its snapshot rather than forking one', async (t) => {
  const dir = setupRepo();
  open(join(dir, 'test.sqlite'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'a.ts'), ['one', 'TWO', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'edit');

  const s = await snapshotOf(dir);
  const p1 = persistSnapshot(s.snapshot, s.units);
  const p2 = persistSnapshot(s.snapshot, s.units);
  assert.equal(p1.snapshotId, p2.snapshotId, 'same evidence means the same snapshot');
});

test('editing reviewed code resets that unit and reports it as gone', async (t) => {
  const dir = setupRepo();
  open(join(dir, 'test.sqlite'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'a.ts'), ['one', 'v1', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'v1');
  const first = await snapshotOf(dir);
  const p1 = persistSnapshot(first.snapshot, first.units);
  const u = first.units[0];
  setUnitState(p1.reviewId, p1.snapshotId, u.filePath, u.contentHash, u.ordinal, 'reviewed');

  // The same line is changed again — the reviewer signed off on different code.
  writeFileSync(join(dir, 'a.ts'), ['one', 'v2', 'three', 'four', 'five', 'six'].join('\n') + '\n');
  git(dir, 'commit', '-qam', 'v2');
  const second = await snapshotOf(dir);
  const p2 = persistSnapshot(second.snapshot, second.units);

  assert.equal(p2.resume.carriedReviewed, 0, 'changed code must not stay reviewed');
  assert.equal(p2.resume.goneUnits, 1);
  assert.equal(p2.resume.newUnits, 1);
});
