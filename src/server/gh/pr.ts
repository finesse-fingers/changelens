import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergePrLists, type PrGroup, type PrLists, type PrSummary } from '../../shared/prlist.js';

const execFileAsync = promisify(execFile);

export type { PrGroup, PrLists, PrSummary };

export interface PrMeta {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  author: string;
  body: string;
}

const FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'baseRefName', 'headRefName',
  'baseRefOid', 'headRefOid', 'author', 'body',
].join(',');

export class GhError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'GhError';
  }
}

/**
 * Every `gh` call in this file, with its failures classified.
 *
 * Exported so new callers reuse the classification rather than adding another
 * `execFile('gh')` copy — a raw failure here reaches the user as either a
 * stderr dump or, worse, silence.
 */
export async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      // Without this a hung `gh` hangs the request that is waiting on it, with
      // no upper bound and nothing in the UI but a spinner.
      timeout: 15_000,
      // The update-notifier banner goes to stderr, where it would pollute the
      // string the classifier below matches against.
      env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string; code?: string; killed?: boolean };
    const stderr = e.stderr ?? '';
    if (e.code === 'ENOENT') {
      throw new GhError(
        'The GitHub CLI (gh) is not installed.',
        'Install it from https://cli.github.com, then run `gh auth login`.',
      );
    }
    if (e.killed) {
      throw new GhError('GitHub did not answer in time.', 'Check your connection and try again.');
    }
    if (/gh auth login|authentication/i.test(stderr)) {
      throw new GhError('GitHub CLI is not authenticated.', 'Run `gh auth login` in a terminal.');
    }
    if (/no git remotes found|none of the git remotes/i.test(stderr)) {
      throw new GhError(
        'This repository has no GitHub remote.',
        'Pull requests are only available for repositories with a GitHub origin.',
      );
    }
    if (/could not determine (the )?base repo/i.test(stderr)) {
      throw new GhError(
        "Several remotes here — gh cannot tell which repository to ask about.",
        'Run `gh repo set-default` in this repository.',
      );
    }
    if (/could not find|no pull requests/i.test(stderr)) {
      throw new GhError(stderr.trim() || e.message);
    }
    throw new GhError(`gh ${args[0]} ${args[1] ?? ''} failed: ${stderr.trim() || e.message}`);
  }
}

/**
 * Resolve a PR to its recorded base and head OIDs.
 *
 * These OIDs — not a locally recomputed merge-base — define the comparison.
 * Once a PR merges, or its base branch advances, a recomputed merge-base drifts
 * and can produce an empty diff for a PR that plainly changed things.
 */
export async function resolvePr(cwd: string, prNumber: number): Promise<PrMeta> {
  const raw = await gh(cwd, ['pr', 'view', String(prNumber), '--json', FIELDS]);
  const j = JSON.parse(raw) as Record<string, unknown> & { author?: { login?: string } };
  return {
    number: j.number as number,
    title: j.title as string,
    url: j.url as string,
    state: j.state as string,
    isDraft: Boolean(j.isDraft),
    baseRefName: j.baseRefName as string,
    headRefName: j.headRefName as string,
    baseRefOid: j.baseRefOid as string,
    headRefOid: j.headRefOid as string,
    author: j.author?.login ?? 'unknown',
    body: (j.body as string) ?? '',
  };
}

/** Only what a quick-select card renders. `PrMeta`'s `body` would pull a full
 *  description for every PR in the list, which nothing displays. */
const LIST_FIELDS = 'number,title,isDraft,headRefName,author,updatedAt';

interface RawListPr {
  number: number;
  title: string;
  isDraft?: boolean;
  headRefName?: string;
  author?: { login?: string };
  updatedAt?: string;
}

function toSummary(j: RawListPr): PrSummary {
  return {
    number: j.number,
    title: j.title,
    isDraft: Boolean(j.isDraft),
    headRefName: j.headRefName ?? '',
    author: j.author?.login ?? 'unknown',
    updatedAt: j.updatedAt ?? '',
  };
}

/**
 * The open PRs in this repo that are the user's problem.
 *
 * Errors propagate rather than collapsing to an empty list. That distinction
 * is the whole point: an empty list is a believable answer, so a swallowed
 * auth failure would read as "you have no open PRs" and be believed. Compare
 * `prForCurrentBranch` below, which has exactly that bug.
 */
export async function listPrs(cwd: string): Promise<PrLists> {
  const args = (query: string[]) =>
    ['pr', 'list', ...query, '--state', 'open', '--limit', '20', '--json', LIST_FIELDS];
  // `allSettled`, not `all`: the two queries fail independently — only the
  // second goes through GitHub's search endpoint, which has its own much
  // lower rate limit — and discarding a list that came back fine because the
  // other did not is pure loss.
  const [mine, reviewing] = await Promise.allSettled([
    gh(cwd, args(['--author', '@me'])),
    gh(cwd, args(['--search', 'review-requested:@me'])),
  ]);

  const merged = mergePrLists(parsed(mine), parsed(reviewing));
  return {
    mine: { prs: merged.mine, error: failure(mine) },
    reviewing: { prs: merged.reviewing, error: failure(reviewing) },
  };
}

function parsed(r: PromiseSettledResult<string>): PrSummary[] {
  if (r.status !== 'fulfilled') return [];
  return (JSON.parse(r.value) as RawListPr[]).map(toSummary);
}

function failure(r: PromiseSettledResult<string>): PrGroup['error'] {
  if (r.status !== 'rejected') return undefined;
  const e = r.reason as Error & { hint?: string };
  return { message: e.message, hint: e.hint };
}

/** Accepts `123`, `#123`, or a full PR URL. Returns null when unparseable. */
export function parsePrRef(input: string): number | null {
  const trimmed = input.trim().replace(/^#/, '');
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const m = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(trimmed);
  return m ? parseInt(m[1], 10) : null;
}

export async function prForCurrentBranch(cwd: string): Promise<PrMeta | null> {
  try {
    const raw = await gh(cwd, ['pr', 'view', '--json', FIELDS]);
    const j = JSON.parse(raw) as Record<string, unknown> & { author?: { login?: string } };
    return {
      number: j.number as number,
      title: j.title as string,
      url: j.url as string,
      state: j.state as string,
      isDraft: Boolean(j.isDraft),
      baseRefName: j.baseRefName as string,
      headRefName: j.headRefName as string,
      baseRefOid: j.baseRefOid as string,
      headRefOid: j.headRefOid as string,
      author: j.author?.login ?? 'unknown',
      body: (j.body as string) ?? '',
    };
  } catch {
    return null;
  }
}
