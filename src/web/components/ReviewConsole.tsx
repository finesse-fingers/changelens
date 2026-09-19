import { useEffect } from 'react';
import { useReview } from '../store/review.js';
import { useOrderedUnits, useStreamSections } from '../store/derive.js';
import { DiffView } from './DiffView.js';
import { TopBar } from './TopBar.js';
import { BriefCard } from './BriefCard.js';
import { ReviewMetaBar } from './ReviewMetaBar.js';
import { NoiseStrip } from './NoiseStrip.js';
import { JumpPalette } from './JumpPalette.js';
import { KeysOverlay } from './KeysOverlay.js';
import { LedgerOverlay } from './LedgerOverlay.js';
import { WriteBackGate } from './WriteBackGate.js';

/**
 * What moved since this review was last open.
 *
 * The point is what it does NOT say: it never reports a reset. Work already
 * signed off on is carried, and only genuinely changed code comes back
 * unreviewed — which is the difference between a tool you can leave and come
 * back to and one you cannot.
 */
function ResumeBanner() {
  const resume = useReview((s) => s.resume);
  const dismissed = useReview((s) => s.resumeDismissed);
  const dismiss = useReview((s) => s.dismissResume);

  if (!resume || dismissed || resume.isNew) return null;
  const nothingMoved = resume.newUnits === 0 && resume.goneUnits === 0;
  // Carrying work forward is itself worth confirming: seeing "3 still
  // reviewed" is what tells you the tool did not quietly lose your progress.
  if (nothingMoved && !resume.baseMoved && resume.carriedReviewed === 0) return null;

  const parts: string[] = [];
  if (resume.baseMoved) parts.push('rebased onto new upstream commits');
  if (resume.newUnits) parts.push(`${resume.newUnits} new change${resume.newUnits === 1 ? '' : 's'}`);
  if (resume.goneUnits) parts.push(`${resume.goneUnits} gone`);
  if (resume.movedUnits) parts.push(`${resume.movedUnits} moved`);
  if (resume.carriedReviewed) parts.push(`${resume.carriedReviewed} still reviewed`);

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-[11px]"
      style={{ borderColor: 'var(--line)', background: 'var(--raised)' }}
    >
      <span style={{ color: 'var(--accent)' }}>Picked up where you left off</span>
      <span className="muted">{parts.join(' · ')}</span>
      {nothingMoved && <span className="muted">— nothing you reviewed changed</span>}
      <div className="flex-1" />
      <button onClick={dismiss} className="kbd">dismiss</button>
    </div>
  );
}

export function ReviewConsole({ onChangeTarget }: { onChangeTarget: () => void }) {
  const data = useReview((s) => s.data);
  const sections = useStreamSections();
  const units = useOrderedUnits();
  const moveFocus = useReview((s) => s.moveFocus);
  const nextUnreviewed = useReview((s) => s.nextUnreviewed);
  const nextFinding = useReview((s) => s.nextFinding);
  const setUnitState = useReview((s) => s.setUnitState);
  const focused = useReview((s) => s.focusedUnitId);
  const toggleTheme = useReview((s) => s.toggleTheme);
  const toggleBrief = useReview((s) => s.toggleBrief);
  const setPalette = useReview((s) => s.setPalette);
  const setKeys = useReview((s) => s.setKeys);
  const setLedger = useReview((s) => s.setLedger);
  const loadProvenance = useReview((s) => s.loadProvenance);

  // Provenance is additive context — it names the session behind each file and
  // sharpens the grouping — so its absence never blocks review and failures are
  // swallowed in the store.
  useEffect(() => {
    void loadProvenance();
  }, [loadProvenance]);

  // The margin is reserved when a job that fills it *starts*, not when its
  // first result lands: one layout shift at click time rather than a reflow
  // under the reader as annotations stream in.
  const hasMargin = useReview(
    (s) =>
      s.narrateStatus !== 'idle' ||
      s.reviewStatus !== 'idle' ||
      s.findings.length > 0 ||
      Object.keys(s.narrations).length > 0,
  );

  // Keyboard first: a review that needs the mouse is a review that gets skipped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      // A button holding DOM focus would also consume the spacebar as its own
      // activation, so shortcuts run against the review model only.
      if (e.key === ' ' && target.tagName === 'BUTTON') target.blur();

      if (e.key === 'Escape') {
        setPalette(false);
        setKeys(false);
        setLedger(false);
        return;
      }

      // A fresh review has nothing focused. Rather than swallowing the first
      // keypress, any navigation or accept key starts the queue.
      if (!focused && units.length > 0 && ['j', 'k', 'n', ' ', 'x'].includes(e.key)) {
        e.preventDefault();
        nextUnreviewed(units);
        return;
      }

      switch (e.key) {
        case 'j': moveFocus(units, 1); break;
        case 'k': moveFocus(units, -1); break;
        case 'n': nextUnreviewed(units); break;
        case ' ':
          // Accept and move on — deliberately not a toggle. Once the queue is
          // complete there is nothing to advance to, and a toggle would then
          // un-review the last unit on every further press.
          if (focused) {
            e.preventDefault();
            setUnitState(focused, 'reviewed');
            nextUnreviewed(units);
          }
          break;
        case 'u':
          // The explicit undo, so unmarking is always possible but never accidental.
          if (focused) setUnitState(focused, 'unreviewed');
          break;
        case 'x':
          if (focused) {
            const cur = useReview.getState().unitStates[focused] ?? 'unreviewed';
            setUnitState(focused, cur === 'flagged' ? 'unreviewed' : 'flagged');
          }
          break;
        case 'f': nextFinding(); break;
        case 'l': setLedger(!useReview.getState().ledgerOpen); break;
        case 'g': e.preventDefault(); setPalette(true); break;
        case 'b': toggleBrief(); break;
        case '?': setKeys(true); break;
        case 't': toggleTheme(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    moveFocus, nextUnreviewed, nextFinding, setUnitState, focused, toggleTheme,
    toggleBrief, setPalette, setKeys, setLedger, units,
  ]);

  if (!data) return null;

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--paper)' }}>
      <TopBar onChangeTarget={onChangeTarget} />
      <ResumeBanner />
      <ReviewMetaBar />
      <main className="min-h-0 flex-1 overflow-auto" style={{ background: 'var(--panel)' }}>
        <div className={`stream ${hasMargin ? 'has-margin' : ''}`}>
          <BriefCard />
          <DiffView sections={sections} />
          <NoiseStrip />
        </div>
      </main>
      <JumpPalette />
      <KeysOverlay />
      <LedgerOverlay />
      <WriteBackGate />
    </div>
  );
}
