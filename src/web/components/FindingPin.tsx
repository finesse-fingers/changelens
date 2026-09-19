import { useReview } from '../store/review.js';
import type { Disposition, Finding } from '../store/api.js';

/**
 * Outward actions live behind their own gate: triaging a finding does not
 * authorise editing files, and editing files does not authorise posting.
 */
function ActionButtons({ findingId }: { findingId: string }) {
  const isPr = useReview((s) => s.data?.snapshot.kind === 'pr');
  const prepareFix = useReview((s) => s.prepareFix);
  const prepareComments = useReview((s) => s.prepareComments);
  const busy = useReview((s) => s.writeBusy);

  return (
    <>
      <button
        onClick={() => prepareFix(findingId)}
        disabled={busy}
        className="rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40"
        style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}
        title="Ask Claude to apply this one finding to your working tree, after confirmation"
      >
        Apply fix…
      </button>
      <button
        onClick={() => prepareComments([findingId])}
        disabled={busy || !isPr}
        className="rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40"
        style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}
        title={isPr ? 'Post this as an inline PR comment, after confirmation' : 'Only available for a pull request target'}
      >
        Post to PR…
      </button>
      <span className="muted text-[10px]">confirmation required</span>
    </>
  );
}

const DISPOSITIONS: { key: Disposition; label: string; hint: string }[] = [
  { key: 'fix', label: 'Fix', hint: 'Valid, in scope, needs a change' },
  { key: 'reply-only', label: 'Reply', hint: 'Clarification is enough' },
  { key: 'already-addressed', label: 'Done', hint: 'Current code already satisfies it' },
  { key: 'reject', label: 'Reject', hint: 'False or unsupported — record why' },
  { key: 'defer', label: 'Defer', hint: 'Valid but out of scope for this change' },
  { key: 'blocked', label: 'Blocked', hint: 'Needs input or external state' },
];

/**
 * A finding, in the margin beside the change it concerns.
 *
 * The ordinal is shown because rank *is* severity — `ReportFindings` has no
 * severity field and reports most-severe first, so position is the only signal
 * and inventing a severity label would be fabricating data.
 */
export function FindingPin({ finding }: { finding: Finding }) {
  const open = useReview((s) => s.openFindingId === finding.id);
  const openFinding = useReview((s) => s.openFinding);
  const disposition = useReview((s) => s.dispositions[finding.id]);
  const setDisposition = useReview((s) => s.setDisposition);

  return (
    <div
      className="mb-2 rounded-md border text-[12px] leading-snug"
      style={{
        borderColor: disposition ? 'var(--line)' : 'var(--amber)',
        background: 'var(--panel)',
        opacity: disposition ? 0.6 : 1,
      }}
    >
      <button
        onClick={() => openFinding(finding.id)}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        <span
          className="mono mt-[1px] shrink-0 rounded px-1 text-[10px]"
          style={{ background: 'var(--raised)', color: 'var(--amber)' }}
          title="Rank — findings are reported most-severe first"
        >
          #{finding.rank + 1}
        </span>
        <span className="min-w-0 flex-1">
          {finding.shortSummary ?? finding.summary}
          <span className="mt-1 flex flex-wrap gap-2">
            {finding.verdict && (
              <span
                className="text-[9px] uppercase tracking-wide"
                style={{ color: finding.verdict === 'CONFIRMED' ? 'var(--rose)' : 'var(--muted)' }}
                title={
                  finding.verdict === 'CONFIRMED'
                    ? 'Survived an adversarial verify pass'
                    : 'Plausible but not confirmed'
                }
              >
                {finding.verdict}
              </span>
            )}
            {disposition && (
              <span className="muted text-[9px] uppercase tracking-wide">{disposition}</span>
            )}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t px-2.5 py-2 leading-relaxed" style={{ borderColor: 'var(--line)' }}>
          <p className="mb-2">{finding.summary}</p>
          <p className="note-label">How it fails</p>
          <p className="mb-3">{finding.failureScenario}</p>

          <p className="note-label">Your call — a hypothesis, not an instruction</p>
          <div className="flex flex-wrap gap-1">
            {DISPOSITIONS.map((d) => (
              <button
                key={d.key}
                onClick={() => setDisposition(finding.id, d.key)}
                title={d.hint}
                className="rounded border px-1.5 py-0.5 text-[10px]"
                style={{
                  borderColor: disposition === d.key ? 'var(--accent)' : 'var(--line)',
                  color: disposition === d.key ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
            <ActionButtons findingId={finding.id} />
          </div>

          {finding.category && (
            <p className="muted mt-2 text-[10px]">
              {finding.category}
              {finding.line !== undefined && ` · ${finding.file}:${finding.line}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
