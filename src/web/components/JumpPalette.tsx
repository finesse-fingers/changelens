import { useMemo, useRef, useState, useEffect } from 'react';
import { useReview } from '../store/review.js';
import { useSectionProgress, useStreamSections } from '../store/derive.js';

interface Row {
  id: string;
  kind: 'group' | 'file' | 'finding';
  label: string;
  detail: string;
  unitId: string | null;
  findingId?: string;
}

/**
 * Jump anywhere without a panel.
 *
 * The left rail existed mostly to navigate. Navigation is a momentary need, so
 * it becomes a thing summoned with a key and dismissed, rather than a column
 * competing for width with the code all session.
 */
export function JumpPalette() {
  const open = useReview((s) => s.paletteOpen);
  const setPalette = useReview((s) => s.setPalette);
  const focus = useReview((s) => s.focus);
  const openFinding = useReview((s) => s.openFinding);
  const findings = useReview((s) => s.findings);
  const dispositions = useReview((s) => s.dispositions);
  const sections = useStreamSections();
  const progress = useSectionProgress();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const s of sections) {
      const p = progress.get(s.id) ?? { done: 0, total: 0 };
      if (s.label) {
        out.push({
          id: `g:${s.id}`,
          kind: 'group',
          label: s.label,
          detail: `${p.done}/${p.total} · ${s.reason}`,
          unitId: s.units[0]?.id ?? null,
        });
      }
      for (const f of s.files) {
        out.push({
          id: `f:${s.id}:${f.file.path}`,
          kind: 'file',
          label: f.file.path,
          detail: `+${f.file.additions} −${f.file.deletions}`,
          unitId: f.units[0]?.id ?? null,
        });
      }
    }
    for (const f of findings) {
      out.push({
        id: `x:${f.id}`,
        kind: 'finding',
        label: `#${f.rank + 1} ${f.shortSummary ?? f.summary}`,
        detail: dispositions[f.id] ? dispositions[f.id] : 'untriaged',
        unitId: f.hunkId ?? null,
        findingId: f.id,
      });
    }
    return out;
  }, [sections, progress, findings, dispositions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows.slice(0, 60);
    return rows
      .filter((r) => r.label.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q))
      .slice(0, 60);
  }, [rows, query]);

  if (!open) return null;

  const go = (row: Row) => {
    if (row.findingId) openFinding(row.findingId);
    if (row.unitId) focus(row.unitId);
    setPalette(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      style={{ background: 'color-mix(in srgb, var(--paper) 70%, transparent)' }}
      onClick={() => setPalette(false)}
    >
      <div
        className="w-[720px] max-w-[92vw] overflow-hidden rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPalette(false);
            if (e.key === 'Enter' && filtered[0]) go(filtered[0]);
          }}
          placeholder="Jump to a change, a file or a finding…"
          className="w-full border-b bg-transparent px-4 py-3 text-[13px] outline-none"
          style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
        />
        <div className="max-h-[52vh] overflow-auto">
          {filtered.length === 0 && (
            <p className="muted px-4 py-3 text-[12px]">Nothing matches.</p>
          )}
          {filtered.map((row) => (
            <button
              key={row.id}
              onClick={() => go(row)}
              className="flex w-full items-baseline gap-3 px-4 py-1.5 text-left hover:bg-[var(--raised)]"
            >
              <span
                className="w-[52px] shrink-0 text-[9px] uppercase tracking-wide"
                style={{
                  color:
                    row.kind === 'finding' ? 'var(--amber)'
                    : row.kind === 'group' ? 'var(--accent)'
                    : 'var(--muted)',
                }}
              >
                {row.kind}
              </span>
              <span className={`flex-1 truncate text-[12px] ${row.kind === 'file' ? 'mono' : ''}`}>
                {row.label}
              </span>
              <span className="muted shrink-0 truncate text-[10px]">{row.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
