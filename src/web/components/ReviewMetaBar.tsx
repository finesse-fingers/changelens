import { useReview } from '../store/review.js';

/**
 * What the review run actually did, above everything it found.
 *
 * These caveats are set-wide, not per-finding: a recipe that ran no verify pass
 * changes how much the whole list should be trusted, and a hit cap means the
 * list is a sample rather than coverage. Neither may be discoverable only by
 * scrolling to the bottom of something.
 */
export function ReviewMetaBar() {
  const status = useReview((s) => s.reviewStatus);
  const error = useReview((s) => s.reviewError);
  const meta = useReview((s) => s.reviewMeta);
  const findings = useReview((s) => s.findings);
  const dispositions = useReview((s) => s.dispositions);

  if (status === 'idle') return null;

  if (status === 'failed') {
    return (
      <Bar>
        <span style={{ color: 'var(--rose)' }}>
          The review did not complete. This is not a clean result.
        </span>
        {error && <span className="muted">{error}</span>}
      </Bar>
    );
  }

  if (status === 'running' && findings.length === 0) {
    return (
      <Bar>
        <span className="muted">Reviewing… findings appear in the margin as they are reported.</span>
      </Bar>
    );
  }

  if (status === 'done' && findings.length === 0) {
    return (
      <Bar>
        <span className="muted">Nothing survived verification. That is a real result, not an error.</span>
        {meta && <span className="muted">{meta.recipe.tag}</span>}
      </Bar>
    );
  }

  const decided = findings.filter((f) => dispositions[f.id]).length;

  return (
    <Bar>
      <span className="mono">
        {decided}/{findings.length} triaged
      </span>
      <span className="muted">ordered most severe first</span>
      {meta && (
        <>
          <span className="muted">{meta.recipe.tag}</span>
          {meta.recovered && (
            <span style={{ color: 'var(--amber)' }} title="The run ended its turn without reporting; resuming the session recovered the findings">
              recovered on a second turn
            </span>
          )}
          {meta.conventions && (
            <span
              className="muted"
              style={{ color: meta.conventions === 'no conventions file found' ? 'var(--amber)' : undefined }}
              title={`The review was told to judge conventions against ${meta.conventions}`}
            >
              {meta.conventions}
            </span>
          )}
          {!meta.recipe.verifies && (
            <span style={{ color: 'var(--amber)' }}>
              no verify pass — findings carry no verdict and none were dropped as refuted
            </span>
          )}
          {meta.capHit && (
            <span style={{ color: 'var(--amber)' }}>
              {meta.recipe.cap}-finding cap reached — a sample, not full coverage
            </span>
          )}
          {meta.degradedToSinglePass && (
            <span style={{ color: 'var(--rose)' }}>
              Agent tool unavailable — ran single-pass, not the full fan-out
            </span>
          )}
          <span className="muted">{Math.round(meta.durationMs / 1000)}s</span>
        </>
      )}
    </Bar>
  );
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5 text-[11px]"
      style={{ borderColor: 'var(--line)', background: 'var(--raised)' }}
    >
      {children}
    </div>
  );
}
