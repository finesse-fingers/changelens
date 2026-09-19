import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { DiffLine, Hunk } from '../../shared/types.js';
import { useReview } from '../store/review.js';
import { useSectionProgress, type StreamFile, type StreamSection } from '../store/derive.js';
import { useHunkTokens, type CodeToken, type HunkTokens } from '../store/highlight.js';
import type { Finding, MapJobResult, NarrationAxisNote, ReviewUnit } from '../store/api.js';
import { FindingPin } from './FindingPin.js';

type Card = MapJobResult['map']['cards'][number];

/**
 * The diff: one column of code with an annotation margin beside it.
 *
 * Changes are grouped by what they are rather than by which file they landed
 * in, and every explanation and finding sits in the margin at the exact change
 * it describes — so reading the diff never means looking somewhere else and
 * holding the mapping in your head.
 */
export function DiffView({ sections }: { sections: StreamSection[] }) {
  const findings = useReview((s) => s.findings);
  const map = useReview((s) => s.map);

  // Findings anchored to a unit render at that unit; the rest pin to the file
  // header, because `line` is optional and a finding must never be dropped for
  // failing to land inside the diff.
  const { byUnit, byFile } = useMemo(() => {
    const u = new Map<string, Finding[]>();
    const f = new Map<string, Finding[]>();
    for (const finding of findings) {
      const bucket = finding.hunkId ? u : f;
      const key = finding.hunkId ?? finding.file;
      bucket.set(key, [...(bucket.get(key) ?? []), finding]);
    }
    return { byUnit: u, byFile: f };
  }, [findings]);

  // Which card claims each unit, so a unit sitting under a different card's
  // section can say so rather than appearing to belong there.
  const cardOfUnit = useMemo(() => {
    const m = new Map<string, Card>();
    for (const card of map?.map.cards ?? []) {
      for (const id of card.hunkIds) m.set(id, card);
    }
    return m;
  }, [map]);

  // Which findings actually land somewhere on screen. A finding anchors to a
  // unit, or failing that to its file's header — but the model can name a file
  // that is not in this diff at all (a caller it read, a path it guessed, a
  // file classified as noise). Those used to render nowhere: the count said
  // "3 findings" and the margin showed none.
  const orphaned = useMemo(() => {
    const units = new Set(sections.flatMap((s) => s.units.map((u) => u.id)));
    const paths = new Set(sections.flatMap((s) => s.files.map((f) => f.file.path)));
    return findings.filter(
      (f) => !(f.hunkId && units.has(f.hunkId)) && !paths.has(f.file),
    );
  }, [sections, findings]);

  return (
    <div className="pb-40">
      {orphaned.length > 0 && <OrphanedFindings findings={orphaned} />}
      {sections.map((section) => (
        <SectionBlock
          key={section.id}
          section={section}
          byUnit={byUnit}
          byFile={byFile}
          cardOfUnit={cardOfUnit}
        />
      ))}
    </div>
  );
}

/**
 * Findings the diff cannot hold.
 *
 * The review reads more than it reviews, so it can legitimately report on a
 * caller two files away, on a file this snapshot classified as noise, or on a
 * path it got slightly wrong. Dropping those silently is the worst option
 * available: the reviewer is told there are three findings, sees none, and has
 * no way to tell a display bug from a clean diff.
 */
function OrphanedFindings({ findings }: { findings: Finding[] }) {
  const grouping = useReview((s) => s.grouping);
  return (
    <section
      className="mx-4 mb-2 mt-4 rounded-lg border p-3"
      style={{ borderColor: 'var(--amber)', background: 'var(--panel)' }}
    >
      <h2 className="note-label" style={{ color: 'var(--amber)' }}>
        {findings.length} finding{findings.length === 1 ? '' : 's'} outside this diff
      </h2>
      <p className="muted mb-2 text-[11px] leading-snug">
        These name a file the review read but this snapshot does not show — an
        unchanged caller, a file excluded as noise, or a path the model got wrong.
        They are listed here rather than dropped.
        {grouping === 'card' && ' Switching grouping to "file" sometimes brings them back into view.'}
      </p>
      <div className="max-w-[720px]">
        {findings.map((f) => <FindingPin key={f.id} finding={f} />)}
      </div>
    </section>
  );
}

const SCOPE_COLOR: Record<Card['scope'], string> = {
  Requested: 'var(--teal)',
  Supporting: 'var(--muted)',
  Extra: 'var(--violet)',
};

const RISK_COLOR: Record<Card['risk'], string> = {
  high: 'var(--rose)',
  medium: 'var(--amber)',
  low: 'var(--muted)',
};

/**
 * One coherent change, with its files beneath it in reading order.
 *
 * The header states what grouped these files. Grouping is a heuristic over
 * incomplete signals, so showing its working lets the reviewer disbelieve it —
 * presenting it as fact would be a claim the app cannot support.
 */
function SectionBlock({
  section, byUnit, byFile, cardOfUnit,
}: {
  section: StreamSection;
  byUnit: Map<string, Finding[]>;
  byFile: Map<string, Finding[]>;
  cardOfUnit: Map<string, Card>;
}) {
  const progress = useSectionProgress().get(section.id) ?? { done: 0, total: 0 };
  const markAll = useReview((s) => s.markAll);
  const openCardId = useReview((s) => s.openCardId);
  const openCard = useReview((s) => s.openCard);
  const card = section.card;
  const complete = progress.total > 0 && progress.done === progress.total;
  const expanded = openCardId === section.id;

  return (
    <section className="mb-2">
      {section.label && (
        <div
          className="px-4 pb-2 pt-6"
          style={{ opacity: complete ? 0.5 : 1 }}
        >
          <div className="flex items-baseline gap-2">
            {card && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: RISK_COLOR[card.risk] }}
                title={`${card.risk} risk`}
              />
            )}
            <h2 className="text-[14px] font-semibold tracking-tight">{section.label}</h2>
            {card && (
              <>
                <Chip color={SCOPE_COLOR[card.scope]}>{card.scope}</Chip>
                <Chip color={card.state === 'Verified' ? 'var(--add-gutter)' : 'var(--muted)'}>
                  {card.state}
                </Chip>
              </>
            )}
            <span className="mono muted text-[10px]">
              {progress.done}/{progress.total} · +{section.additions} −{section.deletions}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => markAll(section.units, 'reviewed')}
              className="muted text-[10px] underline-offset-2 hover:underline"
            >
              mark group reviewed
            </button>
          </div>
          <p className="muted mt-0.5 text-[11px] leading-snug">
            {section.reason}
            {card && (card.why || card.alternative || card.tradeoff) && (
              <button
                onClick={() => openCard(section.id)}
                className="ml-2 underline-offset-2 hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                {expanded ? 'less' : 'why?'}
              </button>
            )}
          </p>
          {card && expanded && (
            <div className="mt-2 max-w-[820px] space-y-1.5 text-[12px] leading-relaxed">
              {card.why && <p><span className="muted">Why. </span>{card.why}</p>}
              {card.alternative && <p><span className="muted">Alternative. </span>{card.alternative}</p>}
              {card.tradeoff && <p><span className="muted">Tradeoff. </span>{card.tradeoff}</p>}
            </div>
          )}
          <div className="mt-2 border-t" style={{ borderColor: 'var(--line)' }} />
        </div>
      )}

      {section.files.map((sf) => (
        <FileBlock
          key={`${section.id}:${sf.file.path}`}
          sf={sf}
          sectionCard={card}
          byUnit={byUnit}
          fileFindings={byFile.get(sf.file.path) ?? []}
          cardOfUnit={cardOfUnit}
        />
      ))}
    </section>
  );
}

/** Shared, so a hunk with no units still hands `HunkBlock` a stable prop. */
const EMPTY_UNITS: ReviewUnit[] = [];

/**
 * A file, as a stack of independently scrolling blocks.
 *
 * Each segment is its own horizontal scroll container, which is what lets a
 * note sit beside the exact change it describes. The cost is that two blocks
 * can sit at different offsets: scroll a long line in one change and the
 * context above it stays where it was. These offsets used to be mirrored
 * across the file to avoid that, but a gesture on one block moving the whole
 * file is the more surprising of the two behaviours, so they are not.
 *
 * Memoized because dropping that mirroring left it a pure function of its
 * props — see `HunkBlock` for why that is worth having.
 */
const FileBlock = memo(function FileBlock({
  sf, sectionCard, byUnit, fileFindings, cardOfUnit,
}: {
  sf: StreamFile;
  sectionCard: Card | null;
  byUnit: Map<string, Finding[]>;
  fileFindings: Finding[];
  cardOfUnit: Map<string, Card>;
}) {
  const file = sf.file;
  const annotating = useReview((st) => st.narrateInFlight.includes(file.path));
  return (
    <div className="mb-5">
      {/* The header is a segment too, so file-level findings — those the model
          gave no line for — land in the margin rather than being orphaned. */}
      <div className="seg">
        <header
          className="seg-code sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-2 backdrop-blur"
          style={{ borderColor: 'var(--line)', background: 'color-mix(in srgb, var(--panel) 92%, transparent)' }}
        >
          <StatusDot status={file.status} />
          <span className="mono flex-1 truncate text-[12px]">{file.path}</span>
          <ProvenanceChip path={file.path} />
          {file.tier === 'digest' && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              style={{ background: 'var(--raised)', color: 'var(--amber)' }}
              title="Digested: still shown, because a generated file changing often means something upstream moved"
            >
              {file.noise}
            </span>
          )}
          <span className="mono text-[11px]">
            <span style={{ color: 'var(--add-gutter)' }}>+{file.additions}</span>{' '}
            <span style={{ color: 'var(--del-gutter)' }}>−{file.deletions}</span>
          </span>
        </header>
        <aside className="seg-note">
          {/* One per file, not one per change: `narrateInFlight` is file-
              grained, and repeating it beside every unit in the file turned
              progress into noise. */}
          {annotating && <span className="note-pending">annotating…</span>}
          {fileFindings.map((f) => <FindingPin key={f.id} finding={f} />)}
        </aside>
      </div>

      {file.isBinary ? (
        <p className="muted px-4 py-3 text-[12px]">Binary file — no textual diff.</p>
      ) : (
        sf.hunks.map((hunk) => (
          <HunkBlock
            key={hunk.id}
            hunk={hunk}
            language={file.language}
            units={sf.unitsByHunk.get(hunk.id) ?? EMPTY_UNITS}
            sectionCard={sectionCard}
            byUnit={byUnit}
            cardOfUnit={cardOfUnit}
          />
        ))
      )}
    </div>
  );
});

/** `start` is the segment's offset into `hunk.lines`, so it can find its tokens. */
type Segment =
  | { kind: 'unit'; unit: ReviewUnit; lines: DiffLine[]; start: number }
  | { kind: 'context'; lines: DiffLine[]; start: number };

/**
 * Split a hunk into runs owned by one unit and runs owned by none.
 *
 * This is what makes the margin work: a segment is a grid row, so its note is
 * aligned to its code by layout rather than by measurement.
 */
function segmentsOf(hunk: Hunk, units: ReviewUnit[]): Segment[] {
  const ownerOf = new Array<ReviewUnit | undefined>(hunk.lines.length);
  for (const u of units) {
    for (let i = u.lineRange[0]; i < u.lineRange[1]; i++) ownerOf[i] = u;
  }

  const out: Segment[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    const owner = ownerOf[i];
    const start = i;
    while (i < hunk.lines.length && ownerOf[i] === owner) i++;
    const lines = hunk.lines.slice(start, i);
    out.push(owner ? { kind: 'unit', unit: owner, lines, start } : { kind: 'context', lines, start });
  }
  return out;
}

/**
 * One hunk, and the memo boundary the diff actually needs.
 *
 * Nothing in this tree was memoized and nothing is virtualized, so every row of
 * every file re-rendered on every keystroke: the console subscribes to
 * `focusedUnitId`, and marking a unit reviewed replaces `unitStates`, which
 * hands every section a fresh progress map. Highlighting makes each row more
 * expensive to reconcile, so the cost of that stops being theoretical.
 *
 * The boundary is safe because everything genuinely reactive below it —
 * `UnitSegment`'s review state and focus, `NarrationCard`'s note — arrives
 * through its own store subscription rather than through props, and a
 * subscription crosses a memo. What is left is `hunk` (from the store),
 * `units` (grouped once in `buildStreamFile`) and three maps `DiffView`
 * memoizes: all stable, so the compare bails.
 */
const HunkBlock = memo(function HunkBlock({
  hunk, language, units, sectionCard, byUnit, cardOfUnit,
}: {
  hunk: Hunk;
  language?: string;
  units: ReviewUnit[];
  sectionCard: Card | null;
  byUnit: Map<string, Finding[]>;
  cardOfUnit: Map<string, Card>;
}) {
  const segments = useMemo(() => segmentsOf(hunk, units), [hunk, units]);
  // Whole-hunk, not per-segment: a block comment or a template literal that
  // spans a change and the context around it is one construct, and tokenizing
  // the pieces separately is exactly how it comes out wrong.
  const tokens = useHunkTokens(hunk, language);

  return (
    <div className="border-b" style={{ borderColor: 'var(--line)' }}>
      <div className="seg">
        <div
          className="seg-code mono px-4 py-1 text-[11px]"
          style={{ background: 'var(--raised)', color: 'var(--muted)' }}
        >
          <span className="sticky left-0">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{' '}
          {hunk.section && <span style={{ color: 'var(--violet)' }}>{hunk.section}</span>}
          </span>
        </div>
        <aside className="seg-note" />
      </div>

      {segments.map((seg, i) =>
        seg.kind === 'unit' ? (
          <UnitSegment
            key={`u${i}`}
            unit={seg.unit}
            lines={seg.lines}
            tokens={tokens}
            start={seg.start}
            sectionCard={sectionCard}
            findings={byUnit.get(seg.unit.id) ?? []}
            unitCard={cardOfUnit.get(seg.unit.id) ?? null}
          />
        ) : (
          <div className="seg" key={`c${i}`}>
            <div className="seg-code">
              <div className="seg-rows">
                {seg.lines.map((line, j) => (
                  <Row key={j} line={line} tokens={tokens?.[seg.start + j] ?? null} />
                ))}
              </div>
            </div>
            <aside className="seg-note" />
          </div>
        ),
      )}
    </div>
  );
});

/**
 * One reviewable change and everything said about it, side by side.
 *
 * Review state lives on the unit rather than the hunk, which is what lets an
 * edit landing next to already-reviewed code leave that review intact.
 */
function UnitSegment({
  unit, lines, tokens, start, sectionCard, findings, unitCard,
}: {
  unit: ReviewUnit;
  lines: DiffLine[];
  /** The whole hunk's tokens; this segment's own begin at `start`. */
  tokens: HunkTokens | null;
  start: number;
  sectionCard: Card | null;
  findings: Finding[];
  unitCard: Card | null;
}) {
  const state = useReview((s) => s.unitStates[unit.id] ?? 'unreviewed');
  const setUnitState = useReview((s) => s.setUnitState);
  const focus = useReview((s) => s.focus);
  const focused = useReview((s) => s.focusedUnitId === unit.id);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);

  const reviewed = state === 'reviewed' || state === 'skimmed';
  const codeClass = ['seg-code', reviewed ? 'unit-reviewed' : '', focused ? 'unit-focused' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="seg" ref={ref}>
      <div className={codeClass} onClick={() => focus(unit.id)}>
        <div className="seg-rows">
          {lines.map((line, j) => (
            <Row key={j} line={line} tokens={tokens?.[start + j] ?? null} />
          ))}
        </div>
      </div>

      <aside className="seg-note">
        <div className="mb-1.5 flex items-center gap-2">
          <button
            onClick={(e) => {
              // Keep DOM focus off the checkbox: a focused button treats the
              // next spacebar as its own activation, which double-toggles the
              // unit alongside the global shortcut.
              e.currentTarget.blur();
              focus(unit.id);
              setUnitState(unit.id, reviewed ? 'unreviewed' : 'reviewed');
            }}
            className="flex h-4 w-4 items-center justify-center rounded border text-[10px]"
            style={{
              borderColor: reviewed ? 'var(--add-gutter)' : 'var(--line)',
              color: 'var(--add-gutter)',
              background: 'var(--panel)',
            }}
            title="Mark this change reviewed (space)"
          >
            {reviewed ? '✓' : ''}
          </button>
          {state === 'flagged' && (
            <span className="text-[10px]" style={{ color: 'var(--amber)' }}>flagged</span>
          )}
          <span className="muted mono text-[10px]">
            +{unit.additions} −{unit.deletions}
          </span>
          {/* A unit whose card is not this section's says so, rather than
              appearing to belong to a change it does not. */}
          {unitCard && sectionCard && unitCard.id !== sectionCard.id && (
            <span
              className="truncate rounded px-1 text-[9px]"
              style={{ background: 'var(--raised)', color: 'var(--violet)' }}
              title={`The change map put this unit under "${unitCard.title}"`}
            >
              also: {unitCard.title}
            </span>
          )}
        </div>

        <NarrationCard hunkId={unit.id} />
        {findings.map((f) => <FindingPin key={f.id} finding={f} />)}
      </aside>
    </div>
  );
}

/** Shiki's FontStyle flags. Bit 3 (strikethrough) has nothing to say in code. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/** What the row already inherits, so a token asking for it needs no element. */
const DEFAULT_COLOR = 'var(--shiki-foreground)';

function styleOf(token: CodeToken): CSSProperties {
  const style: CSSProperties = { color: token.color };
  if (!token.fontStyle) return style;
  if (token.fontStyle & ITALIC) style.fontStyle = 'italic';
  if (token.fontStyle & BOLD) style.fontWeight = 600;
  if (token.fontStyle & UNDERLINE) style.textDecoration = 'underline';
  return style;
}

/**
 * Tokens as React children, with the plain ones left as plain text.
 *
 * Half of all tokens come back asking for the foreground colour the row already
 * has, and roughly a fifth of lines are nothing but those — imports, bare
 * identifiers, punctuation-light prose. Wrapping those in a span says nothing
 * and costs a DOM node on every one of them, which on a large diff is tens of
 * thousands of elements for no visible difference. Runs of them are merged into
 * one string instead, so a plain line renders exactly as it did before any of
 * this existed.
 */
function children(tokens: CodeToken[]): (string | React.ReactElement)[] {
  const out: (string | React.ReactElement)[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push(plain);
    plain = '';
  };
  tokens.forEach((token, i) => {
    if (!token.color || token.color === DEFAULT_COLOR) {
      if (!token.fontStyle) {
        plain += token.content;
        return;
      }
    }
    flush();
    out.push(<span key={i} style={styleOf(token)}>{token.content}</span>);
  });
  flush();
  return out;
}

/**
 * One line of code.
 *
 * Memoized, and not decoratively: nothing else in this tree is, there is no
 * virtualization, and so every row in the diff re-renders whenever its segment
 * does — which is every arriving annotation and every unit marked reviewed.
 * Highlighting roughly triples the nodes per line, so those re-renders have to
 * bail. Both props are stable references (the line from the store, the tokens
 * from the module cache), so the default shallow compare does bail.
 *
 * Tokens are rendered as elements rather than through `dangerouslySetInnerHTML`.
 * That pattern appears nowhere in this codebase and this is the wrong place to
 * introduce it: a diff is untrusted text off someone else's branch.
 */
const Row = memo(function Row({ line, tokens }: { line: DiffLine; tokens: CodeToken[] | null }) {
  return (
    <div className={`diff-row ${line.kind}`}>
      <span className="diff-num">{line.oldLine ?? ''}</span>
      <span className="diff-num">{line.newLine ?? ''}</span>
      <span className="diff-code">
        {/* An empty line tokenizes to nothing and still needs its space, or
            the row collapses to zero height. */}
        {tokens?.length ? children(tokens) : line.text || ' '}
      </span>
    </div>
  );
});

const AXIS_LABEL: Record<NarrationAxisNote['axis'], string> = {
  conventions: 'Conventions',
  clarity: 'Clarity',
  design: 'Design',
};

const RATING_COLOR: Record<NarrationAxisNote['rating'], string> = {
  strong: 'var(--add-gutter)',
  ok: 'var(--muted)',
  weak: 'var(--amber)',
};

/** Score as filled dots. A number alone reads as precision this is not. */
function ScoreDots({ score }: { score: number }) {
  return (
    <span
      className="mono shrink-0 tracking-tight"
      style={{ color: score <= 2 ? 'var(--rose)' : score >= 4 ? 'var(--add-gutter)' : 'var(--muted)' }}
      title={`Overall quality ${score}/5 — 3 is ordinary competent code`}
    >
      {'\u25cf'.repeat(score)}{'\u25cb'.repeat(5 - score)}
    </span>
  );
}

/**
 * The natural-language overlay: what this change does, and how good it is.
 *
 * Routine changes collapse to one dim line. That is the whole point: a diff is
 * mostly renames and imports, and an overlay that gives those the same weight
 * as a behaviour change is one that gets ignored wholesale. Nothing is hidden —
 * a collapsed note opens on click — it just stops competing with the code.
 */
function NarrationCard({ hunkId }: { hunkId: string }) {
  const n = useReview((s) => s.narrations[hunkId]);
  const state = useReview((s) => s.unitStates[hunkId] ?? 'unreviewed');
  const filter = useReview((s) => s.noteFilter);
  const expanded = useReview((s) => Boolean(s.expandedNotes[hunkId]));
  const toggle = useReview((s) => s.toggleNote);
  // Nothing here while a file is still being annotated — its header says so
  // once, for the whole file.
  if (!n) return null;

  const done = state === 'reviewed' || state === 'skimmed';
  const axes = n.axes ?? [];
  const isProblem = n.score <= 2 || axes.some((a) => a.rating === 'weak');

  if (filter === 'problems' && !isProblem) return null;

  // Reviewed work recedes the same way routine work does, for the same reason.
  const shouldCollapse =
    !expanded && (done || (filter !== 'all' && n.significance === 'routine'));

  if (shouldCollapse) {
    return (
      <button
        onClick={() => toggle(hunkId)}
        className="note-routine"
        title="Open this annotation"
      >
        <span className="shrink-0">{'\u203a'}</span>
        <span className="shrink-0">{n.significance}</span>
        <span className="truncate">{n.what}</span>
        {isProblem && <span style={{ color: 'var(--amber)' }}>{'\u26a0'}</span>}
      </button>
    );
  }

  const conventionNotes = axes.filter((a) => a.axis === 'conventions');
  const otherNotes = axes.filter((a) => a.axis !== 'conventions');

  return (
    <div className={`note ${done ? 'is-done' : ''}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <ScoreDots score={n.score} />
        <span className="note-label" style={{ margin: 0 }}>{n.significance}</span>
        {(n.significance === 'routine' || expanded) && (
          <button onClick={() => toggle(hunkId)} className="muted ml-auto text-[10px]">
            collapse
          </button>
        )}
      </div>

      <p>{n.what}</p>

      {/* Conventions first and marked: a house rule is the one judgement here
          that is checkable rather than a matter of taste. */}
      {conventionNotes.map((a, i) => (
        <div key={`c${i}`} className="note-convention">
          <span style={{ color: 'var(--amber)' }}>{'\u26a0'} {a.source}</span>
          {a.rule && <em className="block opacity-80">{'\u201c'}{a.rule}{'\u201d'}</em>}
          <span>{a.reason}</span>
        </div>
      ))}

      {otherNotes.map((a, i) => (
        <p key={`a${i}`} className="mt-1.5">
          <span className="note-label" style={{ display: 'inline', color: RATING_COLOR[a.rating] }}>
            {AXIS_LABEL[a.axis]} {a.rating}
          </span>{' '}
          <span className="muted">{a.reason}</span>
        </p>
      ))}

      {n.why && (
        <>
          <span className="note-label mt-2">Why</span>
          <p className="muted">{n.why}</p>
        </>
      )}
      {n.watchFor && (
        <>
          <span className="note-label mt-2" style={{ color: 'var(--amber)' }}>Watch for</span>
          <p style={{ color: 'var(--amber)' }}>{n.watchFor}</p>
        </>
      )}
    </div>
  );
}

/**
 * Who wrote this file, and what they were asked to do.
 *
 * The chip is the answer to "I have no idea where this came from" — the
 * specific thing that goes missing when several agents work in parallel across
 * worktrees and you return to the diff days later.
 */
function ProvenanceChip({ path }: { path: string }) {
  const entries = useReview((s) => s.provenance[path]);
  const open = useReview((s) => s.openProvenanceFile === path);
  const toggle = useReview((s) => s.toggleProvenance);
  if (!entries?.length) return null;

  const e = entries[0];
  const when = new Date(e.timestamp);
  const label = e.threadName ?? e.prompt?.replace(/\s+/g, ' ').slice(0, 42) ?? e.sessionId.slice(0, 8);

  return (
    <div className="relative">
      <button
        onClick={() => toggle(path)}
        className="max-w-[260px] truncate rounded px-1.5 py-0.5 text-[10px]"
        style={{
          background: 'var(--raised)',
          color: e.agent === 'codex' ? 'var(--violet)' : 'var(--teal)',
        }}
        title="Which session wrote this, and the prompt behind it"
      >
        {e.agent} · {label}
      </button>
      {open && (
        <div
          className="absolute right-0 top-[26px] z-30 w-[420px] rounded border p-3 text-[11px] shadow-lg"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          {entries.map((entry, i) => (
            <div key={i} className={i > 0 ? 'mt-3 border-t pt-3' : ''} style={{ borderColor: 'var(--line)' }}>
              <div className="muted mb-1 flex items-center gap-2 text-[10px]">
                <span style={{ color: entry.agent === 'codex' ? 'var(--violet)' : 'var(--teal)' }}>
                  {entry.agent}
                </span>
                {entry.threadName && <span>"{entry.threadName}"</span>}
                <span>{new Date(entry.timestamp).toLocaleString()}</span>
              </div>
              {entry.prompt ? (
                <p className="leading-relaxed">{entry.prompt.slice(0, 600)}</p>
              ) : (
                <p className="muted">No prompt recorded for this edit.</p>
              )}
              <p className="muted mono mt-1 truncate text-[10px]">{entry.cwd}</p>
            </div>
          ))}
          <p className="muted mt-2 text-[10px]">
            From agent session transcripts, not git history. {when.toLocaleDateString()}
          </p>
        </div>
      )}
    </div>
  );
}

function Chip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="rounded px-1 py-[1px] text-[9px] uppercase tracking-wide"
      style={{ background: 'var(--raised)', color }}
    >
      {children}
    </span>
  );
}

function StatusDot({ status }: { status: StreamFile['file']['status'] }) {
  const color =
    status === 'added' ? 'var(--add-gutter)'
    : status === 'deleted' ? 'var(--del-gutter)'
    : status === 'renamed' ? 'var(--violet)'
    : 'var(--muted)';
  return <span className="mono text-[10px] uppercase" style={{ color }} title={status}>{status[0]}</span>;
}
