import { useState } from 'react';
import { useReview, type Grouping, type NoteFilter } from '../store/review.js';
import { useOpenFindings, useProgress, useStreamSections } from '../store/derive.js';

/**
 * How the stream is grouped.
 *
 * Both the deterministic grouping and the map's cards are exposed rather than
 * one being chosen for the reviewer — the same call made for the recipe matrix.
 * `card` stays disabled until the map has actually produced cards, so the
 * control never offers a view it cannot render.
 */
function GroupingControl() {
  const grouping = useReview((s) => s.grouping);
  const setGrouping = useReview((s) => s.setGrouping);
  const cardsReady = useReview(
    (s) => s.mapStatus === 'done' && (s.map?.map.cards.length ?? 0) > 0,
  );
  const hasProvenance = useReview((s) => Object.keys(s.provenance).length > 0);

  const options: { key: Grouping; label: string; hint: string; enabled: boolean }[] = [
    { key: 'change', label: 'change', hint: 'Grouped by names, shared symbols and sessions — no model call', enabled: true },
    { key: 'card', label: 'card', hint: cardsReady ? 'Grouped by the change map\'s cards' : 'Explain this change first', enabled: cardsReady },
    { key: 'session', label: 'session', hint: hasProvenance ? 'Grouped by the agent session that wrote each file' : 'No agent transcripts matched these files', enabled: hasProvenance },
    { key: 'file', label: 'file', hint: 'Ungrouped, ranked by salience', enabled: true },
  ];

  return (
    <div className="flex items-center gap-0.5 rounded p-0.5" style={{ background: 'var(--raised)' }}>
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => o.enabled && setGrouping(o.key)}
          disabled={!o.enabled}
          title={o.hint}
          className="rounded px-1.5 py-[2px] text-[10px] disabled:opacity-30"
          style={{
            background: grouping === o.key ? 'var(--panel)' : 'transparent',
            color: grouping === o.key ? 'var(--accent)' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The evidence snapshot, behind the base chip that already summarises it.
 *
 * Every review rests on a specific base, head and tree state; keeping that
 * one click away means a finding can always be traced to the exact comparison
 * it came from.
 */
function EvidenceChip() {
  const snap = useReview((s) => s.data?.snapshot);
  const summary = useReview((s) => s.data?.summary);
  const [open, setOpen] = useState(false);
  if (!snap) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded px-1.5 py-0.5 text-[10px]"
        style={{ background: 'var(--raised)', color: 'var(--muted)' }}
        title="The exact comparison this review rests on"
      >
        vs {snap.baseRef}
      </button>
      {open && (
        <div
          className="absolute left-0 top-[24px] z-30 w-[320px] rounded border p-3 shadow-lg"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <dl className="grid grid-cols-[64px_1fr] gap-y-1 text-[11px]">
            <dt className="muted">Base</dt>
            <dd className="mono truncate">{snap.baseSha.slice(0, 12)}</dd>
            <dt className="muted">Head</dt>
            <dd className="mono truncate">{snap.headSha.slice(0, 12)}</dd>
            <dt className="muted">Via</dt>
            <dd className="mono">{snap.baseResolution}</dd>
            <dt className="muted">Tree</dt>
            <dd className="mono">{snap.dirtyDigest ? 'dirty' : 'clean'}</dd>
            <dt className="muted">Taken</dt>
            <dd className="mono">{new Date(snap.inspectedAt).toLocaleTimeString()}</dd>
          </dl>
          {summary && summary.excluded > 0 && (
            <p className="muted mt-2 text-[10px]">
              {summary.excluded} file{summary.excluded === 1 ? '' : 's'} excluded as noise.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Run / cancel for the map job, with the model's current activity inline. */
function MapControl() {
  const status = useReview((s) => s.mapStatus);
  const activity = useReview((s) => s.mapActivity);
  const runMap = useReview((s) => s.runMap);
  const cancelMap = useReview((s) => s.cancelMap);

  if (status === 'running') {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        <span className="muted min-w-0 flex-1 truncate text-[11px]">{activity || 'Explaining…'}</span>
        <button onClick={cancelMap} className="kbd shrink-0">stop</button>
      </div>
    );
  }
  return (
    <button
      onClick={runMap}
      className="rounded px-2 py-1 text-[11px]"
      style={{
        background: status === 'done' ? 'transparent' : 'var(--raised)',
        color: status === 'done' ? 'var(--muted)' : 'var(--accent)',
      }}
    >
      {status === 'done' ? 're-explain' : status === 'failed' ? 'retry explain' : 'Explain this change'}
    </button>
  );
}

/** Per-change annotations: what each change does, and how good it is. */
function NarrateControl() {
  const status = useReview((s) => s.narrateStatus);
  const activity = useReview((s) => s.narrateActivity);
  const run = useReview((s) => s.runNarrate);
  const cancel = useReview((s) => s.cancelNarrate);
  const count = useReview((s) => Object.keys(s.narrations).length);
  const model = useReview((s) => s.narrateModel);
  const setModel = useReview((s) => s.setNarrateModel);
  const effort = useReview((s) => s.narrateEffort);
  const setEffort = useReview((s) => s.setNarrateEffort);
  const files = useReview(
    (s) => (s.data?.diff.files ?? []).filter((f) => f.tier === 'normal' && !f.isBinary).length,
  );
  const sections = useStreamSections();

  if (status === 'running') {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
          style={{ background: 'var(--violet)' }}
        />
        <span className="muted min-w-0 max-w-[240px] flex-1 truncate text-[11px]">
          {activity || 'Annotating…'}
        </span>
        <button onClick={cancel} className="kbd shrink-0">stop</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="mono rounded border px-1 py-[2px] text-[10px]"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--muted)' }}
        title="Model for each annotation shard. Separate from the review's."
      >
        <option value="sonnet">sonnet</option>
        <option value="opus">opus</option>
      </select>
      <select
        value={effort}
        onChange={(e) => setEffort(e.target.value)}
        className="mono rounded border px-1 py-[2px] text-[10px]"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--muted)' }}
        title="Reasoning effort per annotation shard."
      >
        {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>
      <button
        onClick={() => run(sections.flatMap((sec) => sec.files.map((f) => f.file.path)))}
        className="rounded px-2 py-1 text-[11px]"
        style={{ background: 'var(--raised)', color: 'var(--violet)' }}
        title={`Score and explain each change in the margin, against this repo's own conventions${files > 0 ? ` — ${files} file(s), four at a time` : ''}`}
      >
        {count > 0 ? 're-annotate' : 'Annotate changes'}
      </button>
    </div>
  );
}

/**
 * How much of the annotation layer is shown, and what it was judged against.
 *
 * The conventions line matters as much as the filter: a quality score with no
 * house rules behind it is one model's taste, and the reviewer should be able
 * to tell the two apart at a glance.
 */
function NoteFilterControl() {
  const filter = useReview((s) => s.noteFilter);
  const setFilter = useReview((s) => s.setNoteFilter);
  const count = useReview((s) => Object.keys(s.narrations).length);
  const conventions = useReview((s) => s.narrateConventions);
  const failed = useReview((s) => s.narrateFailed);
  if (count === 0) return null;

  const options: { key: NoteFilter; hint: string }[] = [
    { key: 'all', hint: 'Every annotation, routine ones expanded' },
    { key: 'notable', hint: 'Routine changes collapse to one line' },
    { key: 'problems', hint: 'Only low scores and weak axes' },
  ];

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5 rounded p-0.5" style={{ background: 'var(--raised)' }}>
        {options.map((o) => (
          <button
            key={o.key}
            onClick={() => setFilter(o.key)}
            title={o.hint}
            className="rounded px-1.5 py-[2px] text-[10px]"
            style={{
              background: filter === o.key ? 'var(--panel)' : 'transparent',
              color: filter === o.key ? 'var(--accent)' : 'var(--muted)',
            }}
          >
            {o.key}
          </button>
        ))}
      </div>
      {failed.length > 0 && (
        <span
          className="max-w-[200px] truncate text-[10px]"
          style={{ color: 'var(--amber)' }}
          title={`No annotation for: ${failed.join(', ')}. An empty margin here means the shard failed, not that there was nothing to say.`}
        >
          {failed.length} file{failed.length === 1 ? '' : 's'} un-annotated
        </span>
      )}
      {conventions && (
        <span
          className="muted max-w-[220px] truncate text-[10px]"
          style={{ color: conventions === 'no conventions file found' ? 'var(--amber)' : undefined }}
          title={
            conventions === 'no conventions file found'
              ? 'Nothing documents this repo\u2019s conventions, so the conventions axis was not scored'
              : `Annotations were judged against ${conventions}`
          }
        >
          {conventions}
        </span>
      )}
    </div>
  );
}

/**
 * Review controls, with the recipe made visible.
 *
 * The model × effort mapping is not monotonic — opus at xhigh runs no verify
 * pass while the same model at max does — so the run control states what the
 * chosen combination actually does rather than hiding it behind a number.
 */
function ReviewControl() {
  const status = useReview((s) => s.reviewStatus);
  const activity = useReview((s) => s.reviewActivity);
  const effort = useReview((s) => s.effort);
  const model = useReview((s) => s.model);
  const recipe = useReview((s) => s.recipe);
  const findings = useReview((s) => s.findings);
  const setEffort = useReview((s) => s.setEffort);
  const setModel = useReview((s) => s.setModel);
  const runReview = useReview((s) => s.runReview);
  const cancelReview = useReview((s) => s.cancelReview);

  if (status === 'running') {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: 'var(--rose)' }} />
        <span className="muted min-w-0 max-w-[280px] flex-1 truncate text-[11px]">
          {findings.length > 0 ? `${findings.length} finding(s) so far — ` : ''}
          {activity || 'Reviewing…'}
        </span>
        <button onClick={cancelReview} className="kbd shrink-0">stop</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="mono rounded border px-1 py-[2px] text-[10px]"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--muted)' }}
      >
        <option value="sonnet">sonnet</option>
        <option value="opus">opus</option>
      </select>
      <select
        value={effort}
        onChange={(e) => setEffort(e.target.value)}
        className="mono rounded border px-1 py-[2px] text-[10px]"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--muted)' }}
      >
        {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>
      <button
        onClick={runReview}
        className="rounded px-2 py-1 text-[11px]"
        style={{ background: 'var(--raised)', color: 'var(--rose)' }}
        title={recipe ? recipe.tag : 'Run /code-review'}
      >
        {status === 'done' ? 're-review' : status === 'failed' ? 'retry review' : 'Find bugs'}
      </button>
    </div>
  );
}

export function TopBar({ onChangeTarget }: { onChangeTarget: () => void }) {
  const snap = useReview((s) => s.data?.snapshot);
  const progress = useProgress();
  const theme = useReview((s) => s.theme);
  const toggleTheme = useReview((s) => s.toggleTheme);
  const findings = useReview((s) => s.findings);
  const open = useOpenFindings();
  const setLedger = useReview((s) => s.setLedger);
  const setPalette = useReview((s) => s.setPalette);
  if (!snap) return null;

  return (
    <header
      // Wraps rather than overflowing: the controls here outgrow a narrow
      // window, and a header that pushes the page sideways drags the diff with
      // it every time you scroll.
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      <button onClick={onChangeTarget} className="text-[13px] font-semibold tracking-tight">
        Changelens
      </button>

      <div className="mono flex min-w-0 items-center gap-2 text-[11px]">
        <span className="muted">{snap.repoRoot.slice(snap.repoRoot.lastIndexOf('/') + 1)}</span>
        <span className="muted">/</span>
        <span>{snap.kind === 'pr' ? `#${snap.prNumber}` : snap.headRef}</span>
        <EvidenceChip />
        {snap.dirtyDigest && (
          <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--amber)' }}>
            working tree dirty
          </span>
        )}
      </div>

      <MapControl />
      <NarrateControl />
      <ReviewControl />

      <div className="flex-1" />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <NoteFilterControl />
        <GroupingControl />
        {findings.length > 0 && (
          <button
            onClick={() => setLedger(true)}
            className="mono underline-offset-2 hover:underline"
            style={{ color: open.length > 0 ? 'var(--amber)' : 'var(--muted)' }}
            title="Open the findings ledger (l) — f walks them in the diff instead"
          >
            {open.length}/{findings.length} findings
          </button>
        )}
        <button onClick={() => setPalette(true)} className="kbd" title="Jump to a change, file or finding (g)">
          g
        </button>
        <div className="h-1.5 w-28 overflow-hidden rounded-full" style={{ background: 'var(--raised)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${progress.pct}%`, background: 'var(--accent)' }} />
        </div>
        <span className="mono muted">
          {progress.reviewed}/{progress.total} units
        </span>
        {progress.flagged > 0 && (
          <span className="mono" style={{ color: 'var(--amber)' }}>{progress.flagged} flagged</span>
        )}
        <button onClick={toggleTheme} className="kbd" title="Toggle theme (t)">
          {theme === 'dark' ? 'dark' : 'paper'}
        </button>
      </div>
    </header>
  );
}
