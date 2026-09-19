import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSnapshot } from './snapshot.js';

/**
 * A repository shaped like the bug.
 *
 * `main` advances after a branch forks, which is the ordinary state of any PR
 * left open for a day. Comparing against main's tip instead of the fork point
 * reports everything that landed meanwhile as if this branch had deleted it.
 */
function repoWithDivergedMain(): { root: string; forkPoint: string; mainTip: string } {
  const root = mkdtempSync(join(tmpdir(), 'changelens-snap-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();

  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const forkPoint = git('rev-parse', 'HEAD');

  // The branch: one small, honest change.
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'feature.txt'), 'one line\n');
  git('add', '-A');
  git('commit', '-qm', 'the change under review');

  // Meanwhile main gains a large unrelated commit.
  git('checkout', '-q', 'main');
  writeFileSync(join(root, 'unrelated.txt'), Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'));
  git('add', '-A');
  git('commit', '-qm', 'someone else, later');
  const mainTip = git('rev-parse', 'HEAD');

  git('checkout', '-q', 'feature');
  return { root, forkPoint, mainTip };
}

test('a local branch is compared against the fork point, not the advanced base tip', async () => {
  const { root, forkPoint, mainTip } = repoWithDivergedMain();
  // No baseRef: this exercises discovery, the path a user hits by default.
  const { snapshot, diff } = await resolveSnapshot({ kind: 'local', repoRoot: root });

  assert.equal(snapshot.baseResolution, 'merge-base');
  assert.equal(snapshot.baseSha, forkPoint);
  assert.notEqual(snapshot.baseSha, mainTip);
  // Only the branch's own file. `unrelated.txt` landing on main afterwards is
  // not this branch deleting it.
  assert.deepEqual(diff.files.map((f) => f.path), ['feature.txt']);
  assert.equal(snapshot.stats.deletions, 0);
});

test('an explicit base ref still resolves through a merge-base', async () => {
  const { root, forkPoint } = repoWithDivergedMain();
  const { snapshot } = await resolveSnapshot({ kind: 'local', repoRoot: root, baseRef: 'main' });
  assert.equal(snapshot.baseSha, forkPoint);
  assert.equal(snapshot.baseResolution, 'explicit');
});
