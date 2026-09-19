import { createHash } from 'node:crypto';
import type {
  ChangedFile, ChangeOrigin, DiffSet, Snapshot, TargetSpec,
} from '../../shared/types.js';
import { git, gitAllowExit, gitOrNull, repoKey, repoRoot } from './exec.js';
import { parseUnifiedDiff } from './parse-diff.js';
import { classifyNoise, tierFor } from './noise.js';
import { shortHash } from './hash.js';
import { resolvePr } from '../gh/pr.js';

/** Rename detection on; the noise classifier depends on the similarity score. */
const DIFF_FLAGS = ['--find-renames', '--no-color', '--no-ext-diff', '-U3'];

export interface ResolvedSnapshot {
  snapshot: Snapshot;
  diff: DiffSet;
}

/**
 * Resolve a target into an auditable snapshot plus its diff.
 *
 * Both paths compare against a true fork point, never against a branch tip: a
 * PR takes the merge-base of its recorded base OID and its head, and a local
 * branch takes the merge-base against a base ref that is discovered rather
 * than assumed.
 */
export async function resolveSnapshot(spec: TargetSpec): Promise<ResolvedSnapshot> {
  const root = await repoRoot(spec.repoRoot);
  const key = await repoKey(root);
  const inspectedAt = new Date().toISOString();

  let baseSha: string;
  let headSha: string;
  let baseRef: string;
  let headRef: string;
  let baseResolution: Snapshot['baseResolution'];
  let prMeta: Awaited<ReturnType<typeof resolvePr>> | null = null;

  if (spec.kind === 'pr') {
    if (spec.prNumber === undefined) throw new Error('PR target requires a PR number');
    prMeta = await resolvePr(root, spec.prNumber);
    headSha = prMeta.headRefOid;
    baseRef = prMeta.baseRefName;
    headRef = prMeta.headRefName;
    // Both commits have to be local before a merge-base can be computed.
    await ensureCommitsPresent(root, spec.prNumber, [prMeta.baseRefOid, headSha]);
    const forked = await prForkPoint(root, prMeta.baseRefOid, headSha);
    baseSha = forked.sha;
    baseResolution = forked.resolution;
  } else if (spec.uncommittedOnly) {
    headSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    baseSha = headSha;
    baseRef = 'HEAD';
    headRef = 'HEAD';
    baseResolution = 'head';
  } else {
    headSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    headRef = (await gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? 'HEAD';
    const discovered = await discoverBaseRef(root, spec.baseRef);
    baseRef = discovered.ref;
    baseResolution = discovered.resolution;
    const mergeBase = await gitOrNull(root, ['merge-base', baseRef, 'HEAD']);
    if (!mergeBase) {
      throw new Error(
        `No merge base between ${baseRef} and HEAD — the histories are unrelated. ` +
          `Pick an explicit base ref.`,
      );
    }
    baseSha = mergeBase.trim();
  }

  /*
   * One comparison, not three concatenated ones.
   *
   * `git diff <base>` already compares the base commit against the working
   * tree, so staged and unstaged edits are folded in with correct arithmetic.
   * Diffing the committed range and the working tree separately and
   * concatenating the hunks double-counts every line a commit touched and a
   * later edit touched again.
   */
  const files: ChangedFile[] = [];
  const localTree = spec.kind === 'local' && !isolateCommitted(spec);

  if (localTree) {
    const raw = await git(root, ['diff', ...DIFF_FLAGS, baseSha]);
    files.push(...parseUnifiedDiff(raw, 'commit'));
  } else if (baseSha !== headSha) {
    const raw = await git(root, ['diff', ...DIFF_FLAGS, `${baseSha}..${headSha}`]);
    files.push(...parseUnifiedDiff(raw, 'commit'));
  }

  if (spec.kind === 'local' && spec.includeUntracked !== false) {
    files.push(...(await untrackedAsDiff(root)));
  }

  // Origin is an annotation on the single diff, not a separate pass.
  const origins = await fileOrigins(root);
  for (const f of files) {
    if (f.origin === 'untracked') continue;
    f.origin = origins.get(f.path) ?? 'commit';
  }

  const merged = mergeByPath(files);
  const whitespaceOnly = await whitespaceOnlyPaths(root, spec, baseSha, headSha);
  for (const f of merged) {
    f.noise = classifyNoise(f, whitespaceOnly);
    f.tier = tierFor(f.noise);
  }

  const dirtyDigest = spec.kind === 'local' ? await computeDirtyDigest(root) : null;

  const stats = {
    files: merged.length,
    additions: merged.reduce((n, f) => n + f.additions, 0),
    deletions: merged.reduce((n, f) => n + f.deletions, 0),
  };

  const snapshot: Snapshot = {
    id: shortHash([key, spec.kind, baseSha, headSha, dirtyDigest ?? ''].join('|')),
    repoRoot: root,
    repoKey: key,
    kind: spec.kind,
    prNumber: prMeta?.number,
    prUrl: prMeta?.url,
    prTitle: prMeta?.title,
    prState: prMeta?.state,
    prIsDraft: prMeta?.isDraft,
    baseRef,
    headRef,
    baseSha,
    headSha,
    dirtyDigest,
    inspectedAt,
    baseResolution,
    stats,
  };

  return { snapshot, diff: { snapshotId: snapshot.id, files: merged, truncated: [] } };
}

/**
 * Find the integration base without assuming `main`.
 *
 * Order: an explicit ref, then the PR's own base if this branch has one, then
 * the remote's published default branch, then a local default. The chosen
 * resolution is reported so the UI can show how the comparison was derived.
 */
async function discoverBaseRef(
  root: string,
  explicit?: string,
): Promise<{ ref: string; resolution: Snapshot['baseResolution'] }> {
  if (explicit) return { ref: explicit, resolution: 'explicit' };

  const prBase = await gitOrNull(root, ['config', '--get', 'changelens.baseRef']);
  if (prBase?.trim()) return { ref: prBase.trim(), resolution: 'explicit' };

  // origin/HEAD is the remote's advertised default branch — a fact, not a guess.
  const originHead = await gitOrNull(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.trim()) return { ref: originHead.trim(), resolution: 'merge-base' };

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', candidate])) {
      return { ref: candidate, resolution: 'merge-base' };
    }
  }
  throw new Error('Could not determine a base branch. Pass one explicitly.');
}

/**
 * The commit a PR actually forked from — what GitHub's own "Files changed"
 * compares against.
 *
 * `baseRefOid` is the base branch's tip, and for an open PR it moves forward as
 * that branch advances. Diffing against it two-dot therefore reports every
 * commit that landed on the base since the fork as if this PR had *deleted* it.
 * Measured on a PR seven commits behind its base: the two-dot diff claimed 87
 * files and four thousand deletions where GitHub showed 7 files and 36 — and
 * GitHub's figure is exactly `merge-base(baseRefOid, head)...head`.
 *
 * The merge-base is also correct once a PR merges, because `baseRefOid` is
 * frozen at merge time and is then already the fork point; verified on a merged
 * PR where the two agreed and both matched GitHub. The two guards below cover
 * the cases where it would not be: unrelated histories, and a head already
 * contained in the base, whose merge-base is the head itself and would diff to
 * nothing. A stale base is a wrong review; an empty one is a silent one.
 */
async function prForkPoint(
  root: string,
  baseRefOid: string,
  headSha: string,
): Promise<{ sha: string; resolution: Snapshot['baseResolution'] }> {
  const mergeBase = (await gitOrNull(root, ['merge-base', baseRefOid, headSha]))?.trim();
  if (!mergeBase || mergeBase === headSha) {
    return { sha: baseRefOid, resolution: 'pr-base-oid' };
  }
  return { sha: mergeBase, resolution: 'pr-merge-base' };
}

/** Fetch PR commits if the local clone does not already have them. */
async function ensureCommitsPresent(root: string, prNumber: number, shas: string[]): Promise<void> {
  const missing = [];
  for (const sha of shas) {
    if (!(await gitOrNull(root, ['cat-file', '-e', `${sha}^{commit}`]))) missing.push(sha);
  }
  if (missing.length === 0) return;
  await gitOrNull(root, ['fetch', '--no-tags', 'origin', `pull/${prNumber}/head`]);
  await gitOrNull(root, ['fetch', '--no-tags', 'origin']);
}

/** Untracked files rendered as additions, so new work is never invisible. */
async function untrackedAsDiff(root: string): Promise<ChangedFile[]> {
  const listing = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listing.split('\0').filter(Boolean);
  const out: ChangedFile[] = [];
  for (const p of paths) {
    // --no-index exits 1 when files differ, which is the normal case here.
    // --no-index exits 1 whenever the files differ, which is always true here.
    const raw = await gitAllowExit(root, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', p], [1]);
    if (!raw.trim()) continue;
    const parsed = parseUnifiedDiff(raw, 'untracked');
    for (const f of parsed) {
      f.status = 'added';
      f.path = p;
      out.push(f);
    }
  }
  return out;
}

/**
 * The same diffs re-run with `-w`. A path that changed normally but vanishes
 * here changed only in whitespace.
 */
async function whitespaceOnlyPaths(
  root: string,
  spec: TargetSpec,
  baseSha: string,
  headSha: string,
): Promise<Set<string>> {
  const withWs = new Set<string>();
  const withoutWs = new Set<string>();

  const collect = async (args: string[], target: Set<string>) => {
    const raw = await gitOrNull(root, args);
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3) target.add(parts[2]);
    }
  };

  // Mirror the single comparison used for the diff itself, so the two passes
  // can never disagree about which paths are in scope.
  const range =
    spec.kind === 'local' && !isolateCommitted(spec)
      ? [baseSha]
      : baseSha !== headSha
        ? [`${baseSha}..${headSha}`]
        : null;
  if (range) {
    await collect(['diff', '--numstat', '--find-renames', ...range], withWs);
    await collect(['diff', '--numstat', '--find-renames', '-w', ...range], withoutWs);
  }
  const only = new Set<string>();
  for (const p of withWs) if (!withoutWs.has(p)) only.add(p);
  return only;
}

/**
 * Digest over uncommitted material. Two reviews of the same commits but a
 * different working tree are different snapshots, which is what keeps a
 * mid-review edit from silently invalidating recorded progress.
 */
async function computeDirtyDigest(root: string): Promise<string | null> {
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.trim()) return null;
  const h = createHash('sha256');
  h.update(status);
  // Include content, not just the status list: editing a file already marked
  // dirty must still change the digest.
  for (const raw of [
    await gitOrNull(root, ['diff']),
    await gitOrNull(root, ['diff', '--cached']),
  ]) {
    if (raw) h.update(raw);
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * One file can appear in several passes (committed, then staged, then edited).
 * Later origins win for metadata, and hunks accumulate, so the reviewer sees
 * the net state rather than one arbitrary layer.
 */
function mergeByPath(files: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of files) {
    const existing = byPath.get(f.path);
    if (!existing) {
      byPath.set(f.path, { ...f, hunks: [...f.hunks] });
      continue;
    }
    const seen = new Set(existing.hunks.map((h) => h.contentHash));
    for (const h of f.hunks) {
      if (seen.has(h.contentHash)) continue;
      existing.hunks.push({ ...h, index: existing.hunks.length, id: `${f.path}@${existing.hunks.length}` });
    }
    existing.additions = existing.hunks.reduce((n, h) => n + h.additions, 0);
    existing.deletions = existing.hunks.reduce((n, h) => n + h.deletions, 0);
    existing.origin = f.origin;
    existing.isBinary ||= f.isBinary;
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}


/**
 * Which uncommitted state each path is in, so the UI can mark work that exists
 * only in the working tree. Derived from porcelain status rather than from a
 * second diff, so it cannot disagree with the diff's arithmetic.
 */
async function fileOrigins(root: string): Promise<Map<string, ChangeOrigin>> {
  const out = new Map<string, ChangeOrigin>();
  const status = await gitOrNull(root, ['status', '--porcelain=v1', '-z']);
  if (!status) return out;
  const entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const x = entry[0];
    const y = entry[1];
    let path = entry.slice(3);
    // Rename/copy entries are followed by their origin path in the next field.
    if (x === 'R' || x === 'C') i++;
    if (x === '?' && y === '?') { out.set(path, 'untracked'); continue; }
    // An unstaged change is the more surprising state, so it wins the label.
    if (y !== ' ' && y !== '') out.set(path, 'unstaged');
    else if (x !== ' ' && x !== '') out.set(path, 'staged');
  }
  return out;
}

/** True when the caller explicitly excluded working-tree material. */
function isolateCommitted(spec: TargetSpec): boolean {
  return spec.includeStaged === false && spec.includeUnstaged === false;
}
