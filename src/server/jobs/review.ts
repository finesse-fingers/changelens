import { randomUUID } from 'node:crypto';
import type { Finding, Snapshot } from '../../shared/types.js';
import type { ReviewUnit } from '../git/units.js';
import { runClaude } from '../runner/claude.js';
import { isAssistant, isSuccess, toolUses, assistantText, type StreamEvent } from '../runner/events.js';
import { recipeFor, type Effort } from './recipes.js';
import { conventionsFor, describeChain } from './conventions.js';

export interface ReviewJobResult {
  findings: Finding[];
  level?: string;
  /** Set when the run silently collapsed to a single pass instead of fanning out. */
  degradedToSinglePass: boolean;
  capHit: boolean;
  incomplete: string | null;
  /** Set when the first turn ended silently and a resume recovered the report. */
  recovered: boolean;
  /** What the run was judged against, or why it was judged against nothing. */
  conventions: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  argv: string[];
}

interface RawFinding {
  file: string;
  line?: number;
  summary: string;
  short_summary?: string;
  failure_scenario: string;
  category?: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
  outcome?: 'fixed' | 'skipped' | 'no_change_needed';
}

/**
 * Ceiling for one review.
 *
 * $6 was too low, and the way it failed is the point: a fanned-out recipe that
 * hits the cap mid-analysis has spent the whole budget and reports nothing, so
 * the tight cap bought a guaranteed total loss rather than a smaller one.
 * Measured on a 5-file diff at sonnet/high: 3 angles cost $4.81, 7 angles hit
 * $6.13. The resume path below is the real protection; this is headroom so it
 * is rarely needed.
 */
const REVIEW_BUDGET_USD = Number(process.env.CHANGELENS_REVIEW_BUDGET_USD ?? 12);

/**
 * What the headless run needs to know that an interactive one does not.
 *
 * The fan-out recipes dispatch their angle agents with `run_in_background`,
 * then end the turn to wait for task notifications. Interactively that is
 * correct — the notification wakes the session back up. Under `--print` there
 * is no next turn: the process exits at end-of-turn, the angles finish into a
 * dead session, and the review reports nothing at all. Observed directly in
 * three runs: the two that dispatched in the background produced zero
 * findings, the one that ran its agents in the foreground produced five.
 *
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` handles this properly; this text is
 * the belt to its braces, and also the only way the review learns which
 * conventions files this repo actually uses.
 */
function reviewSystemPrompt(conventions: string): string {
  return [
    'You are running headless, in a single turn, with no user to answer and no',
    'follow-up turn. Nothing you defer will ever be picked up.',
    '',
    'Never dispatch a subagent in the background. Every agent you launch must run',
    'in the foreground so its result returns inside this turn.',
    '',
    'Before you end the turn you MUST call ReportFindings, even if some angles are',
    'incomplete or you found nothing. Ending the turn without calling it destroys',
    'the entire run — there is no later opportunity.',
    '',
    conventions === 'no conventions file found'
      ? 'This repository documents no conventions, so do not assert convention violations.'
      : `This repository's conventions live in: ${conventions}. Read them, and cite the ` +
        'specific rule whenever you claim something violates them.',
  ].join('\n');
}

/**
 * Run the built-in `/code-review` and capture its typed findings.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. `ReportFindings` is gated on `CLAUDE_CODE_REPORT_FINDINGS` *and* on the
 *    output format. Under `--output-format json` or `text` the CLI disables the
 *    typed tool and the review falls back to a prose contract that drops
 *    `category`, `short_summary` and `verdict`. stream-json is mandatory.
 *
 * 2. The tool allowlist deliberately includes `Task`. Every recipe carries a
 *    silent degradation path — "Agent tool unavailable → single-pass inline" —
 *    so locking the review down to read-only file tools would quietly collapse
 *    a ten-angle review into one pass and still report success.
 *
 * 3. Background dispatch must be suppressed, or the fan-out recipes end the
 *    turn while their angles are still running. See `reviewSystemPrompt`.
 */
export async function runReviewJob(
  snap: Snapshot,
  units: ReviewUnit[],
  opts: {
    effort: Effort;
    model?: string;
    target?: string;
    onEvent?: (e: StreamEvent) => void;
    onFindings?: (f: Finding[]) => void;
    signal?: AbortSignal;
  },
): Promise<ReviewJobResult> {
  const sessionId = randomUUID();
  const recipe = recipeFor(opts.model, opts.effort);

  // Always pass the level explicitly: it is sticky global state otherwise, and
  // an omitted level silently inherits whatever was last typed interactively.
  const target = opts.target ?? (snap.kind === 'pr' ? String(snap.prNumber) : '');
  const prompt = `/code-review ${opts.effort}${target ? ` ${target}` : ''}`;

  const conventions = describeChain(conventionsFor(snap.repoRoot));
  const systemPrompt = reviewSystemPrompt(conventions);

  let captured: Finding[] = [];
  let level: string | undefined;
  let degraded = false;

  const onEvent = (e: StreamEvent) => {
    opts.onEvent?.(e);
    if (!isAssistant(e)) return;

    // The review states plainly when it ran without the Agent tool.
    const text = assistantText(e);
    if (/single-pass review .*without the Agent tool|Agent tool (is )?not available/i.test(text)) {
      degraded = true;
    }

    for (const call of toolUses(e, 'ReportFindings')) {
      const input = call.input as { level?: string; findings?: RawFinding[] };
      level = input.level ?? level;
      const next = (input.findings ?? []).map((f, i) => normalize(f, i, units));
      // Keep the last report that actually said something. A verify pass can
      // report a second time, and letting an empty follow-up overwrite a good
      // first report would throw away the whole run.
      if (next.length === 0 && captured.length > 0) continue;
      captured = next;
      opts.onFindings?.(captured);
    }
  };

  const base = {
    cwd: snap.repoRoot,
    model: opts.model,
    effort: opts.effort,
    reportFindings: true,
    forwardSubagentText: true,
    permissionMode: 'plan' as const,
    // Task must stay: without it the fan-out collapses without failing.
    allowedTools: ['Task', 'Read', 'Grep', 'Glob', 'Bash'],
    addDirs: [snap.repoRoot],
    appendSystemPrompt: systemPrompt,
    // The single most important line in this file. See `reviewSystemPrompt`.
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    signal: opts.signal,
  };

  const run = await runClaude(
    { ...base, prompt, maxBudgetUsd: REVIEW_BUDGET_USD, timeoutMs: 25 * 60_000, sessionId },
    onEvent,
  );

  let recovered = false;
  let recoveryCost = 0;
  let recoveryMs = 0;
  let incomplete = run.incomplete;

  // A run that analysed the diff and then ended its turn without reporting has
  // done all the expensive work already. Re-entering the session to ask for the
  // report costs a fraction of re-running, and the alternative is discarding
  // ten minutes of paid analysis.
  const reportedNothing = () => captured.length === 0 && !sawReportFindings(run.events);
  // Budget and turn exhaustion are worth resuming for; a timeout or a cancel
  // are not. A run cut off at the cap has already paid for its analysis and is
  // holding all of it — asking for the report costs cents against the several
  // dollars already spent.
  const ranOutMidAnalysis =
    run.result !== null &&
    !isSuccess(run.result) &&
    (run.result.subtype === 'error_max_budget_usd' || run.result.subtype === 'error_max_turns');
  const worthResuming = (!run.incomplete || ranOutMidAnalysis) && !opts.signal?.aborted;

  if (worthResuming && reportedNothing()) {
    const retry = await runClaude(
      {
        ...base,
        prompt:
          'Your previous turn ended without calling ReportFindings, so nothing was ' +
          'recorded. Call ReportFindings now with everything you established, ' +
          'ranked most severe first. Report an empty list if you genuinely found ' +
          'nothing. Do not start new analysis and do not launch any agents.',
        resume: run.sessionId,
        maxBudgetUsd: 1.5,
        timeoutMs: 5 * 60_000,
      },
      onEvent,
    ).catch(() => null);
    if (retry) {
      recovered = captured.length > 0 || sawReportFindings(retry.events);
      recoveryCost = retry.costUsd;
      recoveryMs = retry.durationMs;
      // Once the findings are in hand, the cut-off is no longer the story: the
      // review produced its result, just not on the first turn.
      if (recovered && ranOutMidAnalysis) incomplete = null;
    }
  }

  // An empty findings array from a completed verify pass is a real result.
  // No result at all is not — that is INCOMPLETE, never "clean".
  if (!incomplete && !recovered && reportedNothing()) {
    incomplete =
      'The review finished without reporting findings, and resuming the session to ' +
      'ask for them did not recover it. Treat this as incomplete, not as a clean review.';
  }
  // Two diagnostics that were being computed and thrown away. A denied tool or
  // a dropped stream line produces exactly the symptom above, with no trace.
  if (run.permissionDenials.length > 0) {
    incomplete = [incomplete, `Tools denied during the run: ${run.permissionDenials.join(', ')}`]
      .filter(Boolean).join(' ');
  }

  return {
    findings: captured,
    level,
    degradedToSinglePass: degraded,
    capHit: captured.length >= recipe.cap,
    incomplete: incomplete || null,
    recovered,
    conventions,
    costUsd: run.costUsd + recoveryCost,
    durationMs: run.durationMs + recoveryMs,
    sessionId: run.sessionId,
    argv: run.argv,
  };
}

function sawReportFindings(events: StreamEvent[]): boolean {
  return events.some((e) => isAssistant(e) && toolUses(e, 'ReportFindings').length > 0);
}

/**
 * Anchor a raw finding to a review unit.
 *
 * `line` is optional in the tool's schema, and a finding can legitimately point
 * at unchanged code near the diff, so anything that does not land inside a unit
 * is pinned to its file rather than dropped.
 */
function normalize(f: RawFinding, rank: number, units: ReviewUnit[]): Finding {
  const inFile = units.filter((u) => u.filePath === f.file);
  let hunkId: string | undefined;

  if (f.line !== undefined) {
    const hit = inFile.find((u) => {
      if (u.newStart === null) return false;
      return f.line! >= u.newStart && f.line! < u.newStart + Math.max(u.newCount, 1);
    });
    // Fall back to the nearest unit in the same file, so a finding about code
    // just outside the changed lines still lands somewhere sensible.
    hunkId = (hit ?? nearest(inFile, f.line)) ?.id;
  }

  return {
    id: `${f.file}:${f.line ?? 0}:${rank}`,
    // Rank IS severity — the tool has no severity field and reports
    // most-severe first. Never re-sort this in the data layer.
    rank,
    file: f.file,
    line: f.line,
    summary: f.summary,
    shortSummary: f.short_summary,
    failureScenario: f.failure_scenario,
    category: f.category,
    verdict: f.verdict,
    outcome: f.outcome,
    source: 'code-review',
    hunkId,
  };
}

function nearest(units: ReviewUnit[], line: number): ReviewUnit | undefined {
  let best: ReviewUnit | undefined;
  let bestDist = Infinity;
  for (const u of units) {
    if (u.newStart === null) continue;
    const dist = Math.abs(u.newStart - line);
    if (dist < bestDist) {
      bestDist = dist;
      best = u;
    }
  }
  // Beyond a reasonable window the anchor is meaningless; pin to the file.
  return bestDist <= 40 ? best : undefined;
}
