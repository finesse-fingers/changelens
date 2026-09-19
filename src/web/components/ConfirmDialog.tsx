import { useEffect } from 'react';

/**
 * The confirmation gate for anything that leaves this machine or edits files.
 *
 * It always renders the exact payload rather than a description of it —
 * confirming "post 3 comments" is not consent to whatever text those comments
 * turn out to contain.
 */
export function ConfirmDialog({
  title,
  intent,
  payload,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  intent: string;
  payload: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onCancel}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b px-5 py-3" style={{ borderColor: 'var(--line)' }}>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <p className="muted mt-0.5 text-[12px]">{intent}</p>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[12px]">{payload}</div>

        <footer
          className="flex items-center gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="muted flex-1 text-[11px]">
            This is exactly what will be sent. Nothing has happened yet.
          </span>
          <button onClick={onCancel} className="rounded px-3 py-1.5 text-[12px]" style={{ color: 'var(--muted)' }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: danger ? 'var(--rose)' : 'var(--accent)', color: 'var(--paper)' }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
