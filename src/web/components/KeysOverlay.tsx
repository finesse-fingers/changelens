import { useReview } from '../store/review.js';

const KEYS: [string, string][] = [
  ['j / k', 'next / previous change'],
  ['n', 'next unreviewed change'],
  ['space', 'accept and advance'],
  ['u', 'undo accept'],
  ['x', 'flag for later'],
  ['f', 'next untriaged finding'],
  ['l', 'the findings ledger — triage them all'],
  ['g', 'jump to a change, file or finding'],
  ['b', 'collapse / expand the brief'],
  ['t', 'toggle dark / paper'],
  ['?', 'this list'],
];

export function KeysOverlay() {
  const open = useReview((s) => s.keysOpen);
  const setKeys = useReview((s) => s.setKeys);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--paper) 70%, transparent)' }}
      onClick={() => setKeys(false)}
    >
      <div
        className="w-[420px] rounded-lg border p-5 shadow-2xl"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="note-label mb-3">Keys</h2>
        <div className="space-y-1.5">
          {KEYS.map(([k, d]) => (
            <div key={k} className="flex items-center gap-3">
              <span className="kbd w-[52px] text-center">{k}</span>
              <span className="text-[12px]">{d}</span>
            </div>
          ))}
        </div>
        <p className="muted mt-4 text-[10px]">Escape or click anywhere to close.</p>
      </div>
    </div>
  );
}
