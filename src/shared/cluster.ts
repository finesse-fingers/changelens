/**
 * Grouping a diff by *change* rather than by file.
 *
 * A flat file list scatters one coherent change across the scroll and
 * interleaves it with unrelated ones. This module reassembles it from signals
 * the app already computes — no model call, so grouping exists the moment the
 * repo opens and is identical on every run.
 *
 * Deliberately pure: data in, groups out. No React, no DOM, no I/O, which is
 * what makes the heuristics here testable rather than merely plausible.
 */

export interface ClusterFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  /**
   * Caller-supplied ranking, so this module never has to know what the product
   * considers important. In the app this is `fileSalience` from the store.
   */
  salience: number;
  /** Symbol names from review units and `@@` hunk headers. */
  symbols: string[];
  /** Added lines only — where a declaration would appear. */
  addedText: string[];
  /** Added and context lines — where a reference could appear. */
  allText: string[];
  /** Agent session ids that touched this file, newest first. */
  sessionIds: string[];
  /** Human-readable name for the newest session, when one exists. */
  sessionLabel?: string;
}

export type GroupReason = 'rename' | 'name-pair' | 'symbol' | 'session' | 'directory' | 'alone';

export interface ClusterGroup {
  id: string;
  label: string;
  /** What actually grouped these files, shown in the UI so it can be disbelieved. */
  reason: string;
  reasons: GroupReason[];
  /** File paths in reading order: definitions, then call sites, then tests. */
  paths: string[];
  additions: number;
  deletions: number;
  /** The group's rank against other groups — the max salience of its members. */
  salience: number;
}

/**
 * Identifiers too common to mean anything.
 *
 * Without this, one file declaring `config` and another merely mentioning it
 * merges two unrelated changes — and because union-find is transitive, a single
 * bad edge can collapse the entire diff into one group.
 */
const STOPLIST = new Set([
  'data', 'value', 'init', 'main', 'index', 'config', 'result', 'handler',
  'error', 'options', 'props', 'state', 'type', 'name', 'item', 'items',
  'list', 'args', 'params', 'input', 'output', 'response', 'request',
  'default', 'export', 'const', 'string', 'number', 'object', 'array',
]);

const MIN_IDENT = 4;

/** A session touching most of the diff says nothing about which parts relate. */
const SESSION_MAX_SHARE = 0.6;
const SESSION_MAX_FILES = 12;

/**
 * The symbol pass compares every pair of files. That is fine for the diffs a
 * human reviews and quadratic for the ones they do not, so it is skipped rather
 * than allowed to block the first paint. Grouping then falls back to names,
 * sessions and directories, which is worse but still useful.
 */
const SYMBOL_PASS_MAX_FILES = 300;

function meaningful(name: string): boolean {
  return name.length >= MIN_IDENT && !STOPLIST.has(name.toLowerCase());
}

/* ------------------------------------------------------------------ union-find */

class DisjointSet {
  private parent: number[];
  /** Why each merge happened, so a group can explain itself. */
  readonly reasons = new Set<GroupReason>();

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent[rb] = ra;
    return true;
  }
}

/* --------------------------------------------------------------- path helpers */

const TEST_RE = /(^|[./\\])(test|spec)s?([./\\]|$)|\.(test|spec)\./i;

export function isTestPath(p: string): boolean {
  return TEST_RE.test(p);
}

/**
 * The name two related files share.
 *
 * `units.ts`, `units.test.ts` and `__tests__/units.ts` all reduce to `units`,
 * which is what pairs an implementation with the thing that proves it.
 */
export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  // Strip every extension, then the test/spec marker that is left behind.
  const dot = base.indexOf('.');
  const noExt = dot === -1 ? base : base.slice(0, dot);
  return noExt.replace(/[._-](test|spec)$/i, '').toLowerCase();
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => dirOf(p).split('/').filter(Boolean));
  const first = split[0];
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (split.every((s) => s[i] === first[i])) out.push(first[i]);
    else break;
  }
  return out.join('/');
}

/* ------------------------------------------------------------ symbol analysis */

const DECL_RE =
  /\b(?:function|class|interface|enum|struct|trait|impl|def|func|fn|type)\s+([A-Za-z_$][\w$]*)/g;
const BINDING_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:(]/g;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/**
 * A definition another file could depend on is exported, or lives at the top
 * level. A binding inside a function body is a local: it shares a name with
 * whatever else in the codebase happens to use that word, and treating it as a
 * definition invents cross-file dependencies.
 *
 * This is not hypothetical — `const usage = deltas.findLast(...)` inside a test
 * body was enough to make that test look like the definition of `usage` and
 * sort it ahead of the encoder it tests.
 */
function isDefinitionSite(line: string): boolean {
  if (/^[+\-]?\s*export\b/.test(line)) return true;
  const indent = line.length - line.replace(/^\s+/, '').length;
  return indent === 0;
}

/** Names this file declares — the left-hand side of a definition → use edge. */
export function declaredNames(addedText: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of addedText) {
    if (!isDefinitionSite(line)) continue;
    for (const re of [DECL_RE, BINDING_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (meaningful(m[1])) out.add(m[1]);
      }
    }
  }
  return out;
}

/** Every identifier appearing in the file's changed region. */
function mentionedNames(allText: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of allText) {
    IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT_RE.exec(line)) !== null) {
      if (meaningful(m[0])) out.add(m[0]);
    }
  }
  return out;
}

function meaningfulSymbols(f: ClusterFile): Set<string> {
  const out = new Set<string>();
  for (const raw of f.symbols) {
    // `@@` section headers carry a whole signature; take the identifiers from it.
    IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT_RE.exec(raw)) !== null) {
      if (meaningful(m[0])) out.add(m[0]);
    }
  }
  return out;
}

/* --------------------------------------------------------------- the clusterer */

export function clusterFiles(files: ClusterFile[]): ClusterGroup[] {
  if (files.length === 0) return [];

  const ds = new DisjointSet(files.length);
  const reasonsFor = new Map<number, Set<GroupReason>>();
  const noteReason = (a: number, b: number, r: GroupReason) => {
    for (const i of [a, b]) {
      const set = reasonsFor.get(i) ?? new Set<GroupReason>();
      set.add(r);
      reasonsFor.set(i, set);
    }
  };

  const stems = files.map((f) => stemOf(f.path));
  const symbolSets = files.map(meaningfulSymbols);
  const declaredSets = files.map((f) => declaredNames(f.addedText));
  const mentionedSets = files.map((f) => mentionedNames(f.allText));

  // 1. A rename's old path pairs with anything that was tracking it.
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  files.forEach((f, i) => {
    if (!f.oldPath) return;
    const j = byPath.get(f.oldPath);
    if (j !== undefined && ds.union(i, j)) noteReason(i, j, 'rename');
  });

  // 2. Name pairs: an implementation and the test, style or type file beside it.
  const byStem = new Map<string, number[]>();
  stems.forEach((s, i) => {
    if (!s) return;
    byStem.set(s, [...(byStem.get(s) ?? []), i]);
  });
  for (const idxs of byStem.values()) {
    for (let k = 1; k < idxs.length; k++) {
      if (ds.union(idxs[0], idxs[k])) noteReason(idxs[0], idxs[k], 'name-pair');
    }
  }

  // 3. Shared symbols: what pairs a definition with its call site across files.
  //    A declaration in one file mentioned in another is the strong form; two
  //    files whose hunk headers name the same function is the weak form.
  if (files.length <= SYMBOL_PASS_MAX_FILES) {
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      let linked = false;
      for (const name of declaredSets[i]) {
        if (mentionedSets[j].has(name)) { linked = true; break; }
      }
      if (!linked) {
        for (const name of declaredSets[j]) {
          if (mentionedSets[i].has(name)) { linked = true; break; }
        }
      }
      if (!linked) {
        for (const name of symbolSets[i]) {
          if (symbolSets[j].has(name)) { linked = true; break; }
        }
      }
      if (linked && ds.union(i, j)) noteReason(i, j, 'symbol');
    }
  }
  }

  // 4. Same agent session — one run is usually one intent. Suppressed when the
  //    session touched most of the diff, since a partition everything belongs
  //    to carries no information.
  const bySession = new Map<string, number[]>();
  files.forEach((f, i) => {
    for (const sid of f.sessionIds) {
      bySession.set(sid, [...(bySession.get(sid) ?? []), i]);
    }
  });
  for (const idxs of bySession.values()) {
    if (idxs.length < 2) continue;
    if (idxs.length > SESSION_MAX_FILES) continue;
    if (idxs.length / files.length > SESSION_MAX_SHARE) continue;
    for (let k = 1; k < idxs.length; k++) {
      if (ds.union(idxs[0], idxs[k])) noteReason(idxs[0], idxs[k], 'session');
    }
  }

  // 5. Directory, as a fallback only: files still sitting alone join their
  //    neighbours rather than each becoming a one-file group.
  const sizes = new Map<number, number>();
  for (let i = 0; i < files.length; i++) {
    const r = ds.find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  const byDir = new Map<string, number[]>();
  for (let i = 0; i < files.length; i++) {
    if ((sizes.get(ds.find(i)) ?? 1) > 1) continue;
    const d = dirOf(files[i].path);
    byDir.set(d, [...(byDir.get(d) ?? []), i]);
  }
  for (const idxs of byDir.values()) {
    for (let k = 1; k < idxs.length; k++) {
      if (ds.union(idxs[0], idxs[k])) noteReason(idxs[0], idxs[k], 'directory');
    }
  }

  /* ---------------------------------------------------------- assemble groups */

  const members = new Map<number, number[]>();
  for (let i = 0; i < files.length; i++) {
    const r = ds.find(i);
    members.set(r, [...(members.get(r) ?? []), i]);
  }

  const groups: ClusterGroup[] = [];
  for (const [root, idxs] of members) {
    const groupFiles = idxs.map((i) => files[i]);
    const reasons = new Set<GroupReason>();
    for (const i of idxs) for (const r of reasonsFor.get(i) ?? []) reasons.add(r);
    if (reasons.size === 0) reasons.add('alone');

    const ordered = readingOrder(idxs, files, declaredSets, mentionedSets, stems);

    groups.push({
      id: `g:${files[root].path}`,
      label: labelFor(groupFiles, reasons),
      reason: reasonText(reasons, groupFiles, symbolSets, idxs),
      reasons: [...reasons],
      paths: ordered.map((i) => files[i].path),
      additions: groupFiles.reduce((n, f) => n + f.additions, 0),
      deletions: groupFiles.reduce((n, f) => n + f.deletions, 0),
      salience: Math.max(...groupFiles.map((f) => f.salience)),
    });
  }

  // Between groups: what can hurt you first, then by size. Ties break on label
  // so the order is stable across reloads.
  groups.sort(
    (a, b) =>
      b.salience - a.salience ||
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.label.localeCompare(b.label),
  );
  return groups;
}

/**
 * Reading order for a set of files the caller has already grouped.
 *
 * Card sections come from the map job rather than from `clusterFiles`, but a
 * card should read the same way a deterministic group does — so both go through
 * the same sort rather than each growing its own idea of order.
 */
export function orderFilesForReading(files: ClusterFile[]): string[] {
  const idxs = files.map((_, i) => i);
  const declared = files.map((f) => declaredNames(f.addedText));
  const mentioned = files.map((f) => mentionedNames(f.allText));
  const stems = files.map((f) => stemOf(f.path));
  return readingOrder(idxs, files, declared, mentioned, stems).map((i) => files[i].path);
}

/* ------------------------------------------------------------- reading order */

/**
 * Definitions before their call sites, sources before their tests.
 *
 * Kahn's algorithm with the salience comparator as the tie-break, so the sort
 * respects the existing ranking wherever the dependency graph leaves it free.
 * With no detectable edges the result is exactly the salience order — the
 * heuristic can improve on the current behaviour but never scramble it.
 */
function readingOrder(
  idxs: number[],
  files: ClusterFile[],
  declared: Set<string>[],
  mentioned: Set<string>[],
  stems: string[],
): number[] {
  const fallback = (a: number, b: number) =>
    files[b].salience - files[a].salience || files[a].path.localeCompare(files[b].path);

  const edges = new Map<number, Set<number>>(idxs.map((i) => [i, new Set<number>()]));
  const indegree = new Map<number, number>(idxs.map((i) => [i, 0]));
  const addEdge = (from: number, to: number) => {
    if (from === to) return;
    const set = edges.get(from)!;
    if (set.has(to)) return;
    set.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  };

  for (const i of idxs) {
    for (const j of idxs) {
      if (i === j) continue;
      // The definition comes before the code that uses it.
      let defines = false;
      for (const name of declared[i]) {
        if (mentioned[j].has(name) && !declared[j].has(name)) { defines = true; break; }
      }
      if (defines) addEdge(i, j);
      // A test follows the thing it tests.
      if (stems[i] === stems[j] && !isTestPath(files[i].path) && isTestPath(files[j].path)) {
        addEdge(i, j);
      }
    }
  }

  const out: number[] = [];
  const ready = idxs.filter((i) => indegree.get(i) === 0).sort(fallback);
  const remaining = new Set(idxs);

  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(next);
    remaining.delete(next);
    for (const to of edges.get(next)!) {
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) {
        ready.push(to);
        ready.sort(fallback);
      }
    }
  }

  // A cycle (mutual references, which happens) leaves nodes stranded. Emit them
  // in fallback order rather than dropping them — losing a file would be far
  // worse than showing one out of dependency order.
  if (remaining.size > 0) out.push(...[...remaining].sort(fallback));
  return out;
}

/* -------------------------------------------------------------- group naming */

function labelFor(groupFiles: ClusterFile[], reasons: Set<GroupReason>): string {
  if (reasons.has('session')) {
    const named = groupFiles.find((f) => f.sessionLabel);
    if (named?.sessionLabel) return named.sessionLabel;
  }
  const prefix = commonPrefix(groupFiles.map((f) => f.path));
  if (prefix) return prefix;
  const biggest = [...groupFiles].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  )[0];
  return biggest.path.slice(biggest.path.lastIndexOf('/') + 1);
}

/**
 * A sentence saying why these files are together.
 *
 * Grouping is a heuristic over incomplete signals, so the UI shows its working
 * and the reviewer can dismiss it — a grouping presented as fact would be a
 * claim the app cannot support.
 */
function reasonText(
  reasons: Set<GroupReason>,
  groupFiles: ClusterFile[],
  symbolSets: Set<string>[],
  idxs: number[],
): string {
  const parts: string[] = [];
  if (reasons.has('rename')) parts.push('renamed');
  if (reasons.has('name-pair')) parts.push('matching names');
  if (reasons.has('symbol')) {
    const shared = sharedSymbol(symbolSets, idxs);
    parts.push(shared ? `shares \`${shared}\`` : 'shared symbols');
  }
  if (reasons.has('session')) parts.push('same agent session');
  if (reasons.has('directory')) parts.push('same directory');
  if (parts.length === 0) {
    return groupFiles.length === 1 ? 'on its own' : 'grouped by path';
  }
  return parts.join(' · ');
}

function sharedSymbol(symbolSets: Set<string>[], idxs: number[]): string | null {
  const counts = new Map<string, number>();
  for (const i of idxs) {
    for (const name of symbolSets[i]) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [name, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && name.length > best.length)) {
      best = name;
      bestCount = n;
    }
  }
  return best;
}
