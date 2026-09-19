import type { ChangedFile, Snapshot } from '../../shared/types.js';
import { gitOrNull } from '../git/exec.js';
import type { ReviewUnit } from '../git/units.js';

/**
 * Intent evidence.
 *
 * Without it, `Requested | Supporting | Extra` is guesswork: nothing in a diff
 * distinguishes work the user asked for from work an agent decided to do on
 * its own. The PR body, branch name and commit messages are the only signal,
 * so a map job refuses to run without at least one of them.
 */
export interface IntentEvidence {
  branch: string;
  prTitle?: string;
  prBody?: string;
  commits: string[];
  /** False when we have nothing but a branch name — surfaced in the UI. */
  sufficient: boolean;
}

export async function gatherIntent(snap: Snapshot): Promise<IntentEvidence> {
  const commits =
    (await gitOrNull(snap.repoRoot, [
      'log', '--format=%s%n%b%n---', `${snap.baseSha}..${snap.headSha}`, '--max-count=40',
    ]))?.split('\n---\n').map((s) => s.trim()).filter(Boolean) ?? [];

  const evidence: IntentEvidence = {
    branch: snap.headRef,
    prTitle: snap.prTitle,
    prBody: undefined,
    commits,
    sufficient: false,
  };
  evidence.sufficient = Boolean(evidence.prTitle) || commits.length > 0;
  return evidence;
}

export function renderIntent(e: IntentEvidence): string {
  const parts = [`Branch: ${e.branch}`];
  if (e.prTitle) parts.push(`Pull request title: ${e.prTitle}`);
  if (e.prBody) parts.push(`Pull request description:\n${e.prBody.slice(0, 4000)}`);
  if (e.commits.length) {
    parts.push(`Commit messages (newest first):\n${e.commits.slice(0, 25).map((c) => `- ${c.replace(/\n/g, '\n  ')}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Salience ranking, used to decide which files get their full patch in the
 * prompt and which are reduced to a one-line index entry.
 */
export function salience(f: ChangedFile, commitTouches: number): number {
  let score = 0;
  const p = f.path;
  const isTest = /(\.|\/)(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(p);
  const isDoc = /\.(md|mdx|txt|rst)$/.test(p);

  if (!isTest && !isDoc) score += 3;
  if (f.status === 'added' || f.status === 'deleted') score += 2;
  // Repeated edits across commits in the range is the cheapest proxy for
  // "the author struggled here", which is where review attention belongs.
  if (commitTouches > 1) score += 2;
  if (/(auth|crypt|secret|token|migration|\.sql$|iam|terraform|\.github\/workflows)/i.test(p)) score += 2;
  if (isTest) score -= 2;
  if (isDoc) score -= 1;
  if (f.tier === 'digest') score -= 3;
  return score;
}

const CHARS_PER_TOKEN = 3.6;
/** Payload ceiling, leaving room for the system prompt, schema and output. */
const MAX_PAYLOAD_CHARS = 120_000 * CHARS_PER_TOKEN;

export interface DiffPayload {
  text: string;
  fullFiles: string[];
  indexedFiles: string[];
  truncated: boolean;
}

/**
 * Render the diff for a prompt, degrading gracefully as it grows.
 *
 * Small diffs go in whole. Large ones keep full patches for the most
 * consequential files and reduce the rest to one index line each, which costs
 * roughly a hundredth as much and still lets the model see the whole shape of
 * the change.
 */
export function renderDiffPayload(
  files: ChangedFile[],
  units: ReviewUnit[],
  commitCounts: Map<string, number>,
): DiffPayload {
  const aliasOf = new Map(units.map((u, i) => [u.id, `H${String(i + 1).padStart(3, '0')}`]));
  const ranked = [...files].sort(
    (a, b) => salience(b, commitCounts.get(b.path) ?? 0) - salience(a, commitCounts.get(a.path) ?? 0),
  );

  const stat = ranked
    .map((f) => `  ${f.path}  +${f.additions}/-${f.deletions}${f.tier === 'digest' ? ` (${f.noise})` : ''}`)
    .join('\n');

  const fullFiles: string[] = [];
  const indexedFiles: string[] = [];
  const chunks: string[] = [];
  let budget = MAX_PAYLOAD_CHARS - stat.length;

  for (const f of ranked) {
    if (f.tier === 'digest' || f.isBinary) {
      indexedFiles.push(f.path);
      continue;
    }
    const rendered = renderFile(f, units, aliasOf);
    if (rendered.length <= budget) {
      chunks.push(rendered);
      fullFiles.push(f.path);
      budget -= rendered.length;
    } else {
      indexedFiles.push(f.path);
    }
  }

  const index = units
    .filter((u) => indexedFiles.includes(u.filePath))
    .map((u) => `  ${aliasOf.get(u.id)} ${u.filePath} +${u.additions}-${u.deletions} ${u.symbol}`)
    .join('\n');

  const text = [
    `## Files changed\n${stat}`,
    chunks.length ? `## Patches\n\n${chunks.join('\n\n')}` : '',
    index ? `## Other changes (not shown in full)\n${index}` : '',
  ].filter(Boolean).join('\n\n');

  return { text, fullFiles, indexedFiles, truncated: indexedFiles.length > 0 };
}

export function renderFile(f: ChangedFile, units: ReviewUnit[], aliasOf: Map<string, string>): string {
  const lines: string[] = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
  for (const h of f.hunks) {
    const owned = units.filter((u) => u.displayHunkId === h.id);
    const aliases = owned.map((u) => aliasOf.get(u.id)).filter(Boolean).join(' ');
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.section}${aliases ? `   [${aliases}]` : ''}`);
    for (const l of h.lines) {
      const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      lines.push(`${marker}${l.text}`);
    }
  }
  return lines.join('\n');
}

export function aliasMap(units: ReviewUnit[]): Map<string, string> {
  return new Map(units.map((u, i) => [u.id, `H${String(i + 1).padStart(3, '0')}`]));
}
