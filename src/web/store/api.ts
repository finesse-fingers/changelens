import type { ChangedFile, Snapshot, TargetSpec } from '../../shared/types.js';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      // Only when there is a body to describe. Declaring JSON and then sending
      // nothing makes Fastify reject the request with "Body cannot be empty",
      // which is how every cancel in this app silently failed: the UI reset
      // itself locally and the job carried on running.
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const e = body as { error?: string; hint?: string };
    const err = new Error(e.error ?? `Request failed (${res.status})`);
    (err as Error & { hint?: string }).hint = e.hint;
    throw err;
  }
  return body as T;
}

export interface RecentRepo {
  path: string;
  name: string;
  branch?: string;
  lastUsed: string;
  agents: ('claude' | 'codex')[];
  worktrees?: number;
}

export interface PrMeta {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  author: string;
}

/** One row in the PR quick-select. Mirrors `shared/prlist.ts`. */
export interface PrSummary {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  author: string;
  updatedAt: string;
}

/** `error` present means the query failed; `prs` is empty because nothing was
 *  learned, not because there is nothing. */
export interface PrGroup {
  prs: PrSummary[];
  error?: { message: string; hint?: string };
}

export interface PrLists {
  mine: PrGroup;
  reviewing: PrGroup;
}

export interface RepoInspect {
  root: string;
  branch?: string;
  dirty: boolean;
  pr: PrMeta | null;
  branches: string[];
}

export interface ReviewUnit {
  id: string;
  filePath: string;
  displayHunkId: string;
  contentHash: string;
  locatorHash: string;
  ordinal: number;
  oldStart: number | null;
  newStart: number | null;
  additions: number;
  deletions: number;
  symbol: string;
  lineRange: [number, number];
}

/** What changed since the last time this review was open. */
export interface ResumeReport {
  isNew: boolean;
  newUnits: number;
  goneUnits: number;
  carriedReviewed: number;
  movedUnits: number;
  editedUnits: number;
  previousHead?: string;
  baseMoved: boolean;
}

export interface SnapshotResponse {
  snapshot: Snapshot;
  diff: { snapshotId: string; files: ChangedFile[] };
  units: ReviewUnit[];
  states: Record<string, 'unreviewed' | 'reviewed' | 'flagged' | 'skimmed'>;
  resume: ResumeReport;
  dispositions: Record<string, string>;
  summary: { reviewable: number; digest: number; excluded: number; units: number };
}

export interface MapJobResult {
  map: {
    title: string;
    goal: string;
    brief: {
      whatChanged: string;
      whyThisApproach: string;
      assessment: Record<'scope' | 'codebase' | 'maintenance', { verdict: string; reason: string }>;
      evidenceAndCaveats: string;
    };
    cards: {
      id: string;
      title: string;
      summary: string;
      scope: 'Requested' | 'Supporting' | 'Extra';
      state: 'Planned' | 'Changed' | 'Verified' | 'Blocked';
      risk: 'high' | 'medium' | 'low';
      why?: string;
      alternative?: string;
      tradeoff?: string;
      hunkIds: string[];
      order: number;
    }[];
    attention: { level: 'info' | 'warning' | 'critical'; text: string }[];
  };
  unassignedFiles: string[];
  contestedFiles: string[];
  intentSufficient: boolean;
  durationMs: number;
}

export interface Finding {
  id: string;
  /** Position as reported. Rank IS severity — there is no severity field. */
  rank: number;
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  category?: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
  outcome?: 'fixed' | 'skipped' | 'no_change_needed';
  hunkId?: string;
}

export interface Recipe {
  tag: string;
  verifies: boolean;
  cap: number;
  sweep: boolean;
}

export interface ReviewJobResult {
  findings: Finding[];
  level?: string;
  degradedToSinglePass: boolean;
  capHit: boolean;
  /**
   * Why the run cannot be read as clean. The server sends this on the failure
   * payload; it is the only description of what actually went wrong.
   */
  incomplete?: string | null;
  /** True when the first turn ended silently and a resume recovered the report. */
  recovered?: boolean;
  /** Which conventions files the review was told to judge against. */
  conventions?: string;
  recipe: Recipe;
  durationMs: number;
}

export type Disposition =
  | 'fix' | 'reply-only' | 'already-addressed' | 'reject' | 'defer' | 'blocked' | 'administrative';

export interface JobEvent {
  seq: number;
  kind: 'status' | 'progress' | 'partial' | 'result' | 'error';
  at: string;
  data: unknown;
}

/** Subscribe to a job's event stream. */
export function streamJob(
  jobId: string,
  onEvent: (e: JobEvent) => void,
): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  const handle = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data) as JobEvent);
    } catch {
      /* a malformed frame is a lost update, not a reason to tear down */
    }
  };
  for (const kind of ['status', 'progress', 'partial', 'result', 'error']) {
    es.addEventListener(kind, handle as EventListener);
  }
  es.onerror = () => es.close();
  return () => es.close();
}

export type NarrationAxis = 'conventions' | 'clarity' | 'design';
export type AxisRating = 'strong' | 'ok' | 'weak';
export type Significance = 'major' | 'minor' | 'routine';

export interface NarrationAxisNote {
  axis: NarrationAxis;
  rating: AxisRating;
  reason: string;
  rule?: string;
  source?: string;
}

export interface Narration {
  hunkId: string;
  what: string;
  significance: Significance;
  score: number;
  axes?: NarrationAxisNote[];
  why?: string;
  watchFor?: string;
}

export interface CommentPreview {
  prNumber: number;
  prUrl: string;
  commitSha: string;
  comments: { findingId: string; path: string; line: number; body: string }[];
  skipped: { findingId: string; reason: string }[];
}

export interface FixResult {
  changedFiles: string[];
  diff: string;
  summary: string;
}

export interface ProvenanceEntry {
  filePath: string;
  agent: 'claude' | 'codex';
  sessionId: string;
  threadName?: string;
  prompt?: string;
  cwd: string;
  gitBranch?: string;
  timestamp: string;
}

export const api = {
  recentRepos: () => call<{ repos: RecentRepo[] }>('/repos/recent'),
  inspectRepo: (path: string) =>
    call<RepoInspect>(`/repo/inspect?path=${encodeURIComponent(path)}`),
  listPrs: (path: string) => call<PrLists>(`/repo/prs?path=${encodeURIComponent(path)}`),
  snapshot: (spec: TargetSpec & { prRef?: string }) =>
    call<SnapshotResponse>('/snapshot', { method: 'POST', body: JSON.stringify(spec) }),
  startMap: (snapshotId: string, model?: string) =>
    call<{ jobId: string }>('/map', { method: 'POST', body: JSON.stringify({ snapshotId, model }) }),
  cancelJob: (jobId: string) => call<{ ok: true }>(`/jobs/${jobId}/cancel`, { method: 'POST' }),
  startReview: (snapshotId: string, effort: string, model?: string) =>
    call<{ jobId: string; recipe: Recipe }>('/review', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, effort, model }),
    }),
  recipes: () => call<{ matrix: { model: string; effort: string; recipe: Recipe }[] }>('/recipes'),
  setUnitState: (snapshotId: string, unitId: string, state: string) =>
    call<{ ok: true }>('/unit-state', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, unitId, state }),
    }),
  setDisposition: (snapshotId: string, fingerprint: string, disposition: string) =>
    call<{ ok: true }>('/disposition', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, fingerprint, disposition }),
    }),
  previewComments: (snapshotId: string, findingIds: string[]) =>
    call<CommentPreview>('/comments/preview', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, findingIds }),
    }),
  postComments: (snapshotId: string, preview: CommentPreview) =>
    call<{ posted: number; failed: { findingId: string; error: string }[]; urls: string[] }>(
      '/comments/post',
      { method: 'POST', body: JSON.stringify({ snapshotId, preview }) },
    ),
  startNarrate: (
    snapshotId: string,
    opts: {
      model?: string;
      effort?: string;
      cards?: { title: string; files: string[] }[];
      /** Display order, so annotations arrive in the order they are read. */
      order?: string[];
    } = {},
  ) =>
    call<{ jobId: string }>('/narrate', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, ...opts }),
    }),
  startFix: (snapshotId: string, findingId: string) =>
    call<{ jobId: string }>('/fix', {
      method: 'POST',
      body: JSON.stringify({ snapshotId, findingId }),
    }),
  provenance: (snapshotId: string) =>
    call<{ byFile: Record<string, ProvenanceEntry[]>; attributed: number; total: number }>(
      `/provenance?snapshotId=${encodeURIComponent(snapshotId)}`,
    ),
};
