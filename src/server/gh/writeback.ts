import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, gitOrNull } from '../git/exec.js';
import { GhError, resolvePr } from './pr.js';
import type { Finding } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

/**
 * Write-back.
 *
 * Every function here is two-step by construction: callers build a preview,
 * show the exact payload, and only then call the poster. Authority at one gate
 * never implies the next — reviewing does not authorise commenting, and
 * commenting does not authorise editing the working tree.
 */

export interface CommentPreview {
  prNumber: number;
  prUrl: string;
  commitSha: string;
  comments: {
    findingId: string;
    path: string;
    line: number;
    body: string;
  }[];
  /** Findings that cannot be posted inline, with the reason. */
  skipped: { findingId: string; reason: string }[];
}

/**
 * Build the exact comment payload, without sending anything.
 *
 * GitHub anchors an inline comment to a line in a specific commit's diff, so a
 * finding with no line, or one pointing at a file outside the PR diff, cannot
 * be posted inline and is reported as skipped rather than silently relocated.
 */
export async function previewComments(
  repoRoot: string,
  prNumber: number,
  findings: Finding[],
  changedPaths: Set<string>,
): Promise<CommentPreview> {
  const pr = await resolvePr(repoRoot, prNumber);
  const comments: CommentPreview['comments'] = [];
  const skipped: CommentPreview['skipped'] = [];

  for (const f of findings) {
    if (f.line === undefined) {
      skipped.push({ findingId: f.id, reason: 'no line anchor — GitHub requires one for an inline comment' });
      continue;
    }
    if (!changedPaths.has(f.file)) {
      skipped.push({ findingId: f.id, reason: 'file is not part of the PR diff' });
      continue;
    }
    comments.push({
      findingId: f.id,
      path: f.file,
      line: f.line,
      body: renderComment(f),
    });
  }

  return { prNumber, prUrl: pr.url, commitSha: pr.headRefOid, comments, skipped };
}

function renderComment(f: Finding): string {
  const lines = [f.summary, '', `**How it fails.** ${f.failureScenario}`];
  const meta: string[] = [];
  if (f.category) meta.push(f.category);
  if (f.verdict) meta.push(f.verdict.toLowerCase());
  // State plainly when no verify pass ran, so a reader does not over-trust it.
  else meta.push('unverified — no verify pass ran for this review');
  lines.push('', `<sub>${meta.join(' · ')} · posted from Changelens</sub>`);
  return lines.join('\n');
}

export interface PostResult {
  posted: number;
  failed: { findingId: string; error: string }[];
  urls: string[];
}

/** Post the previewed comments. Called only after explicit confirmation. */
export async function postComments(
  repoRoot: string,
  preview: CommentPreview,
): Promise<PostResult> {
  const repo = await repoSlug(repoRoot);
  const failed: PostResult['failed'] = [];
  const urls: string[] = [];

  for (const c of preview.comments) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api', '--method', 'POST',
          `repos/${repo}/pulls/${preview.prNumber}/comments`,
          '-f', `body=${c.body}`,
          '-f', `commit_id=${preview.commitSha}`,
          '-f', `path=${c.path}`,
          '-F', `line=${c.line}`,
          '-f', 'side=RIGHT',
        ],
        { cwd: repoRoot, env: { ...process.env, GH_PAGER: 'cat' } },
      );
      const body = JSON.parse(stdout) as { html_url?: string };
      if (body.html_url) urls.push(body.html_url);
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      failed.push({ findingId: c.findingId, error: (e.stderr || e.message).slice(0, 300) });
    }
  }

  return { posted: urls.length, failed, urls };
}

async function repoSlug(repoRoot: string): Promise<string> {
  const url = (await gitOrNull(repoRoot, ['remote', 'get-url', 'origin']))?.trim();
  if (!url) throw new GhError('No origin remote — cannot determine the repository.');
  const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!m) throw new GhError(`origin does not look like a GitHub remote: ${url}`);
  return m[1];
}

/**
 * Check out someone else's PR into an isolated worktree.
 *
 * Never checks out over the working tree. Someone may have dozens of live
 * worktrees with in-progress agent work in them; clobbering one to review a PR
 * would destroy work that has nothing to do with the review.
 */
export async function prepareWorktree(
  repoRoot: string,
  prNumber: number,
): Promise<{ path: string; created: boolean; headSha: string }> {
  const pr = await resolvePr(repoRoot, prNumber);
  const name = repoRoot.slice(repoRoot.lastIndexOf('/') + 1);
  const base = join(homedir(), '.changelens', 'worktrees');
  mkdirSync(base, { recursive: true });
  const path = join(base, `${name}-pr${prNumber}`);

  const existing = await gitOrNull(repoRoot, ['worktree', 'list', '--porcelain']);
  if (existing?.includes(path)) {
    await gitOrNull(path, ['fetch', '--no-tags', 'origin', `pull/${prNumber}/head`]);
    await gitOrNull(path, ['checkout', '-q', '--detach', pr.headRefOid]);
    return { path, created: false, headSha: pr.headRefOid };
  }

  await git(repoRoot, ['fetch', '--no-tags', 'origin', `pull/${prNumber}/head`]);
  await git(repoRoot, ['worktree', 'add', '--detach', path, pr.headRefOid]);
  return { path, created: true, headSha: pr.headRefOid };
}
