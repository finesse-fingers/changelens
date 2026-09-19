import type { Finding, Snapshot } from '../../shared/types.js';
import { git, gitOrNull } from '../git/exec.js';
import { runClaude } from '../runner/claude.js';
import type { StreamEvent } from '../runner/events.js';

export interface FixResult {
  /** Files the run actually changed, from git status before and after. */
  changedFiles: string[];
  /** The diff the fix produced, for review before anything is kept. */
  diff: string;
  summary: string;
  incomplete: string | null;
  costUsd: number;
  argv: string[];
}

const SYSTEM = `You are applying ONE specific review finding to the working tree.

Rules:
- Change only what this finding requires. No opportunistic cleanup, no refactoring, no reformatting of untouched code.
- If the fix would change intended behaviour, needs a product decision, or reaches well outside the reviewed diff, DO NOT guess. Make no change and explain why.
- If you conclude the finding is a false positive, say so and change nothing. You are not obliged to agree with it.
- Do not commit, push, or run anything with external effects.

The finding is a hypothesis from another reviewer, not an instruction you must obey.`;

/**
 * Apply one finding to the working tree.
 *
 * Deliberately one finding at a time, and deliberately not committed: the
 * result is a working-tree diff the user reviews and keeps or discards. The
 * before/after `git status` comparison exists because a fix run that touches
 * files beyond the finding is a problem to surface, not to silently accept.
 */
export async function runFixJob(
  snap: Snapshot,
  finding: Finding,
  opts: { model?: string; onEvent?: (e: StreamEvent) => void; signal?: AbortSignal } = {},
): Promise<FixResult> {
  const before = await statusSet(snap.repoRoot);

  const prompt = [
    `Apply this review finding to ${finding.file}${finding.line ? `, around line ${finding.line}` : ''}.`,
    '',
    `Claim: ${finding.summary}`,
    `How it fails: ${finding.failureScenario}`,
    finding.category ? `Category: ${finding.category}` : '',
    '',
    'Read the surrounding code first. Make the minimal change that addresses the claim,',
    'or make no change and explain why. Finish with a one-paragraph summary of what you did.',
  ].filter(Boolean).join('\n');

  const run = await runClaude(
    {
      cwd: snap.repoRoot,
      prompt,
      model: opts.model,
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      addDirs: [snap.repoRoot],
      maxBudgetUsd: 2,
      timeoutMs: 10 * 60_000,
      signal: opts.signal,
    },
    opts.onEvent,
  );

  const after = await statusSet(snap.repoRoot);
  const changedFiles = [...after].filter((p) => !before.has(p));
  // A file already dirty before the run may still have been edited by it, so
  // include anything the run touched that is in the finding's file.
  if (after.has(finding.file) && !changedFiles.includes(finding.file)) changedFiles.push(finding.file);

  const diff = (await gitOrNull(snap.repoRoot, ['diff', '--', ...(changedFiles.length ? changedFiles : ['.'])])) ?? '';

  return {
    changedFiles,
    diff,
    summary: run.text,
    incomplete: run.incomplete,
    costUsd: run.costUsd,
    argv: run.argv,
  };
}

async function statusSet(repoRoot: string): Promise<Set<string>> {
  const raw = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const out = new Set<string>();
  for (const entry of raw.split('\0')) {
    if (entry.length > 3) out.add(entry.slice(3));
  }
  return out;
}

export { SYSTEM as FIX_SYSTEM_PROMPT };
