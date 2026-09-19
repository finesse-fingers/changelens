import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind, ProvenanceEntry } from '../../shared/types.js';
import { gitOrNull } from '../git/exec.js';

/**
 * Who wrote each changed file, and what they were asked to do.
 *
 * Built by scanning agent transcripts rather than git history, because the
 * question is not "which commit touched this" but "which session produced this,
 * and what was the prompt" — the thing you lose when several agents run in
 * parallel across worktrees and you come back to a PR days later.
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Index {
  /** repoKey → file path → entries, newest first. */
  byRepo: Map<string, Map<string, ProvenanceEntry[]>>;
  scannedAt: number;
  /** mtime watermark per file, so rescans are incremental. */
  watermarks: Map<string, number>;
}

const index: Index = { byRepo: new Map(), scannedAt: 0, watermarks: new Map() };

/** Maps a session cwd to its repository, collapsing worktrees. */
const repoKeyCache = new Map<string, string | null>();

async function repoKeyOf(cwd: string): Promise<string | null> {
  const cached = repoKeyCache.get(cwd);
  if (cached !== undefined) return cached;
  const common = (await gitOrNull(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  const key = common ? common.replace(/\/\.git\/?$/, '') : null;
  repoKeyCache.set(cwd, key);
  return key;
}

function record(entry: ProvenanceEntry, repoKey: string): void {
  let repo = index.byRepo.get(repoKey);
  if (!repo) {
    repo = new Map();
    index.byRepo.set(repoKey, repo);
  }
  const list = repo.get(entry.filePath) ?? [];
  list.push(entry);
  repo.set(entry.filePath, list);
}

export async function buildIndex(force = false): Promise<{ files: number; entries: number }> {
  if (!force && Date.now() - index.scannedAt < 60_000) {
    return summarize();
  }
  await scanClaude();
  await scanCodex();
  for (const repo of index.byRepo.values()) {
    for (const list of repo.values()) {
      list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
  }
  index.scannedAt = Date.now();
  return summarize();
}

function summarize() {
  let files = 0;
  let entries = 0;
  for (const repo of index.byRepo.values()) {
    files += repo.size;
    for (const list of repo.values()) entries += list.length;
  }
  return { files, entries };
}

/** Entries for a file, relative to its repo. Newest first. */
export async function provenanceFor(repoKey: string, paths: string[]): Promise<Record<string, ProvenanceEntry[]>> {
  await buildIndex();
  const repo = index.byRepo.get(repoKey);
  const out: Record<string, ProvenanceEntry[]> = {};
  if (!repo) return out;
  for (const p of paths) {
    const hits = repo.get(p);
    if (hits?.length) out[p] = hits.slice(0, 5);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude transcripts
// ---------------------------------------------------------------------------

interface ClaudeLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
}

async function scanClaude(): Promise<void> {
  const root = join(homedir(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return;
  }

  for (const dir of dirs) {
    const full = join(root, dir);
    let files: string[];
    try {
      files = (await readdir(full)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(full, f);
      try {
        const mtime = (await stat(path)).mtimeMs;
        if (index.watermarks.get(path) === mtime) continue;
        index.watermarks.set(path, mtime);
        await scanClaudeFile(path);
      } catch {
        continue;
      }
    }
  }
}

async function scanClaudeFile(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8');
  let repoKey: string | null = null;
  let cwd = '';
  let branch: string | undefined;
  let sessionId = '';
  /** The most recent real user prompt — what the edits that follow were for. */
  let lastPrompt = '';

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: ClaudeLine;
    try {
      o = JSON.parse(line) as ClaudeLine;
    } catch {
      continue;
    }

    if (o.cwd && o.cwd !== cwd) {
      cwd = o.cwd;
      repoKey = await repoKeyOf(cwd);
    }
    if (o.gitBranch) branch = o.gitBranch;
    if (o.sessionId) sessionId = o.sessionId;

    // Track the user's own prompts, skipping tool results and injected meta.
    if (o.type === 'user' && !o.isMeta && typeof o.message?.content === 'string') {
      const text = o.message.content.trim();
      if (text && !text.startsWith('<')) lastPrompt = text;
    }

    if (o.type !== 'assistant' || !Array.isArray(o.message?.content) || !repoKey) continue;
    for (const block of o.message.content as { type?: string; name?: string; input?: { file_path?: string } }[]) {
      if (block.type !== 'tool_use' || !block.name || !EDIT_TOOLS.has(block.name)) continue;
      const filePath = block.input?.file_path;
      if (!filePath) continue;
      const rel = toRepoRelative(filePath, cwd, repoKey);
      if (!rel) continue;
      record(
        {
          filePath: rel,
          agent: 'claude',
          sessionId,
          prompt: lastPrompt.slice(0, 2000) || undefined,
          cwd,
          gitBranch: branch,
          timestamp: o.timestamp ?? new Date(0).toISOString(),
        },
        repoKey,
      );
    }
  }
}

/**
 * Edits are recorded with absolute paths inside a worktree; the diff uses paths
 * relative to the repository. Strip whichever root actually applies.
 */
function toRepoRelative(filePath: string, cwd: string, repoKey: string): string | null {
  for (const root of [cwd, repoKey]) {
    if (root && filePath.startsWith(root + '/')) return filePath.slice(root.length + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codex rollouts
// ---------------------------------------------------------------------------

async function scanCodex(): Promise<void> {
  const root = join(homedir(), '.codex', 'sessions');
  const names = await loadCodexThreadNames();
  const files: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length > 600) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(full);
    }
  };
  await walk(root, 0);

  for (const path of files) {
    try {
      const mtime = (await stat(path)).mtimeMs;
      if (index.watermarks.get(path) === mtime) continue;
      index.watermarks.set(path, mtime);
      await scanCodexFile(path, names);
    } catch {
      continue;
    }
  }
}

async function loadCodexThreadNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = await readFile(join(homedir(), '.codex', 'session_index.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { id?: string; thread_name?: string };
        if (o.id && o.thread_name) out.set(o.id, o.thread_name);
      } catch {
        continue;
      }
    }
  } catch {
    /* no index: entries fall back to no thread name */
  }
  return out;
}

async function scanCodexFile(path: string, names: Map<string, string>): Promise<void> {
  // The opening session_meta line carries the full instruction payload and can
  // exceed 100 KB, so a small read slice truncates it and every parse fails.
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');
  if (!lines[0]) return;

  let meta: { payload?: { cwd?: string; id?: string; session_id?: string } };
  try {
    meta = JSON.parse(lines[0]) as typeof meta;
  } catch {
    return;
  }
  const cwd = meta.payload?.cwd;
  if (!cwd) return;
  const repoKey = await repoKeyOf(cwd);
  if (!repoKey) return;

  const id = meta.payload?.id ?? meta.payload?.session_id ?? '';
  const threadName = names.get(id);
  let lastPrompt = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    const payload = o.payload as
      | { type?: string; role?: string; content?: unknown; name?: string; arguments?: string }
      | undefined;
    if (!payload) continue;

    if (payload.role === 'user' && typeof payload.content === 'string') {
      lastPrompt = payload.content.trim();
    }

    // Codex records edits as shell/apply_patch calls; recover touched paths
    // from the patch envelope rather than a structured file_path field.
    const args = typeof payload.arguments === 'string' ? payload.arguments : '';
    if (!args.includes('*** Update File:') && !args.includes('*** Add File:')) continue;
    for (const m of args.matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)) {
      const rel = m[1].trim().replace(/^\.\//, '');
      if (!rel) continue;
      record(
        {
          filePath: rel,
          agent: 'codex' as AgentKind,
          sessionId: id,
          threadName,
          prompt: lastPrompt.slice(0, 2000) || undefined,
          cwd,
          timestamp: o.timestamp ?? new Date(0).toISOString(),
        },
        repoKey,
      );
    }
  }
}
