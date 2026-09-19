import { useReview } from '../store/review.js';
import { useExcludedFiles, useOrderedUnits } from '../store/derive.js';

/**
 * What was kept out of the review, and the bulk sign-off.
 *
 * Excluded files are listed rather than silently dropped: the reviewer should
 * be able to see what the classifier decided not to show them and disagree
 * with it.
 */
export function NoiseStrip() {
  const excluded = useExcludedFiles();
  const showNoise = useReview((s) => s.showNoise);
  const toggleNoise = useReview((s) => s.toggleNoise);
  const markAll = useReview((s) => s.markAll);
  const units = useOrderedUnits();

  return (
    <div className="mx-4 mt-8 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
      {excluded.length > 0 && (
        <>
          <button
            onClick={toggleNoise}
            className="muted flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider"
          >
            <span>{showNoise ? '▾' : '▸'}</span>
            Noise ({excluded.length})
          </button>
          {showNoise && (
            <div className="mt-2 grid gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              {excluded.map((f) => (
                <div key={f.path} className="flex items-baseline gap-2">
                  <span className="mono truncate text-[11px] opacity-60">{f.path}</span>
                  <span className="muted shrink-0 text-[10px]">{f.noise}</span>
                </div>
              ))}
            </div>
          )}
          <p className="muted mt-2 max-w-[680px] text-[10px] leading-relaxed">
            Deterministically classified — lockfiles, vendored and generated output, pure
            renames. Never sent to a model.
          </p>
        </>
      )}

      <button
        onClick={() => markAll(units, 'reviewed')}
        className="muted mt-3 text-[11px] underline-offset-2 hover:underline"
      >
        Mark everything reviewed
      </button>
    </div>
  );
}
