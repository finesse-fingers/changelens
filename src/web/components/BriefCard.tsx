import { useReview } from '../store/review.js';

const VERDICT_COLOR: Record<string, string> = {
  Good: 'var(--add-gutter)',
  Mixed: 'var(--amber)',
  Concern: 'var(--rose)',
  Unknown: 'var(--muted)',
};

const LEVEL_COLOR: Record<string, string> = {
  info: 'var(--muted)',
  warning: 'var(--amber)',
  critical: 'var(--rose)',
};

/**
 * The lead card: what this change is, before any of its code.
 *
 * It sits at the top of the stream rather than in a panel because it is read
 * once, on the way in. "Your attention" comes before the prose — a critical
 * caveat buried under three paragraphs is a caveat nobody reads.
 */
export function BriefCard() {
  const map = useReview((s) => s.map);
  const status = useReview((s) => s.mapStatus);
  const activity = useReview((s) => s.mapActivity);
  const error = useReview((s) => s.mapError);
  const runMap = useReview((s) => s.runMap);
  const collapsed = useReview((s) => s.briefCollapsed);
  const toggle = useReview((s) => s.toggleBrief);

  if (status === 'running') {
    return (
      <Shell>
        <p className="text-[13px]">
          <span className="inline-block animate-pulse">Reading the change…</span>
        </p>
        {activity && (
          <p className="muted mt-2 border-l-2 pl-2 text-[12px] leading-snug" style={{ borderColor: 'var(--line)' }}>
            {activity}
          </p>
        )}
      </Shell>
    );
  }

  if (status === 'failed') {
    return (
      <Shell>
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--rose)' }}>
          The map did not complete, so there is no brief. This is not the same as a clean change.
        </p>
        {error && <p className="muted mt-1 text-[12px]">{error}</p>}
        <button onClick={runMap} className="muted mt-2 text-[12px] underline-offset-2 hover:underline">
          Try again
        </button>
      </Shell>
    );
  }

  if (!map) {
    return (
      <Shell>
        <p className="muted max-w-[680px] text-[13px] leading-relaxed">
          The stream is already grouped by change using file names, shared symbols and which
          agent session wrote what. Explaining the change replaces those groups with what each
          one is actually for, plus a brief and the caveats worth your attention.
        </p>
        <button
          onClick={runMap}
          className="mt-3 rounded px-3 py-1.5 text-[12px] font-medium"
          style={{ background: 'var(--accent)', color: 'var(--paper)' }}
        >
          Explain this change
        </button>
      </Shell>
    );
  }

  const b = map.map.brief;
  const attention = map.map.attention;

  if (collapsed) {
    return (
      <Shell>
        <button onClick={toggle} className="flex w-full items-center gap-3 text-left">
          <span className="text-[13px] font-semibold tracking-tight">{map.map.title}</span>
          {attention.length > 0 && (
            <span className="text-[11px]" style={{ color: 'var(--amber)' }}>
              {attention.length} caveat{attention.length === 1 ? '' : 's'}
            </span>
          )}
          <span className="muted ml-auto text-[11px]">expand (b)</span>
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">{map.map.title}</h1>
        <button onClick={toggle} className="muted ml-auto text-[11px] underline-offset-2 hover:underline">
          collapse (b)
        </button>
      </div>

      {attention.length > 0 && (
        <ul className="mt-3 space-y-2">
          {attention.map((a, i) => (
            <li
              key={i}
              className="border-l-2 pl-3 text-[12.5px] leading-snug"
              style={{ borderColor: LEVEL_COLOR[a.level] }}
            >
              <span
                className="mr-1.5 text-[9px] uppercase tracking-wide"
                style={{ color: LEVEL_COLOR[a.level] }}
              >
                {a.level}
              </span>
              {a.text}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <Section title="What changed">{b.whatChanged}</Section>
        <Section title="Why this approach">{b.whyThisApproach}</Section>
        <div>
          <h3 className="note-label mb-1.5">Self-assessment</h3>
          <ul className="space-y-1.5">
            {(['scope', 'codebase', 'maintenance'] as const).map((k) => (
              <li key={k} className="text-[12.5px] leading-snug">
                <span className="muted capitalize">{k}: </span>
                <span style={{ color: VERDICT_COLOR[b.assessment[k].verdict] }}>
                  {b.assessment[k].verdict}
                </span>
                <span className="muted"> — </span>
                {b.assessment[k].reason}
              </li>
            ))}
          </ul>
        </div>
        <Section title="Evidence and caveats">{b.evidenceAndCaveats}</Section>
      </div>

      <p className="muted mt-4 text-[10px]">
        Mapped in {Math.round(map.durationMs / 1000)}s
        {!map.intentSufficient && ' · no PR description, scope judgements are inferred'}
        {map.unassignedFiles.length > 0 && ` · ${map.unassignedFiles.length} file(s) unsorted`}
      </p>
    </Shell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="note-label mb-1.5">{title}</h3>
      <p className="text-[12.5px] leading-relaxed">{children}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-4 mb-2 mt-4 rounded-lg border p-4"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      {children}
    </div>
  );
}
