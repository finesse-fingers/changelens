import { createHash } from 'node:crypto';
import type { ChangedFile, DiffLine, Hunk } from '../../shared/types.js';

/**
 * Review units: maximal runs of consecutive changed lines.
 *
 * This is the single most important decision for resumable review. A `-U3`
 * hunk's boundaries depend on its *neighbours* — a new edit four lines away
 * merges two hunks into one, the old hunk's hash vanishes, and a region the
 * user had already reviewed resets to unreviewed. Splitting each display hunk
 * back into its maximal change-runs (equivalent to what `git diff -U0` emits)
 * shrinks that merge window from six lines to zero.
 *
 * The runs are derived from the `-U3` diff we already parsed, so this costs no
 * extra git invocation, and the surrounding context needed for the locator hash
 * is right there in the same hunk.
 */

export interface ReviewUnit {
  /** Stable across snapshots: content + position among identical bodies. */
  id: string;
  filePath: string;
  /** The `-U3` hunk this run is rendered inside. */
  displayHunkId: string;
  /** Hash of the changed body only — no line numbers, no context. */
  contentHash: string;
  /** Hash of the surrounding context, to tell "moved" from "edited in place". */
  locatorHash: string;
  /** Disambiguates identical bodies within one file. */
  ordinal: number;
  oldStart: number | null;
  oldCount: number;
  newStart: number | null;
  newCount: number;
  additions: number;
  deletions: number;
  /** git's funcname hint. Display and tie-breaking only, never identity. */
  symbol: string;
  /** Kept so a unit can still be rendered after its commits are collected. */
  body: string;
  /** Index range within the display hunk's line array, for rendering. */
  lineRange: [number, number];
}

const CONTEXT_RADIUS = 3;

function normalize(text: string): string {
  // Trailing whitespace and CRLF are noise. Leading whitespace is NOT — it is
  // semantic in Python and YAML, and over-normalizing creates hash collisions
  // that are miserable to debug.
  return text.replace(/\r$/, '').replace(/[ \t]+$/, '');
}

function hashBody(lines: DiffLine[]): string {
  const h = createHash('sha256');
  for (const l of lines) {
    h.update(l.kind === 'add' ? '+' : '-');
    h.update(normalize(l.text));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 32);
}

function hashLocator(before: DiffLine[], after: DiffLine[]): string {
  const h = createHash('sha256');
  for (const l of before) h.update(normalize(l.text) + '\n');
  h.update('\0');
  for (const l of after) h.update(normalize(l.text) + '\n');
  return h.digest('hex').slice(0, 32);
}

/** Split one display hunk into its maximal runs of changed lines. */
function runsIn(hunk: Hunk): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i < hunk.lines.length; i++) {
    const changed = hunk.lines[i].kind !== 'context';
    if (changed && start === -1) start = i;
    if (!changed && start !== -1) {
      runs.push({ start, end: i });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, end: hunk.lines.length });
  return runs;
}

export function extractUnits(file: ChangedFile): ReviewUnit[] {
  const units: ReviewUnit[] = [];
  /** ordinal counter per (file, contentHash) — identical bodies do occur. */
  const seen = new Map<string, number>();

  for (const hunk of file.hunks) {
    for (const run of runsIn(hunk)) {
      const body = hunk.lines.slice(run.start, run.end);
      const before = hunk.lines.slice(Math.max(0, run.start - CONTEXT_RADIUS), run.start);
      const after = hunk.lines.slice(run.end, run.end + CONTEXT_RADIUS);

      const contentHash = hashBody(body);
      const ordinal = seen.get(contentHash) ?? 0;
      seen.set(contentHash, ordinal + 1);

      const adds = body.filter((l) => l.kind === 'add');
      const dels = body.filter((l) => l.kind === 'del');

      units.push({
        id: `${file.path}#${contentHash}#${ordinal}`,
        filePath: file.path,
        displayHunkId: hunk.id,
        contentHash,
        locatorHash: hashLocator(before, after),
        ordinal,
        oldStart: dels[0]?.oldLine ?? null,
        oldCount: dels.length,
        newStart: adds[0]?.newLine ?? null,
        newCount: adds.length,
        additions: adds.length,
        deletions: dels.length,
        symbol: hunk.section,
        body: body.map((l) => (l.kind === 'add' ? '+' : '-') + normalize(l.text)).join('\n'),
        lineRange: [run.start, run.end],
      });
    }
  }
  return units;
}

export function extractAllUnits(files: ChangedFile[]): ReviewUnit[] {
  return files.flatMap((f) => (f.noise ? [] : extractUnits(f)));
}

// ---------------------------------------------------------------------------
// Cross-snapshot matching — how review state survives a push
// ---------------------------------------------------------------------------

export type MatchKind = 'unchanged' | 'moved' | 'edited-in-place' | 'new' | 'gone';

export interface UnitMatch {
  kind: MatchKind;
  current?: ReviewUnit;
  previous?: ReviewUnit;
}

/**
 * Match this snapshot's units against the previous snapshot's.
 *
 * `unchanged` and `moved` both carry review state forward — the code the user
 * signed off on is byte-identical either way. `edited-in-place` resets, but is
 * shown with its own before/after so re-affirming is one click rather than a
 * fresh read.
 */
export function matchUnits(previous: ReviewUnit[], current: ReviewUnit[]): UnitMatch[] {
  const key = (u: ReviewUnit) => `${u.filePath}\0${u.contentHash}\0${u.ordinal}`;
  const prevByKey = new Map(previous.map((u) => [key(u), u]));
  const prevByLocator = new Map<string, ReviewUnit>();
  for (const u of previous) prevByLocator.set(`${u.filePath}\0${u.locatorHash}`, u);

  const matches: UnitMatch[] = [];
  const consumed = new Set<string>();

  for (const cur of current) {
    const exact = prevByKey.get(key(cur));
    if (exact) {
      consumed.add(key(exact));
      matches.push({
        kind: exact.locatorHash === cur.locatorHash ? 'unchanged' : 'moved',
        current: cur,
        previous: exact,
      });
      continue;
    }
    // Same surroundings, different body: the code here was edited.
    const byLocator = prevByLocator.get(`${cur.filePath}\0${cur.locatorHash}`);
    if (byLocator && !consumed.has(key(byLocator))) {
      consumed.add(key(byLocator));
      matches.push({ kind: 'edited-in-place', current: cur, previous: byLocator });
      continue;
    }
    matches.push({ kind: 'new', current: cur });
  }

  for (const prev of previous) {
    if (!consumed.has(key(prev))) matches.push({ kind: 'gone', previous: prev });
  }
  return matches;
}
