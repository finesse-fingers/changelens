import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The house rules a change is meant to follow.
 *
 * Until now nothing in this app opened a conventions file, so "does this match
 * how we write code here" was a judgement the model made from the diff alone —
 * which means it could not make it at all. These files are the only place that
 * standard is written down.
 *
 * Nearest wins, which is the convention these files themselves tend to state:
 * read the nearest nested `AGENTS.md` before changing a subtree. A monorepo's
 * subtree rules are more specific than its root rules and must be able to
 * override them.
 */

/** Per-directory, in the order a reader should encounter them. */
const DIR_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
/** Root only — a contributing guide is about the repo, not a subtree. */
const ROOT_ONLY = ['CONTRIBUTING.md'] as const;

/** Roughly 6k tokens. Enough for a real guide, small enough to repeat per shard. */
export const DEFAULT_BUDGET = 24_000;

export interface ConventionSource {
  /** Repo-relative, so it can be shown and cited. */
  path: string;
  text: string;
  truncated: boolean;
}

export interface ConventionChain {
  /** Root-first, nearest last. Empty when the repo documents nothing. */
  sources: ConventionSource[];
  /** Prompt-ready text, or '' when there is nothing to say. */
  text: string;
  truncated: boolean;
}

export const EMPTY_CHAIN: ConventionChain = { sources: [], text: '', truncated: false };

interface CacheEntry { mtimeMs: number; size: number; text: string }
const cache = new Map<string, CacheEntry | null>();

/**
 * Read a file, remembering the miss as well as the hit.
 *
 * Most directories have no conventions file, and the chain is walked once per
 * shard, so caching only successes would still stat the whole tree every time.
 * The mtime check means editing AGENTS.md mid-session is picked up.
 */
function readCached(abs: string): string | null {
  try {
    const st = statSync(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(abs, 'utf8');
    cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    cache.set(abs, null);
    return null;
  }
}

/** Forget everything. Tests only — the mtime check handles live edits. */
export function clearConventionCache(): void {
  cache.clear();
}

/**
 * Directories from the repo root down to the one holding `filePath`.
 *
 * Anything outside the repo is ignored rather than escaped to: a path that does
 * not sit under the root would otherwise walk up into the user's home.
 */
function dirChain(repoRoot: string, filePath?: string): string[] {
  const root = resolve(repoRoot);
  if (!filePath) return [root];
  const start = dirname(resolve(root, filePath));
  const rel = relative(root, start);
  if (rel.startsWith('..')) return [root];

  const out = [root];
  let cur = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    out.push(cur);
  }
  return out;
}

/**
 * The conventions governing one file, or the repo root when no file is given.
 *
 * Budget is spent nearest-first so that when a large root guide and a small
 * subtree guide compete, the subtree guide — the more specific rule, and the
 * one more likely to be violated — survives intact.
 */
export function conventionsFor(
  repoRoot: string,
  filePath?: string,
  budget = DEFAULT_BUDGET,
): ConventionChain {
  const dirs = dirChain(repoRoot, filePath);
  const root = resolve(repoRoot);

  const found: { path: string; text: string }[] = [];
  for (const dir of dirs) {
    const names = dir === root ? [...DIR_FILES, ...ROOT_ONLY] : DIR_FILES;
    for (const name of names) {
      const text = readCached(join(dir, name));
      if (text && text.trim()) {
        found.push({ path: relative(root, join(dir, name)) || name, text });
      }
    }
  }
  if (found.length === 0) return EMPTY_CHAIN;

  let remaining = budget;
  const kept = new Map<string, ConventionSource>();
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    if (remaining <= 0) break;
    const truncated = f.text.length > remaining;
    const text = truncated ? f.text.slice(0, remaining) : f.text;
    remaining -= text.length;
    kept.set(f.path, { path: f.path, text, truncated });
  }

  // Rendered root-first so the model reads general rules before the specific
  // ones that override them.
  const sources = found.map((f) => kept.get(f.path)).filter((s): s is ConventionSource => Boolean(s));
  const droppedCount = found.length - sources.length;
  const truncated = droppedCount > 0 || sources.some((s) => s.truncated);

  const body = sources
    .map((s) => {
      const head = `## ${s.path}`;
      const tail = s.truncated ? '\n\n[...truncated to fit the prompt budget]' : '';
      return `${head}\n\n${s.text.trim()}${tail}`;
    })
    .join('\n\n');

  const note =
    droppedCount > 0
      ? `\n\n(${droppedCount} further conventions file(s) were omitted for length.)`
      : '';

  const text = [
    '# House conventions',
    '',
    'These are the standards this repository holds itself to. Later files are',
    'nested deeper and override earlier ones where they conflict.',
    '',
    body + note,
  ].join('\n');

  return { sources, text, truncated };
}

/** One line naming what a run was actually judged against. */
export function describeChain(chain: ConventionChain): string {
  if (chain.sources.length === 0) return 'no conventions file found';
  return chain.sources.map((s) => s.path).join(' → ') + (chain.truncated ? ' (truncated)' : '');
}
