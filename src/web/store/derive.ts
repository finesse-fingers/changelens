import { useMemo } from 'react';
import type { ChangedFile, Hunk } from '../../shared/types.js';
import { clusterFiles, orderFilesForReading, type ClusterFile } from '../../shared/cluster.js';
import type { Finding, MapJobResult, ProvenanceEntry, ReviewUnit } from './api.js';
import { useReview, type Grouping, type UnitState } from './review.js';

/*
 * Derived views live here, not in store selectors.
 *
 * A zustand selector that calls a function returning a fresh array fails
 * referential equality on every render and drives React into an update loop.
 * These hooks select raw state and memoize the derivation instead.
 */

type Card = MapJobResult['map']['cards'][number];

/**
 * Review order: the guided path.
 *
 * Ranked by how much a careful reviewer should care — source over tests,
 * structural change over tweaks, security-sensitive paths first — so the queue
 * front-loads what matters rather than following alphabetical file order.
 */
function fileSalience(f: ChangedFile): number {
  let score = 0;
  const p = f.path;
  const isTest = /(\.|\/)(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(p);
  const isDoc = /\.(md|mdx|txt|rst)$/.test(p);

  if (!isTest && !isDoc) score += 3;
  if (f.status === 'added' || f.status === 'deleted') score += 2;
  if (/(auth|crypt|secret|token|migration|\.sql$|iam|terraform|\.github\/workflows)/i.test(p)) score += 3;
  if (isTest) score -= 2;
  if (isDoc) score -= 1;
  if (f.tier === 'digest') score -= 3;

  // Size matters sublinearly: a 400-line file is not 40x a 10-line one.
  return score + Math.log2(1 + f.additions + f.deletions);
}

export function useReviewableFiles(): ChangedFile[] {
  const files = useReview((s) => s.data?.diff.files);
  return useMemo(
    () => (files ?? []).filter((f) => f.tier !== 'excluded').sort((a, b) => fileSalience(b) - fileSalience(a)),
    [files],
  );
}

export function useExcludedFiles(): ChangedFile[] {
  const files = useReview((s) => s.data?.diff.files);
  return useMemo(() => (files ?? []).filter((f) => f.tier === 'excluded'), [files]);
}

/* ------------------------------------------------------------- stream shape */

export interface StreamFile {
  file: ChangedFile;
  /** Only the hunks belonging to this section, always in line order. */
  hunks: Hunk[];
  units: ReviewUnit[];
  /**
   * The same units, already split by hunk.
   *
   * Grouped here rather than filtered at the render site so each hunk gets one
   * stable array. A fresh `units.filter(...)` per render defeats every memo
   * below it — the whole diff re-renders on each keystroke, because the console
   * subscribes to `focusedUnitId` — and re-runs the hunk segmentation with it.
   */
  unitsByHunk: Map<string, ReviewUnit[]>;
}

export interface StreamSection {
  id: string;
  /** Empty when the stream is ungrouped, which is how the header is suppressed. */
  label: string;
  /** What grouped these files — shown so the heuristic can be disbelieved. */
  reason: string;
  card: Card | null;
  files: StreamFile[];
  units: ReviewUnit[];
  additions: number;
  deletions: number;
}

/** What the clusterer needs, assembled from the diff and the provenance index. */
function toClusterFile(
  file: ChangedFile,
  units: ReviewUnit[],
  provenance: Record<string, ProvenanceEntry[]>,
): ClusterFile {
  const addedText: string[] = [];
  const allText: string[] = [];
  const symbols = new Set<string>();
  for (const h of file.hunks) {
    if (h.section) symbols.add(h.section);
    for (const l of h.lines) {
      if (l.kind === 'add') addedText.push(l.text);
      // Deletions count as mentions: a call site being removed still relates to
      // the definition being removed.
      allText.push(l.text);
    }
  }
  for (const u of units) if (u.symbol) symbols.add(u.symbol);

  const entries = provenance[file.path] ?? [];
  return {
    path: file.path,
    oldPath: file.oldPath,
    additions: file.additions,
    deletions: file.deletions,
    salience: fileSalience(file),
    symbols: [...symbols],
    addedText,
    allText,
    sessionIds: entries.map((e) => e.sessionId),
    sessionLabel: entries[0]?.threadName ?? undefined,
  };
}

const RISK_RANK: Record<Card['risk'], number> = { high: 0, medium: 1, low: 2 };

/**
 * Attribute each hunk to exactly one card.
 *
 * Cards carry `hunkIds` and a hunk can hold units from more than one card, so
 * something has to break the tie. Plurality keeps hunks whole: splitting one
 * would mean either eliding lines or showing them twice, and a review surface
 * that does either cannot be trusted to have shown you everything.
 */
function attributeHunks(units: ReviewUnit[], cards: Card[]): Map<string, string> {
  const cardOfUnit = new Map<string, string>();
  cards.forEach((c) => c.hunkIds.forEach((id) => cardOfUnit.set(id, c.id)));
  const rank = new Map(cards.map((c, i) => [c.id, i]));

  const votes = new Map<string, Map<string, number>>();
  for (const u of units) {
    const cardId = cardOfUnit.get(u.id);
    if (!cardId) continue;
    const tally = votes.get(u.displayHunkId) ?? new Map<string, number>();
    tally.set(cardId, (tally.get(cardId) ?? 0) + 1);
    votes.set(u.displayHunkId, tally);
  }

  const out = new Map<string, string>();
  for (const [hunkId, tally] of votes) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [cardId, n] of tally) {
      const beatsOnCount = n > bestCount;
      const beatsOnOrder =
        n === bestCount && best !== null && (rank.get(cardId) ?? 0) < (rank.get(best) ?? 0);
      if (beatsOnCount || beatsOnOrder) {
        best = cardId;
        bestCount = n;
      }
    }
    if (best) out.set(hunkId, best);
  }
  return out;
}

function buildStreamFile(file: ChangedFile, hunks: Hunk[], units: ReviewUnit[]): StreamFile {
  const ids = new Set(hunks.map((h) => h.id));
  const own = units
    .filter((u) => u.filePath === file.path && ids.has(u.displayHunkId))
    .sort((a, b) => (a.newStart ?? a.oldStart ?? 0) - (b.newStart ?? b.oldStart ?? 0));
  const unitsByHunk = new Map<string, ReviewUnit[]>();
  for (const unit of own) {
    const bucket = unitsByHunk.get(unit.displayHunkId);
    if (bucket) bucket.push(unit);
    else unitsByHunk.set(unit.displayHunkId, [unit]);
  }

  // Hunks always stay in line order. Reordering lines inside a file would
  // misrepresent the code being reviewed.
  return {
    file,
    hunks: [...hunks].sort((a, b) => a.index - b.index),
    units: own,
    unitsByHunk,
  };
}

function sectionOf(
  id: string,
  label: string,
  reason: string,
  card: Card | null,
  files: StreamFile[],
): StreamSection {
  return {
    id,
    label,
    reason,
    card,
    files,
    units: files.flatMap((f) => f.units),
    additions: files.reduce((n, f) => n + f.file.additions, 0),
    deletions: files.reduce((n, f) => n + f.file.deletions, 0),
  };
}

/**
 * The diff, grouped by change.
 *
 * Deterministic clustering runs on load with no model call, so the stream is
 * organised before anything is spent; the map job's cards replace those groups
 * with real titles and risk once it has run.
 */
/*
 * `useMemo` is per component instance, and the console, the diff and the jump
 * palette all need the same stream. Without a shared cache the clustering pass
 * runs once per consumer on every render that changes its inputs. The deps are
 * referentially stable, so a single-entry cache keyed on identity is enough.
 */
let streamCache: { deps: unknown[]; value: StreamSection[] } | null = null;

function cachedStream(deps: unknown[], build: () => StreamSection[]): StreamSection[] {
  if (streamCache && streamCache.deps.length === deps.length &&
      streamCache.deps.every((d, i) => d === deps[i])) {
    return streamCache.value;
  }
  const value = build();
  streamCache = { deps, value };
  return value;
}

export function useStreamSections(): StreamSection[] {
  const files = useReviewableFiles();
  const rawUnits = useReview((s) => s.data?.units);
  const provenance = useReview((s) => s.provenance);
  const map = useReview((s) => s.map);
  const mapStatus = useReview((s) => s.mapStatus);
  const grouping = useReview((s) => s.grouping);

  return useMemo(() => cachedStream([files, rawUnits, provenance, map, mapStatus, grouping], () => {
    const units = rawUnits ?? [];
    const visible = new Set(files.map((f) => f.path));
    const inView = units.filter((u) => visible.has(u.filePath));
    const byPath = new Map(files.map((f) => [f.path, f]));

    const cardsReady = map && mapStatus === 'done' && map.map.cards.length > 0;
    const mode: Grouping = grouping === 'card' && !cardsReady ? 'change' : grouping;

    if (mode === 'file') {
      return [
        sectionOf(
          'all',
          '',
          '',
          null,
          files.map((f) => buildStreamFile(f, f.hunks, inView)),
        ),
      ];
    }

    if (mode === 'card' && cardsReady) {
      const attribution = attributeHunks(inView, map.map.cards);
      const ordered = [...map.map.cards].sort(
        (a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || a.order - b.order,
      );

      const sections: StreamSection[] = [];
      const claimed = new Set<string>();
      for (const card of ordered) {
        const hunksByFile = new Map<string, Hunk[]>();
        for (const f of files) {
          for (const h of f.hunks) {
            if (attribution.get(h.id) !== card.id) continue;
            hunksByFile.set(f.path, [...(hunksByFile.get(f.path) ?? []), h]);
            claimed.add(h.id);
          }
        }
        if (hunksByFile.size === 0) continue;

        const paths = orderFilesForReading(
          [...hunksByFile.keys()].map((p) =>
            toClusterFile(byPath.get(p)!, inView, provenance),
          ),
        );
        sections.push(
          sectionOf(
            card.id,
            card.title,
            `${card.scope} · ${card.risk} risk · ${card.summary}`,
            card,
            paths.map((p) => buildStreamFile(byPath.get(p)!, hunksByFile.get(p)!, inView)),
          ),
        );
      }

      // Anything the map did not place still has to be reviewable. Dropping it
      // would hide real code behind an LLM's omission.
      const leftovers = files
        .map((f) => ({ f, hunks: f.hunks.filter((h) => !claimed.has(h.id)) }))
        .filter((x) => x.hunks.length > 0);
      if (leftovers.length > 0) {
        sections.push(
          sectionOf(
            'unsorted',
            'Unsorted',
            'the change map did not assign these',
            null,
            leftovers.map((x) => buildStreamFile(x.f, x.hunks, inView)),
          ),
        );
      }
      return sections;
    }

    if (mode === 'session') {
      const bucket = new Map<string, { label: string; files: ChangedFile[] }>();
      for (const f of files) {
        const e = provenance[f.path]?.[0];
        const key = e ? `${e.agent}:${e.sessionId}` : 'unattributed';
        const label = e
          ? `${e.agent} · ${e.threadName ?? e.prompt?.replace(/\s+/g, ' ').slice(0, 48) ?? e.sessionId.slice(0, 8)}`
          : 'Not attributed to a session';
        const cur = bucket.get(key) ?? { label, files: [] };
        cur.files.push(f);
        bucket.set(key, cur);
      }
      return [...bucket.entries()]
        .map(([key, b]) =>
          sectionOf(
            key,
            b.label,
            key === 'unattributed'
              ? 'no agent transcript recorded these edits'
              : 'written by the same agent session',
            null,
            orderFilesForReading(b.files.map((f) => toClusterFile(f, inView, provenance))).map(
              (p) => buildStreamFile(byPath.get(p)!, byPath.get(p)!.hunks, inView),
            ),
          ),
        )
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    }

    const groups = clusterFiles(files.map((f) => toClusterFile(f, inView, provenance)));
    return groups.map((g) =>
      sectionOf(
        g.id,
        g.label,
        g.reason,
        null,
        g.paths.map((p) => buildStreamFile(byPath.get(p)!, byPath.get(p)!.hunks, inView)),
      ),
    );
  }), [files, rawUnits, provenance, map, mapStatus, grouping]);
}

/**
 * Units in the order they appear on screen.
 *
 * Derived from the stream rather than computed separately, so `j`/`k`/`n` can
 * never walk a different order than the one being read.
 */
export function useOrderedUnits(): ReviewUnit[] {
  const sections = useStreamSections();
  return useMemo(() => sections.flatMap((s) => s.units), [sections]);
}

export interface Progress {
  reviewed: number;
  flagged: number;
  total: number;
  pct: number;
}

export function useProgress(): Progress {
  const states = useReview((s) => s.unitStates);
  const units = useOrderedUnits();
  return useMemo(() => {
    let reviewed = 0;
    let flagged = 0;
    for (const u of units) {
      const s: UnitState = states[u.id] ?? 'unreviewed';
      if (s === 'reviewed' || s === 'skimmed') reviewed++;
      if (s === 'flagged') flagged++;
    }
    return {
      reviewed,
      flagged,
      total: units.length,
      pct: units.length ? Math.round((reviewed / units.length) * 100) : 0,
    };
  }, [states, units]);
}

/** Per-file completion. */
export function useFileProgress(): Map<string, { done: number; total: number }> {
  const states = useReview((s) => s.unitStates);
  const units = useOrderedUnits();
  return useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const u of units) {
      const entry = m.get(u.filePath) ?? { done: 0, total: 0 };
      entry.total++;
      const s: UnitState = states[u.id] ?? 'unreviewed';
      if (s === 'reviewed' || s === 'skimmed') entry.done++;
      m.set(u.filePath, entry);
    }
    return m;
  }, [states, units]);
}

/** Per-section completion, for the group headers. */
export function useSectionProgress(): Map<string, { done: number; total: number }> {
  const states = useReview((s) => s.unitStates);
  const sections = useStreamSections();
  return useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const sec of sections) {
      let done = 0;
      for (const u of sec.units) {
        const s: UnitState = states[u.id] ?? 'unreviewed';
        if (s === 'reviewed' || s === 'skimmed') done++;
      }
      m.set(sec.id, { done, total: sec.units.length });
    }
    return m;
  }, [states, sections]);
}

/** Findings still awaiting a call, in reported rank order. */
export function useOpenFindings(): Finding[] {
  const findings = useReview((s) => s.findings);
  const dispositions = useReview((s) => s.dispositions);
  return useMemo(
    () => findings.filter((f) => !dispositions[f.id]),
    [findings, dispositions],
  );
}
