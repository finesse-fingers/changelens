import { create } from 'zustand';
import {
  api, streamJob,
  type Disposition, type Finding, type MapJobResult, type ProvenanceEntry, type Recipe,
  type CommentPreview, type FixResult, type Narration, type ResumeReport, type ReviewJobResult,
  type ReviewUnit, type SnapshotResponse,
} from './api.js';

export type UnitState = 'unreviewed' | 'reviewed' | 'flagged' | 'skimmed';

/**
 * How the stream groups the diff.
 *
 * `change` needs no model call and is therefore the default; `card` is only
 * reachable once the map job has run. Both are exposed rather than one being
 * chosen for the reviewer, as with the recipe matrix.
 */
export type Grouping = 'change' | 'card' | 'file' | 'session';

/**
 * How much of the annotation layer is shown.
 *
 * The default is `notable` rather than `all`: a diff is mostly routine, and an
 * overlay that treats a rename like a behaviour change is one nobody reads.
 */
export type NoteFilter = 'all' | 'notable' | 'problems';

interface ReviewStore {
  data: SnapshotResponse | null;
  /** Review state lives on units, never on files or cards — cards re-cluster. */
  unitStates: Record<string, UnitState>;
  focusedUnitId: string | null;
  showNoise: boolean;
  theme: 'dark' | 'paper';
  grouping: Grouping;
  /** Set once the reviewer picks a grouping, so the map never overrides them. */
  groupingPinned: boolean;
  /** Overlays and the lead brief, all keyboard-reachable. */
  briefCollapsed: boolean;
  paletteOpen: boolean;
  keysOpen: boolean;
  /** The triage ledger: every finding in one place, rather than scattered. */
  ledgerOpen: boolean;
  /** Findings picked for a batch action. Cleared when one completes. */
  selectedFindings: Record<string, true>;

  /** The change map: cards, brief and attention items. */
  map: MapJobResult | null;
  mapStatus: 'idle' | 'running' | 'done' | 'failed';
  mapActivity: string;
  mapError: string | null;
  mapJobId: string | null;
  /** Which card the rail has expanded. */
  openCardId: string | null;

  /** Findings from /code-review, in reported rank order. Never re-sorted. */
  findings: Finding[];
  reviewStatus: 'idle' | 'running' | 'done' | 'failed';
  reviewActivity: string;
  reviewError: string | null;
  reviewJobId: string | null;
  reviewMeta: ReviewJobResult | null;
  recipe: Recipe | null;
  effort: string;
  model: string;
  dispositions: Record<string, Disposition>;
  openFindingId: string | null;

  /** file path → who wrote it, newest first. */
  provenance: Record<string, ProvenanceEntry[]>;
  openProvenanceFile: string | null;

  /** What changed since this review was last open. Dismissible. */
  resume: ResumeReport | null;
  resumeDismissed: boolean;

  /**
   * Write-back is always two-step: a pending action holds the exact payload
   * until the user confirms. Nothing here has happened yet.
   */
  /** hunk id → plain-language annotation, filled progressively. */
  narrations: Record<string, Narration>;
  narrateStatus: 'idle' | 'running' | 'done' | 'failed';
  narrateActivity: string;
  /** Which conventions files the annotations were judged against. */
  narrateConventions: string | null;
  /**
   * Annotation runs its own model and effort, separate from the review's.
   * They are different jobs with different economics — one process per file
   * against one fanned-out run — and sharing one control made the cheaper of
   * the two inherit whatever the expensive one was last set to.
   */
  narrateModel: string;
  narrateEffort: string;
  /** Files whose annotation shard failed. Silent failure here reads as "nothing to say". */
  narrateFailed: string[];
  /**
   * Files being annotated right now. An empty margin means one of two opposite
   * things — not reached yet, or nothing worth saying — and only this tells
   * them apart while a run is in flight.
   */
  narrateInFlight: string[];
  /** So a run can be stopped. Annotation spawns one process per file. */
  narrateJobId: string | null;
  noteFilter: NoteFilter;
  /** Routine notes the reviewer has opened by hand. */
  expandedNotes: Record<string, true>;

  pendingComment: CommentPreview | null;
  pendingFix: { findingId: string; label: string } | null;
  writeBusy: boolean;
  writeResult: string | null;
  fixResult: FixResult | null;

  load: (data: SnapshotResponse) => void;
  setUnitState: (id: string, state: UnitState) => void;
  focus: (id: string | null) => void;
  moveFocus: (ordered: ReviewUnit[], delta: number) => void;
  nextUnreviewed: (ordered: ReviewUnit[]) => void;
  markAll: (ordered: ReviewUnit[], state: UnitState) => void;
  toggleNoise: () => void;
  toggleTheme: () => void;
  setGrouping: (g: Grouping) => void;
  toggleBrief: () => void;
  setPalette: (open: boolean) => void;
  setKeys: (open: boolean) => void;
  setLedger: (open: boolean) => void;
  toggleFindingSelection: (id: string) => void;
  setFindingSelection: (ids: string[]) => void;
  nextFinding: () => void;
  runMap: () => Promise<void>;
  cancelMap: () => Promise<void>;
  openCard: (id: string | null) => void;
  runReview: () => Promise<void>;
  cancelReview: () => Promise<void>;
  setEffort: (e: string) => void;
  setModel: (m: string) => void;
  setDisposition: (findingId: string, d: Disposition) => void;
  openFinding: (id: string | null) => void;
  loadProvenance: () => Promise<void>;
  toggleProvenance: (file: string | null) => void;
  dismissResume: () => void;
  runNarrate: (order?: string[]) => Promise<void>;
  cancelNarrate: () => Promise<void>;
  setNoteFilter: (f: NoteFilter) => void;
  setNarrateModel: (m: string) => void;
  setNarrateEffort: (e: string) => void;
  toggleNote: (hunkId: string) => void;
  prepareComments: (findingIds: string[]) => Promise<void>;
  confirmComments: () => Promise<void>;
  prepareFix: (findingId: string) => void;
  confirmFix: () => Promise<void>;
  cancelWrite: () => void;
  clearWriteResult: () => void;
}

export const useReview = create<ReviewStore>((set, get) => ({
  data: null,
  unitStates: {},
  focusedUnitId: null,
  showNoise: false,
  theme: 'dark',
  grouping: 'change',
  groupingPinned: false,
  briefCollapsed: false,
  paletteOpen: false,
  keysOpen: false,
  ledgerOpen: false,
  selectedFindings: {},
  map: null,
  mapStatus: 'idle',
  mapActivity: '',
  mapError: null,
  mapJobId: null,
  openCardId: null,
  findings: [],
  reviewStatus: 'idle',
  reviewActivity: '',
  reviewError: null,
  reviewJobId: null,
  reviewMeta: null,
  recipe: null,
  effort: 'high',
  model: 'sonnet',
  dispositions: {},
  openFindingId: null,
  provenance: {},
  openProvenanceFile: null,
  resume: null,
  resumeDismissed: false,
  narrations: {},
  narrateStatus: 'idle',
  narrateActivity: '',
  narrateConventions: null,
  narrateModel: 'sonnet',
  narrateEffort: 'high',
  narrateFailed: [],
  narrateInFlight: [],
  narrateJobId: null,
  noteFilter: 'notable',
  expandedNotes: {},
  pendingComment: null,
  pendingFix: null,
  writeBusy: false,
  writeResult: null,
  fixResult: null,

  load: (data) =>
    set({
      data,
      // Review state comes back from the database, not from zero: work already
      // signed off on stays signed off after an agent pushes.
      unitStates: data.states ?? {},
      resume: data.resume ?? null,
      resumeDismissed: false,
      focusedUnitId: null,
      map: null,
      mapStatus: 'idle',
      mapActivity: '',
      mapError: null,
      mapJobId: null,
      openCardId: null,
      findings: [],
      reviewStatus: 'idle',
      reviewActivity: '',
      reviewError: null,
      reviewJobId: null,
      reviewMeta: null,
      dispositions: {},
      openFindingId: null,
      provenance: {},
      openProvenanceFile: null,
      narrations: {},
      narrateStatus: 'idle',
      narrateActivity: '',
      narrateConventions: null,
      narrateInFlight: [],
      narrateJobId: null,
      expandedNotes: {},
      grouping: 'change',
      groupingPinned: false,
      briefCollapsed: false,
      paletteOpen: false,
      keysOpen: false,
      ledgerOpen: false,
      selectedFindings: {},
    }),

  dismissResume: () => set({ resumeDismissed: true }),

  runNarrate: async (order) => {
    const { data, map, narrateStatus } = get();
    if (!data || narrateStatus === 'running') return;
    set({
      narrateStatus: 'running',
      narrateActivity: 'Starting…',
      narrateFailed: [],
      narrateInFlight: [],
      narrateJobId: null,
    });
    // Card titles give each shard the purpose its file serves, which is what
    // turns "adds a null check" into an explanation worth reading.
    const cards = map?.map.cards.map((c) => ({
      title: c.title,
      files: [...new Set(c.hunkIds.map((h) => h.split('#')[0]))],
    }));
    try {
      const { jobId } = await api.startNarrate(data.snapshot.id, {
        model: get().narrateModel,
        effort: get().narrateEffort,
        cards,
        order,
      });
      set({ narrateJobId: jobId });
      streamJob(jobId, (e) => {
        if (e.kind === 'progress') {
          // Merge: the two kinds of progress carry different fields, and
          // overwriting the absent one blanks the activity line every time a
          // shard starts.
          const d = e.data as { activity?: string; inFlight?: string[] };
          set((s) => ({
            narrateActivity: d.activity ?? s.narrateActivity,
            narrateInFlight: d.inFlight ?? s.narrateInFlight,
          }));
        } else if (e.kind === 'partial') {
          const d = e.data as { narrations: Narration[]; inFlight?: string[] };
          set((s) => {
            const next = { ...s.narrations };
            for (const n of d.narrations) next[n.hunkId] = n;
            return { narrations: next, narrateInFlight: d.inFlight ?? s.narrateInFlight };
          });
        } else if (e.kind === 'result') {
          const r = e.data as { conventions?: string; failed?: string[] };
          set({
            narrateStatus: 'done',
            narrateActivity: '',
            narrateConventions: r.conventions ?? null,
            narrateFailed: r.failed ?? [],
            narrateInFlight: [],
            narrateJobId: null,
          });
        } else if (e.kind === 'error') {
          set({
            narrateStatus: 'failed', narrateActivity: '',
            narrateInFlight: [], narrateJobId: null,
          });
        }
      });
    } catch {
      set({
        narrateStatus: 'failed', narrateActivity: '',
        narrateInFlight: [], narrateJobId: null,
      });
    }
  },

  setNoteFilter: (f) => set({ noteFilter: f }),
  setNarrateModel: (m) => set({ narrateModel: m }),
  setNarrateEffort: (e) => set({ narrateEffort: e }),
  toggleNote: (hunkId) =>
    set((s) => {
      const next = { ...s.expandedNotes };
      if (next[hunkId]) delete next[hunkId];
      else next[hunkId] = true;
      return { expandedNotes: next };
    }),

  prepareComments: async (findingIds) => {
    const data = get().data;
    if (!data) return;
    set({ writeBusy: true, writeResult: null });
    try {
      const preview = await api.previewComments(data.snapshot.id, findingIds);
      set({ pendingComment: preview });
    } catch (err) {
      set({ writeResult: (err as Error).message });
    } finally {
      set({ writeBusy: false });
    }
  },

  confirmComments: async () => {
    const { data, pendingComment } = get();
    if (!data || !pendingComment) return;
    set({ writeBusy: true });
    try {
      // Post exactly the payload that was shown, never a rebuilt one.
      const res = await api.postComments(data.snapshot.id, pendingComment);
      set({
        pendingComment: null,
        writeResult:
          res.failed.length > 0
            ? `Posted ${res.posted}, ${res.failed.length} failed: ${res.failed[0].error}`
            : `Posted ${res.posted} comment${res.posted === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      set({ writeResult: (err as Error).message, pendingComment: null });
    } finally {
      set({ writeBusy: false });
    }
  },

  prepareFix: (findingId) => {
    const f = get().findings.find((x) => x.id === findingId);
    if (f) set({ pendingFix: { findingId, label: f.shortSummary ?? f.summary } });
  },

  confirmFix: async () => {
    const { data, pendingFix } = get();
    if (!data || !pendingFix) return;
    set({ writeBusy: true, fixResult: null });
    try {
      const { jobId } = await api.startFix(data.snapshot.id, pendingFix.findingId);
      set({ pendingFix: null });
      streamJob(jobId, (e) => {
        if (e.kind === 'progress') {
          set({ writeResult: (e.data as { activity?: string }).activity ?? '' });
        } else if (e.kind === 'result') {
          const r = e.data as FixResult;
          set({
            fixResult: r,
            writeBusy: false,
            writeResult:
              r.changedFiles.length === 0
                ? 'No change made — see the explanation.'
                : `Changed ${r.changedFiles.length} file(s). Review the diff before keeping it.`,
          });
        } else if (e.kind === 'error') {
          set({ writeBusy: false, writeResult: (e.data as { error?: string }).error ?? 'The fix did not complete.' });
        }
      });
    } catch (err) {
      set({ writeBusy: false, writeResult: (err as Error).message, pendingFix: null });
    }
  },

  cancelWrite: () => set({ pendingComment: null, pendingFix: null, writeBusy: false }),
  clearWriteResult: () => set({ writeResult: null, fixResult: null }),

  setUnitState: (id, state) => {
    set((s) => ({ unitStates: { ...s.unitStates, [id]: state } }));
    // Persist optimistically: a lost write costs one re-check, whereas
    // awaiting the round trip would stutter the keyboard flow.
    const snapshotId = get().data?.snapshot.id;
    if (snapshotId) void api.setUnitState(snapshotId, id, state).catch(() => undefined);
  },

  focus: (id) => set({ focusedUnitId: id }),

  /**
   * Focus movement needs the same ordering the UI renders, so the ordered list
   * is passed in by the caller rather than recomputed here — keeping one
   * definition of review order, in derive.ts.
   */
  moveFocus: (ordered, delta) => {
    if (ordered.length === 0) return;
    const cur = get().focusedUnitId;
    const idx = cur ? ordered.findIndex((u) => u.id === cur) : -1;
    const next = idx === -1 ? 0 : Math.max(0, Math.min(ordered.length - 1, idx + delta));
    set({ focusedUnitId: ordered[next].id });
  },

  nextUnreviewed: (ordered) => {
    if (ordered.length === 0) return;
    const states = get().unitStates;
    const cur = get().focusedUnitId;
    const from = cur ? ordered.findIndex((u) => u.id === cur) + 1 : 0;
    const search = [...ordered.slice(from), ...ordered.slice(0, from)];
    const target = search.find((u) => (states[u.id] ?? 'unreviewed') === 'unreviewed');
    set({ focusedUnitId: target ? target.id : get().focusedUnitId });
  },

  markAll: (ordered, state) =>
    set((s) => {
      const next = { ...s.unitStates };
      for (const u of ordered) next[u.id] = state;
      return { unitStates: next };
    }),

  toggleNoise: () => set((s) => ({ showNoise: !s.showNoise })),

  setGrouping: (g) => set({ grouping: g, groupingPinned: true }),
  toggleBrief: () => set((s) => ({ briefCollapsed: !s.briefCollapsed })),
  setPalette: (open) => set({ paletteOpen: open }),
  setKeys: (open) => set({ keysOpen: open }),
  setLedger: (open) => set({ ledgerOpen: open }),

  toggleFindingSelection: (id) =>
    set((s) => {
      const next = { ...s.selectedFindings };
      if (next[id]) delete next[id];
      else next[id] = true;
      return { selectedFindings: next };
    }),
  setFindingSelection: (ids) =>
    set({ selectedFindings: Object.fromEntries(ids.map((id) => [id, true as const])) }),

  /**
   * Walk to the next finding still awaiting a call.
   *
   * Wraps, so the key keeps working at the end of the list rather than going
   * dead. Opens the finding and focuses its unit, which is what scrolls the
   * margin note into view.
   */
  nextFinding: () => {
    const { findings, dispositions, openFindingId } = get();
    const open = findings.filter((f) => !dispositions[f.id]);
    if (open.length === 0) return;
    const at = open.findIndex((f) => f.id === openFindingId);
    const next = open[(at + 1) % open.length];
    set({ openFindingId: next.id });
    if (next.hunkId) set({ focusedUnitId: next.hunkId });
  },

  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'dark' ? 'paper' : 'dark';
      document.documentElement.dataset.theme = theme;
      return { theme };
    }),

  openCard: (id) => set((s) => ({ openCardId: s.openCardId === id ? null : id })),

  runMap: async () => {
    const data = get().data;
    if (!data || get().mapStatus === 'running') return;
    set({ mapStatus: 'running', mapActivity: 'Starting…', mapError: null, map: null });
    try {
      const { jobId } = await api.startMap(data.snapshot.id);
      set({ mapJobId: jobId });
      streamJob(jobId, (e) => {
        if (e.kind === 'progress') {
          set({ mapActivity: (e.data as { activity?: string }).activity ?? '' });
        } else if (e.kind === 'result') {
          const result = e.data as MapJobResult;
          // The cards are strictly better names for groups the app already
          // made, so the stream adopts them — unless the reviewer has picked a
          // grouping themselves, in which case their choice stands.
          const adopt = !get().groupingPinned && result.map.cards.length > 0;
          set({
            map: result,
            mapStatus: 'done',
            mapActivity: '',
            ...(adopt ? { grouping: 'card' as const } : {}),
          });
        } else if (e.kind === 'error') {
          // An incomplete map is reported as failed, never shown as a finished one.
          set({
            mapStatus: 'failed',
            mapError: (e.data as { error?: string }).error ?? 'The map job did not complete.',
            mapActivity: '',
          });
        }
      });
    } catch (err) {
      set({ mapStatus: 'failed', mapError: (err as Error).message, mapActivity: '' });
    }
  },

  loadProvenance: async () => {
    const data = get().data;
    if (!data) return;
    try {
      const res = await api.provenance(data.snapshot.id);
      set({ provenance: res.byFile });
    } catch {
      // Provenance is additive context; its absence must not break review.
    }
  },

  toggleProvenance: (file) =>
    set((s) => ({ openProvenanceFile: s.openProvenanceFile === file ? null : file })),

  setEffort: (effort) => set({ effort }),
  setModel: (model) => set({ model }),
  openFinding: (id) => set((s) => ({ openFindingId: s.openFindingId === id ? null : id })),
  setDisposition: (findingId, d) => {
    set((s) => ({ dispositions: { ...s.dispositions, [findingId]: d } }));
    const snapshotId = get().data?.snapshot.id;
    if (snapshotId) void api.setDisposition(snapshotId, findingId, d).catch(() => undefined);
  },

  runReview: async () => {
    const { data, effort, model, reviewStatus } = get();
    if (!data || reviewStatus === 'running') return;
    // Dispositions survive a re-review deliberately: findings are keyed by
    // file:line:rank, so a re-run over the same code re-raises the same ids and
    // the calls you already made still stand.
    set({ reviewStatus: 'running', reviewActivity: 'Starting…', reviewError: null, findings: [], selectedFindings: {} });
    try {
      const { jobId, recipe } = await api.startReview(data.snapshot.id, effort, model);
      set({ reviewJobId: jobId, recipe });
      streamJob(jobId, (e) => {
        if (e.kind === 'progress') {
          set({ reviewActivity: (e.data as { activity?: string }).activity ?? '' });
        } else if (e.kind === 'partial') {
          // Findings render as they are reported, rather than after the run.
          set({ findings: (e.data as { findings: Finding[] }).findings });
        } else if (e.kind === 'result') {
          const r = e.data as ReviewJobResult;
          set({ findings: r.findings, reviewMeta: r, reviewStatus: 'done', reviewActivity: '' });
        } else if (e.kind === 'error') {
          // A review that reported nothing is incomplete, never "clean" — and
          // the server puts *why* on `incomplete` while sending the partial
          // result as the payload, so reading only `error` throws away the one
          // thing that says what went wrong.
          const d = e.data as Partial<ReviewJobResult> & { error?: string };
          set({
            reviewStatus: 'failed',
            reviewError: d.incomplete ?? d.error ?? 'The review did not complete.',
            reviewActivity: '',
            // Whatever it did find, and what it cost, still stand.
            ...(d.findings ? { findings: d.findings } : {}),
            ...(d.recipe ? { reviewMeta: d as ReviewJobResult } : {}),
          });
        }
      });
    } catch (err) {
      set({ reviewStatus: 'failed', reviewError: (err as Error).message, reviewActivity: '' });
    }
  },

  cancelReview: async () => {
    const id = get().reviewJobId;
    if (id) await api.cancelJob(id).catch(() => undefined);
    set({ reviewStatus: 'idle', reviewActivity: '', reviewJobId: null });
  },

  // Annotations already in hand are kept: each shard is an independent result,
  // and stopping the run is not a reason to discard the ones that landed.
  cancelNarrate: async () => {
    const id = get().narrateJobId;
    if (!id) return;
    try {
      await api.cancelJob(id);
    } catch (e) {
      // Do not pretend. A failed cancel leaves one `claude` process per file
      // still running and still spending; resetting the UI here would show a
      // stopped run that is not stopped.
      set({ narrateActivity: `Could not stop the run — ${(e as Error).message}` });
      return;
    }
    set({
      narrateStatus: 'idle', narrateActivity: '',
      narrateInFlight: [], narrateJobId: null,
    });
  },

  cancelMap: async () => {
    const id = get().mapJobId;
    if (id) await api.cancelJob(id).catch(() => undefined);
    set({ mapStatus: 'idle', mapActivity: '', mapJobId: null });
  },
}));
