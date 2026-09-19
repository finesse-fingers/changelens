import { useEffect, useMemo, useState } from 'react';
import { useReview } from '../store/review.js';
import type { Disposition, Finding } from '../store/api.js';
import { renderLedger } from '../../shared/ledger.js';

/**
 * Every finding in one place.
 *
 * Findings pinned in the margin are right for reading a diff and wrong for
 * working through a list: on a 60-unit PR they are scattered across two dozen
 * files, and the only way to see the fifteenth is to scroll to it. This is the
 * other half — the triage ledger from `address-pr-feedback`, made interactive.
 *
 * It is an overlay rather than a panel because triage is a distinct mode, not
 * something to keep open while reading code.
 */

const DISPOSITIONS: { key: Disposition; label: string; hint: string; color: string }[] = [
  { key: 'fix', label: 'Fix', hint: 'Valid, in scope, needs a change', color: 'var(--rose)' },
  { key: 'reply-only', label: 'Reply', hint: 'Clarification is enough', color: 'var(--muted)' },
  { key: 'already-addressed', label: 'Done', hint: 'Current code already satisfies it', color: 'var(--add-gutter)' },
  { key: 'reject', label: 'Reject', hint: 'False or unsupported — record why', color: 'var(--muted)' },
  { key: 'defer', label: 'Defer', hint: 'Valid but out of scope for this change', color: 'var(--violet)' },
  { key: 'blocked', label: 'Blocked', hint: 'Needs input or external state', color: 'var(--amber)' },
];

type Lens = 'all' | 'untriaged' | Disposition;

export function LedgerOverlay() {
  const open = useReview((s) => s.ledgerOpen);
  const setLedger = useReview((s) => s.setLedger);
  const findings = useReview((s) => s.findings);
  const dispositions = useReview((s) => s.dispositions);
  const setDisposition = useReview((s) => s.setDisposition);
  const selected = useReview((s) => s.selectedFindings);
  const toggleSelection = useReview((s) => s.toggleFindingSelection);
  const setSelection = useReview((s) => s.setFindingSelection);
  const focus = useReview((s) => s.focus);
  const openFinding = useReview((s) => s.openFinding);
  const prepareComments = useReview((s) => s.prepareComments);
  const prepareFix = useReview((s) => s.prepareFix);
  const busy = useReview((s) => s.writeBusy);
  const snap = useReview((s) => s.data?.snapshot);
  const meta = useReview((s) => s.reviewMeta);
  const [lens, setLens] = useState<Lens>('all');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  const rows = useMemo(() => {
    // Never re-sorted. Rank IS severity — `ReportFindings` has no severity
    // field and reports most-severe first, so any other order invents one.
    if (lens === 'all') return findings;
    if (lens === 'untriaged') return findings.filter((f) => !dispositions[f.id]);
    return findings.filter((f) => dispositions[f.id] === lens);
  }, [findings, dispositions, lens]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { untriaged: 0 };
    for (const f of findings) {
      const d = dispositions[f.id];
      if (!d) out.untriaged++;
      else out[d] = (out[d] ?? 0) + 1;
    }
    return out;
  }, [findings, dispositions]);

  const selectedIds = useMemo(
    () => findings.filter((f) => selected[f.id]).map((f) => f.id),
    [findings, selected],
  );

  if (!open) return null;

  const isPr = snap?.kind === 'pr';
  const decided = findings.length - counts.untriaged;

  const exportMarkdown = async () => {
    const md = renderLedger(findings, dispositions, snap, meta);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; a download always works.
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'review-ledger.md';
      a.click();
      URL.revokeObjectURL(url);
      setCopied(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh]"
      style={{ background: 'color-mix(in srgb, var(--paper) 78%, transparent)' }}
      onClick={() => setLedger(false)}
    >
      <div
        className="flex max-h-[86vh] w-[1180px] max-w-[94vw] flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5"
          style={{ borderColor: 'var(--line)' }}
        >
          <h2 className="text-[13px] font-semibold tracking-tight">Findings ledger</h2>
          <span className="mono muted text-[11px]">{decided}/{findings.length} triaged</span>

          <div className="flex flex-wrap items-center gap-0.5 rounded p-0.5" style={{ background: 'var(--raised)' }}>
            <LensTab lens="all" active={lens} onPick={setLens} count={findings.length} />
            <LensTab lens="untriaged" active={lens} onPick={setLens} count={counts.untriaged} />
            {DISPOSITIONS.map((d) => (
              <LensTab key={d.key} lens={d.key} active={lens} onPick={setLens} count={counts[d.key] ?? 0} label={d.label} />
            ))}
          </div>

          <div className="flex-1" />

          <button
            onClick={() => setSelection(selectedIds.length === rows.length ? [] : rows.map((f) => f.id))}
            className="muted text-[11px] underline-offset-2 hover:underline"
          >
            {selectedIds.length === rows.length && rows.length > 0 ? 'clear selection' : 'select all shown'}
          </button>
          <button
            onClick={() => prepareComments(selectedIds)}
            disabled={busy || !isPr || selectedIds.length === 0}
            className="rounded border px-2 py-1 text-[11px] disabled:opacity-35"
            style={{ borderColor: 'var(--line)' }}
            title={isPr ? 'Post the selected findings as inline PR comments, after confirmation' : 'Only available for a pull request target'}
          >
            Post{selectedIds.length ? ` ${selectedIds.length}` : ''} to PR…
          </button>
          <button
            onClick={exportMarkdown}
            className="rounded border px-2 py-1 text-[11px]"
            style={{ borderColor: 'var(--line)' }}
            title="Copy the triage table as markdown for a handoff"
          >
            {copied ? 'copied ✓' : 'Export markdown'}
          </button>
          <button onClick={() => setLedger(false)} className="kbd">esc</button>
        </header>

        {meta && !meta.recipe.verifies && (
          <p className="shrink-0 border-b px-4 py-1.5 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--amber)' }}>
            This recipe ran no verify pass — every row below is an unchecked hypothesis, and
            nothing was dropped as refuted.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 && (
            <p className="muted px-4 py-6 text-center text-[12px]">
              {findings.length === 0 ? 'No findings yet — run a review.' : 'Nothing in this bucket.'}
            </p>
          )}
          {rows.map((f) => {
            const d = dispositions[f.id];
            const isOpen = expanded === f.id;
            return (
              <div key={f.id} className="border-b" style={{ borderColor: 'var(--line)' }}>
                <div className="flex items-start gap-2.5 px-4 py-2">
                  <input
                    type="checkbox"
                    checked={Boolean(selected[f.id])}
                    onChange={() => toggleSelection(f.id)}
                    className="mt-[3px] shrink-0"
                    aria-label="select for a batch action"
                  />
                  <span
                    className="mono mt-[1px] w-7 shrink-0 text-[10px]"
                    style={{ color: 'var(--amber)' }}
                    title="Rank — most severe first"
                  >
                    #{f.rank + 1}
                  </span>

                  <div className="min-w-0 flex-1">
                    <button onClick={() => setExpanded(isOpen ? null : f.id)} className="block w-full text-left text-[12px] leading-snug">
                      {f.shortSummary ?? f.summary}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => {
                          openFinding(f.id);
                          if (f.hunkId) focus(f.hunkId);
                          setLedger(false);
                        }}
                        className="mono muted truncate text-[10px] underline-offset-2 hover:underline"
                        title="Show this in the diff"
                      >
                        {f.file}{f.line !== undefined ? `:${f.line}` : ''}
                      </button>
                      {f.verdict && (
                        <span
                          className="text-[9px] uppercase tracking-wide"
                          style={{ color: f.verdict === 'CONFIRMED' ? 'var(--rose)' : 'var(--muted)' }}
                        >
                          {f.verdict}
                        </span>
                      )}
                      {f.category && <span className="muted text-[10px]">{f.category}</span>}
                    </div>

                    {isOpen && (
                      <div className="mt-2 max-w-[820px] text-[12px] leading-relaxed">
                        <p className="mb-2">{f.summary}</p>
                        <p className="note-label">How it fails</p>
                        <p className="mb-2">{f.failureScenario}</p>
                        <button
                          onClick={() => prepareFix(f.id)}
                          disabled={busy}
                          className="rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                          style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}
                        >
                          Apply fix…
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {DISPOSITIONS.map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setDisposition(f.id, opt.key)}
                        title={opt.hint}
                        className="rounded border px-1.5 py-0.5 text-[10px]"
                        style={{
                          borderColor: d === opt.key ? opt.color : 'var(--line)',
                          color: d === opt.key ? opt.color : 'var(--muted)',
                          background: d === opt.key ? 'var(--raised)' : 'transparent',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="shrink-0 border-t px-4 py-1.5" style={{ borderColor: 'var(--line)' }}>
          <p className="muted text-[10px] leading-relaxed">
            Ordered most severe first, never re-sorted — rank is the only severity signal the tool
            reports. Every finding is a hypothesis for you to accept or reject, not an instruction.
          </p>
        </footer>
      </div>
    </div>
  );
}

function LensTab({
  lens, active, onPick, count, label,
}: {
  lens: Lens;
  active: Lens;
  onPick: (l: Lens) => void;
  count: number;
  label?: string;
}) {
  return (
    <button
      onClick={() => onPick(lens)}
      className="rounded px-1.5 py-[2px] text-[10px]"
      style={{
        background: active === lens ? 'var(--panel)' : 'transparent',
        color: active === lens ? 'var(--accent)' : 'var(--muted)',
        opacity: count === 0 && lens !== 'all' ? 0.45 : 1,
      }}
    >
      {label ?? lens} {count}
    </button>
  );
}
