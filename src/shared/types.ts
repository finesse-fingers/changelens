/**
 * Core domain model, shared by server and web.
 *
 * Vocabulary is deliberately lifted from the `change-map`, `explain-changes`
 * and `address-pr-feedback` review workflows, so the app and the artifacts
 * those produce describe the same world.
 */

// ---------------------------------------------------------------------------
// Snapshot identity — what exactly is under review
// ---------------------------------------------------------------------------

export type TargetKind = 'local' | 'pr';

/** What the user asked to review, before resolution. */
export interface TargetSpec {
  kind: TargetKind;
  repoRoot: string;
  /** PR number, when kind === 'pr'. */
  prNumber?: number;
  /** Explicit base ref for local targets; otherwise merge-base is resolved. */
  baseRef?: string;
  /** Local targets only. Untracked files are included when `untracked` is set. */
  includeStaged?: boolean;
  includeUnstaged?: boolean;
  includeUntracked?: boolean;
  /** Compare working tree against HEAD only ("only uncommitted"). */
  uncommittedOnly?: boolean;
}

/**
 * The resolved evidence snapshot. Every review is keyed to one of these.
 *
 * `dirtyDigest` is a content digest over staged/unstaged/untracked material, so
 * a working tree that changes under us produces a different identity rather
 * than silently invalidating a review.
 */
export interface Snapshot {
  id: string;
  repoRoot: string;
  /** Git common dir, so worktrees of one repo collapse to one identity. */
  repoKey: string;
  kind: TargetKind;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string;
  prIsDraft?: boolean;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  /** null when the tree is clean. */
  dirtyDigest: string | null;
  inspectedAt: string;
  /** How base was determined — surfaced in the UI so the comparison is auditable. */
  baseResolution: 'merge-base' | 'pr-merge-base' | 'pr-base-oid' | 'explicit' | 'head';
  stats: { files: number; additions: number; deletions: number };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

/** Origin of a change, so uncommitted work is visually distinct from commits. */
export type ChangeOrigin = 'commit' | 'staged' | 'unstaged' | 'untracked';

export type NoiseReason =
  | 'lockfile'
  | 'generated'
  | 'vendored'
  | 'pure-rename'
  | 'whitespace-only'
  | 'binary'
  | 'oversized'
  | 'snapshot-fixture';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface Hunk {
  /** Stable within a snapshot: `${filePath}@${index}`. */
  id: string;
  filePath: string;
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after `@@ ... @@`, usually the enclosing function. */
  section: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  /**
   * Content hash over normalized added/removed text — the resumption anchor.
   * Deliberately excludes line numbers so it survives edits elsewhere in the file.
   */
  contentHash: string;
}

/** How much of a file reaches the reviewer and the model. */
export type NoiseTier = 'normal' | 'digest' | 'excluded';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  origin: ChangeOrigin;
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** Non-null when deterministically classified as noise (pre-LLM). */
  noise: NoiseReason | null;
  /** Derived from `noise`; drives whether hunks are shown, digested or hidden. */
  tier: NoiseTier;
  /** Rename/copy similarity score from `git diff -M`, 0-100. */
  similarity?: number;
  hunks: Hunk[];
  language?: string;
}

export interface DiffSet {
  snapshotId: string;
  files: ChangedFile[];
  /** Files elided because the diff was too large to render in full. */
  truncated: { path: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// change-map model (extended with hunk anchors)
// ---------------------------------------------------------------------------

export type CardScope = 'Requested' | 'Supporting' | 'Extra';
export type CardState = 'Planned' | 'Changed' | 'Verified' | 'Blocked';
export type RiskTier = 'high' | 'medium' | 'low';

export interface ChangeCard {
  id: string;
  title: string;
  /** One-line consequence, not a file inventory. */
  summary: string;
  scope: CardScope;
  state: CardState;
  risk: RiskTier;
  why?: string;
  alternative?: string;
  tradeoff?: string;
  evidence?: string;
  /** Hunk ids this card claims. Every non-noise hunk lands in exactly one card. */
  hunkIds: string[];
  /** Position in the guided review path; lower is reviewed earlier. */
  order: number;
}

export type AssessmentVerdict = 'Good' | 'Mixed' | 'Concern' | 'Unknown';

export interface Assessment {
  scope: { verdict: AssessmentVerdict; reason: string };
  codebase: { verdict: AssessmentVerdict; reason: string };
  maintenance: { verdict: AssessmentVerdict; reason: string };
}

export interface AttentionItem {
  level: 'info' | 'warning' | 'critical';
  text: string;
}

/** The `explain-changes` four-section brief. */
export interface Brief {
  whatChanged: string;
  whyThisApproach: string;
  assessment: Assessment;
  evidenceAndCaveats: string;
}

export interface ChangeMap {
  title: string;
  goal: string;
  brief: Brief;
  cards: ChangeCard[];
  attention: AttentionItem[];
  /** Hunks the model failed to assign; surfaced rather than dropped. */
  unsortedHunkIds: string[];
}

// ---------------------------------------------------------------------------
// Narration — the natural-language overlay
// ---------------------------------------------------------------------------

export type NarrationAxis = 'conventions' | 'clarity' | 'design';
export type AxisRating = 'strong' | 'ok' | 'weak';
export type Significance = 'major' | 'minor' | 'routine';

export interface NarrationAxisNote {
  axis: NarrationAxis;
  rating: AxisRating;
  reason: string;
  /** conventions only: the rule, quoted from the file it lives in. */
  rule?: string;
  /** conventions only: repo-relative path of the file that rule came from. */
  source?: string;
}

export interface Narration {
  hunkId: string;
  /** What this hunk does, in plain language. */
  what: string;
  /**
   * How much attention this deserves.
   *
   * The margin is only useful if most of it can recede. A diff is mostly
   * renames and imports; annotating those as prominently as a behaviour change
   * is what makes the whole overlay ignorable.
   */
  significance: Significance;
  /** Overall quality, 1-5. */
  score: number;
  /** Only axes with something real to say. An axis with no judgement is absent. */
  axes?: NarrationAxisNote[];
  /** Why it exists / what it is in service of. */
  why?: string;
  /** What a reviewer should scrutinise here. Absent when there is nothing. */
  watchFor?: string;
}

// ---------------------------------------------------------------------------
// Findings — mirrors the binary's ReportFindings schema exactly.
// NOTE: there is no severity field. Rank order IS severity.
// ---------------------------------------------------------------------------

export type FindingVerdict = 'CONFIRMED' | 'PLAUSIBLE';
export type FindingOutcome = 'fixed' | 'skipped' | 'no_change_needed';

export interface Finding {
  id: string;
  /** 0-based position as reported. This is the severity signal. */
  rank: number;
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  category?: string;
  verdict?: FindingVerdict;
  outcome?: FindingOutcome;
  /** Which run produced it, so multiple lenses can coexist. */
  source: FindingSource;
  /** Resolved hunk id when the anchor falls inside the diff. */
  hunkId?: string;
  /** Context hash at the anchor, for staleness detection after a head move. */
  anchorHash?: string;
  stale?: boolean;
}

export type FindingSource =
  | 'code-review'
  | 'silent-failure-hunter'
  | 'type-design-analyzer'
  | 'pr-test-analyzer'
  | 'comment-analyzer';

// ---------------------------------------------------------------------------
// Ledger — address-pr-feedback dispositions
// ---------------------------------------------------------------------------

export type Disposition =
  | 'fix'
  | 'reply-only'
  | 'already-addressed'
  | 'reject'
  | 'defer'
  | 'blocked'
  | 'administrative';

export interface LedgerEntry {
  findingId: string;
  disposition: Disposition | null;
  note?: string;
  decidedAt?: string;
}

// ---------------------------------------------------------------------------
// Review progress
// ---------------------------------------------------------------------------

export type UnitState = 'unreviewed' | 'reviewed' | 'flagged' | 'skimmed';

export interface UnitProgress {
  hunkId: string;
  contentHash: string;
  state: UnitState;
  updatedAt: string;
  /** Set when the hunk changed after being reviewed in an earlier snapshot. */
  changedSinceReview?: boolean;
}

/** What the UI shows after a head move. */
export interface ResumeReport {
  newCommits: number;
  unitsChanged: number;
  unitsCarried: number;
  findingsPossiblyStale: number;
  baseMoved: boolean;
  forcePushed: boolean;
}

// ---------------------------------------------------------------------------
// Authority gates — never inferred from one another
// ---------------------------------------------------------------------------

export type AuthorityMode = 'inspect' | 'fix' | 'publish';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type AgentKind = 'claude' | 'codex';

export interface ProvenanceEntry {
  filePath: string;
  agent: AgentKind;
  sessionId: string;
  /** Human-readable session/thread name where one exists. */
  threadName?: string;
  /** The user prompt nearest-preceding the edit. */
  prompt?: string;
  cwd: string;
  gitBranch?: string;
  timestamp: string;
}
