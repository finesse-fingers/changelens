import { git, gitAllowExit, gitOrNull } from './exec.js';

/**
 * The only module that shapes raw git invocations.
 *
 * Every diff pins its machinery. If the user's `diff.algorithm` or
 * `diff.context` config changes between two runs, hunk boundaries move and
 * every review unit resets for no reason the user did anything to cause —
 * a maddening bug to diagnose, and a one-line fix to prevent.
 */
export const PINNED = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=all',
  '-c', 'diff.algorithm=histogram',
];

/** `-c` must precede the subcommand, so config and flags are split. */
const PINNED_CONFIG = ['-c', 'diff.algorithm=histogram'];
const PINNED_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'];

export function diffArgs(extra: string[], context: 0 | 3): string[] {
  return [...PINNED_CONFIG, 'diff', ...PINNED_FLAGS, `-U${context}`, '--find-renames', ...extra];
}

export interface NumstatRow {
  added: number;
  deleted: number;
  path: string;
  oldPath?: string;
  isBinary: boolean;
}

/**
 * Parse `--numstat -z`.
 *
 * `-z` is mandatory, not a nicety. Without it git compacts renames to
 * `{old => new}` and octal-escapes non-ASCII paths. A repo containing emoji
 * filenames is enough to make the unescaped form genuinely unparseable.
 * With `-z` a rename row is `added\tdeleted\t\0old\0new\0`: the third
 * tab-field is empty and two NUL-separated paths follow.
 */
export function parseNumstatZ(raw: string): NumstatRow[] {
  const out: NumstatRow[] = [];
  const parts = raw.split('\0');
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    const fields = head.split('\t');
    if (fields.length < 3) { i++; continue; }
    const [addedRaw, deletedRaw, maybePath] = fields;
    const isBinary = addedRaw === '-' || deletedRaw === '-';
    const added = isBinary ? 0 : parseInt(addedRaw, 10) || 0;
    const deleted = isBinary ? 0 : parseInt(deletedRaw, 10) || 0;
    if (maybePath === '') {
      // Rename/copy: the two paths follow as their own NUL-separated fields.
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      out.push({ added, deleted, path, oldPath, isBinary });
      i += 3;
    } else {
      out.push({ added, deleted, path: maybePath, isBinary });
      i += 1;
    }
  }
  return out;
}

export async function numstat(cwd: string, range: string[], ignoreWhitespace = false): Promise<NumstatRow[]> {
  const extra = ignoreWhitespace ? ['-w', '--ignore-blank-lines'] : [];
  const raw = await gitOrNull(cwd, [
    ...PINNED_CONFIG, 'diff', ...PINNED_FLAGS, '--numstat', '-z', '--find-renames', ...extra, ...range,
  ]);
  return raw ? parseNumstatZ(raw) : [];
}

export interface RawRow {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;      // A, M, D, T, R100, C85, ...
  path: string;
  oldPath?: string;
}

/** `git diff --raw -z` gives modes and blob OIDs — the basis for mode-only and submodule detection. */
export async function rawDiff(cwd: string, range: string[]): Promise<RawRow[]> {
  const raw = await gitOrNull(cwd, [
    ...PINNED_CONFIG, 'diff', ...PINNED_FLAGS, '--raw', '-z', '--find-renames', ...range,
  ]);
  if (!raw) return [];
  const out: RawRow[] = [];
  const parts = raw.split('\0');
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta.startsWith(':')) { i++; continue; }
    // :oldMode newMode oldOid newOid status
    const f = meta.slice(1).split(/\s+/);
    const [oldMode, newMode, oldOid, newOid, status] = f;
    if (status?.[0] === 'R' || status?.[0] === 'C') {
      out.push({ oldMode, newMode, oldOid, newOid, status, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      out.push({ oldMode, newMode, oldOid, newOid, status, path: parts[i + 1] });
      i += 2;
    }
  }
  return out;
}

/** Commit SHAs touching each path in the range — a cheap proxy for "the author struggled here". */
export async function pathCommitCounts(cwd: string, range: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const raw = await gitOrNull(cwd, ['log', '--format=%H', '-z', '--name-only', ...range]);
  if (!raw) return counts;
  for (const chunk of raw.split('\0')) {
    const p = chunk.trim();
    if (!p || /^[0-9a-f]{40}$/.test(p)) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

/** Guard every call that names a possibly-collected commit. */
export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return (await gitOrNull(cwd, ['cat-file', '-e', `${sha}^{commit}`])) !== null;
}

/** First N lines of a blob, for generated-header sniffing, without materializing the whole file. */
export async function blobHead(cwd: string, oid: string, lines = 40): Promise<string> {
  if (!oid || /^0+$/.test(oid)) return '';
  const raw = await gitOrNull(cwd, ['cat-file', 'blob', oid]);
  if (!raw) return '';
  return raw.split('\n').slice(0, lines).join('\n');
}

export { git, gitAllowExit, gitOrNull };
