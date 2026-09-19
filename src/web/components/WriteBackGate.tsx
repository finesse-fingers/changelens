import { useReview } from '../store/review.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * Renders whichever write-back confirmation is pending, plus the result of the
 * last one. Separate from the review surface so that nothing in the review flow
 * can trigger an outward action without passing through here.
 */
export function WriteBackGate() {
  const pendingComment = useReview((s) => s.pendingComment);
  const pendingFix = useReview((s) => s.pendingFix);
  const busy = useReview((s) => s.writeBusy);
  const result = useReview((s) => s.writeResult);
  const fixResult = useReview((s) => s.fixResult);
  const confirmComments = useReview((s) => s.confirmComments);
  const confirmFix = useReview((s) => s.confirmFix);
  const cancel = useReview((s) => s.cancelWrite);
  const clear = useReview((s) => s.clearWriteResult);

  return (
    <>
      {pendingComment && (
        <ConfirmDialog
          title={`Post ${pendingComment.comments.length} inline comment${pendingComment.comments.length === 1 ? '' : 's'}`}
          intent={`To PR #${pendingComment.prNumber}, anchored to commit ${pendingComment.commitSha.slice(0, 10)}, from your GitHub account.`}
          confirmLabel="Post to GitHub"
          busy={busy}
          onConfirm={confirmComments}
          onCancel={cancel}
          payload={
            <div className="space-y-3">
              {pendingComment.comments.map((c) => (
                <div key={c.findingId} className="rounded border p-3" style={{ borderColor: 'var(--line)' }}>
                  <div className="mono muted mb-1 text-[11px]">
                    {c.path}:{c.line}
                  </div>
                  <pre className="whitespace-pre-wrap text-[11px] leading-relaxed">{c.body}</pre>
                </div>
              ))}
              {pendingComment.skipped.length > 0 && (
                <div className="muted text-[11px]">
                  <p className="mb-1">Not posted inline:</p>
                  <ul className="list-inside list-disc space-y-0.5">
                    {pendingComment.skipped.map((s) => (
                      <li key={s.findingId}>{s.findingId.split(':').slice(0, 2).join(':')} — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          }
        />
      )}

      {pendingFix && (
        <ConfirmDialog
          title="Apply this fix to your working tree"
          intent="A Claude run will edit files in place. Nothing is committed, and you review the diff afterwards."
          confirmLabel="Apply to working tree"
          danger
          busy={busy}
          onConfirm={confirmFix}
          onCancel={cancel}
          payload={
            <div className="space-y-2 text-[12px] leading-relaxed">
              <p>{pendingFix.label}</p>
              <p className="muted">
                The run is told to change only what this finding requires, and to make no
                change at all if the fix would alter intended behaviour, need a product
                decision, or reach outside the reviewed diff. It may also conclude the
                finding is wrong and change nothing.
              </p>
            </div>
          }
        />
      )}

      {(result || fixResult) && !pendingComment && !pendingFix && (
        <div
          className="fixed bottom-4 right-4 z-40 max-w-lg rounded border p-3 text-[11px] shadow-lg"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          {result && <p>{result}</p>}
          {fixResult && (
            <>
              {fixResult.summary && (
                <p className="muted mt-2 leading-relaxed">{fixResult.summary.slice(0, 600)}</p>
              )}
              {fixResult.diff && (
                <pre
                  className="mono mt-2 max-h-64 overflow-auto rounded p-2 text-[10px] leading-snug"
                  style={{ background: 'var(--raised)' }}
                >
                  {fixResult.diff.slice(0, 4000)}
                </pre>
              )}
            </>
          )}
          <button onClick={clear} className="muted mt-2 underline-offset-2 hover:underline">
            dismiss
          </button>
        </div>
      )}
    </>
  );
}
