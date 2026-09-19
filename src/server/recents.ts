import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gitOrNull, isGitRepo, repoKey } from './git/exec.js';

export interface RecentRepo {
  path: string;
  name: string;
  branch?: string;
  lastUsed: string;
  /** Which agents have session history against this repo. */
  agents: ('claude' | 'codex')[];
  /** How many distinct worktrees of this repo have session history. */
  worktrees?: number;
}

/**
 * Discover repos the user actually works in, from agent session history.
 *
 * Claude encodes the cwd in the directory name; Codex records it inside each
 * rollout's `session_meta`. Both are scanned, because plenty of people run
 * both, often against the same repo from different worktrees.
 */
export async function recentRepos(limit = 12): Promise<RecentRepo[]> {
  const found = new Map<string, { lastUsed: number; agents: Set<'claude' | 'codex'> }>();

  const note = (path: string, when: number, agent: 'claude' | 'codex') => {
    const existing = found.get(path);
    if (existing) {
      existing.lastUsed = Math.max(existing.lastUsed, when);
      existing.agents.add(agent);
    } else {
      found.set(path, { lastUsed: when, agents: new Set([agent]) });
    }
  };

  await scanClaude(note);
  await scanCodex(note);

  const candidates = [...found.entries()].sort((a, b) => b[1].lastUsed - a[1].lastUsed);

  /*
   * Collapse worktrees to their repository.
   *
   * This user keeps dozens of live worktrees per repo (`~/.codex/worktrees/*`,
   * `~/.claude/worktrees/*`). `--show-toplevel` returns the *worktree* root, so
   * deduping on it lists the same repo ten times and crowds out the others.
   * The shared git dir is the true repo identity.
   */
  const byRepo = new Map<string, RecentRepo & { worktrees: number }>();
  for (const [path, meta] of candidates) {
    if (!(await isGitRepo(path).catch(() => false))) continue;
    const key = await repoKey(path).catch(() => null);
    if (!key) continue;

    const existing = byRepo.get(key);
    if (existing) {
      existing.worktrees++;
      for (const a of meta.agents) if (!existing.agents.includes(a)) existing.agents.push(a);
      continue;
    }

    // Prefer the primary worktree — the one whose root is the git dir's parent —
    // so the entry points at the canonical checkout rather than a scratch copy.
    const primary = (await gitOrNull(key, ['rev-parse', '--show-toplevel']))?.trim() || key;
    byRepo.set(key, {
      path: primary,
      name: primary.slice(primary.lastIndexOf('/') + 1),
      branch: (await gitOrNull(primary, ['branch', '--show-current']))?.trim() || undefined,
      lastUsed: new Date(meta.lastUsed).toISOString(),
      agents: [...meta.agents],
      worktrees: 1,
    });
  }

  return [...byRepo.values()]
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
    .slice(0, limit)
    .map(({ worktrees, ...r }) => ({ ...r, worktrees }));
}

async function scanClaude(note: (p: string, w: number, a: 'claude') => void): Promise<void> {
  const dir = join(homedir(), '.claude', 'projects');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    // Directory names are the cwd with separators replaced by '-', which is
    // lossy (a real '-' in a path is indistinguishable). Read the cwd out of
    // the transcript instead of trying to invert the encoding.
    const full = join(dir, entry);
    try {
      const files = (await readdir(full)).filter((f) => f.endsWith('.jsonl'));
      if (files.length === 0) continue;
      let newest = 0;
      let newestFile = '';
      for (const f of files) {
        const s = await stat(join(full, f));
        if (s.mtimeMs > newest) { newest = s.mtimeMs; newestFile = f; }
      }
      const cwd = await firstCwd(join(full, newestFile));
      if (cwd) note(cwd, newest, 'claude');
    } catch {
      continue;
    }
  }
}

/** Read just enough of a transcript to find its cwd, without loading the file. */
async function firstCwd(file: string): Promise<string | null> {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 200_000);
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { cwd?: string };
        if (o.cwd) return o.cwd;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function scanCodex(note: (p: string, w: number, a: 'codex') => void): Promise<void> {
  const root = join(homedir(), '.codex', 'sessions');
  const files: { path: string; mtime: number }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length > 400) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          files.push({ path: full, mtime: (await stat(full)).mtimeMs });
        } catch { /* raced with cleanup */ }
      }
    }
  };
  await walk(root, 0);

  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(0, 120)) {
    try {
      // A Codex rollout's opening `session_meta` line carries the full
      // instruction payload and routinely exceeds 100 KB, so a small slice
      // truncates mid-line and every parse fails silently.
      const head = (await readFile(f.path, 'utf8')).slice(0, 1_000_000);
      const newline = head.indexOf('\n');
      const firstLine = newline === -1 ? head : head.slice(0, newline);
      const o = JSON.parse(firstLine) as { payload?: { cwd?: string } };
      const cwd = o.payload?.cwd;
      if (cwd) note(cwd, f.mtime, 'codex');
    } catch {
      continue;
    }
  }
}
