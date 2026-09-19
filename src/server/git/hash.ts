import { createHash } from 'node:crypto';
import type { DiffLine } from '../../shared/types.js';

/**
 * Content hash for a hunk — the anchor that lets review state survive a head
 * move.
 *
 * Only added and removed lines contribute, with trailing whitespace stripped.
 * Line numbers and surrounding context are deliberately excluded: an edit
 * elsewhere in the file shifts every later hunk's line numbers, and a review
 * tool that forgets your progress on every push is worthless.
 *
 * The tradeoff is that two textually identical hunks in different places hash
 * the same; callers scope lookups by file path to keep that from mattering.
 */
export function hashHunk(lines: DiffLine[]): string {
  const h = createHash('sha256');
  for (const line of lines) {
    if (line.kind === 'context') continue;
    h.update(line.kind === 'add' ? '+' : '-');
    h.update(line.text.replace(/\s+$/, ''));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Context hash around a finding's anchor line, used to detect that the code a
 * finding referred to has since changed.
 */
export function hashAnchor(fileLines: string[], line: number, radius = 3): string {
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(fileLines.length, line - 1 + radius + 1);
  const h = createHash('sha256');
  for (let i = start; i < end; i++) h.update(fileLines[i].replace(/\s+$/, '') + '\n');
  return h.digest('hex').slice(0, 16);
}

export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
