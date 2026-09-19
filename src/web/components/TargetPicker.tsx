import { useEffect, useState } from 'react';
import {
  api,
  type PrGroup,
  type PrLists,
  type RecentRepo,
  type RepoInspect,
  type SnapshotResponse,
} from '../store/api.js';
import { relativeAge } from '../../shared/prlist.js';
import { useReview } from '../store/review.js';

/**
 * Nothing runs until the user has seen exactly what will be reviewed.
 *
 * The resolved base, the head, and how the base was derived are all shown
 * before any work starts, because a comparison against the wrong base produces
 * a confidently wrong review.
 */
export function TargetPicker({ onLoaded }: { onLoaded: () => void }) {
  const load = useReview((s) => s.load);
  const [recents, setRecents] = useState<RecentRepo[]>([]);
  const [path, setPath] = useState('');
  const [inspect, setInspect] = useState<RepoInspect | null>(null);
  const [mode, setMode] = useState<'local' | 'pr'>('local');
  const [prRef, setPrRef] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [preview, setPreview] = useState<SnapshotResponse | null>(null);
  const [prs, setPrs] = useState<PrLists | null>(null);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prsError, setPrsError] = useState<{ message: string; hint?: string } | null>(null);
  const [prsAttempt, setPrsAttempt] = useState(0);
  const [recentsError, setRecentsError] = useState<string | null>(null);

  useEffect(() => {
    // A failed request and an empty history are different answers, and the
    // difference matters most on the very first screen: swallowing the error
    // into `[]` makes a server that is not running look exactly like a machine
    // with no agent history, and the user has no reason to suspect otherwise.
    api.recentRepos()
      .then((r) => { setRecents(r.repos); setRecentsError(null); })
      .catch((e: unknown) => {
        setRecents([]);
        setRecentsError(e instanceof Error ? e.message : 'Could not reach the Changelens server.');
      });
  }, []);

  // Asked for only when the PR tab is open, and only once per repo: the
  // landing screen should not pay two network round trips for a list most
  // visits never look at.
  const root = inspect?.root;
  useEffect(() => {
    if (mode !== 'pr' || !root) return;
    let cancelled = false;
    setPrsLoading(true);
    setPrsError(null);
    api
      .listPrs(root)
      // The repo can change while this is in flight, and landing one repo's
      // PRs under another's name would be worse than showing none.
      .then((r) => { if (!cancelled) setPrs(r); })
      .catch((e: Error & { hint?: string }) => {
        if (!cancelled) setPrsError({ message: e.message, hint: e.hint });
      })
      .finally(() => { if (!cancelled) setPrsLoading(false); });
    return () => { cancelled = true; };
  }, [mode, root, prsAttempt]);

  async function choose(p: string) {
    setError(null);
    setPreview(null);
    setPath(p);
    setInspecting(true);
    setPrs(null);
    setPrsError(null);
    try {
      const info = await api.inspectRepo(p);
      setInspect(info);
      setBaseRef('');
      // Cleared, not merely set: leaving the previous repo's number here meant
      // picking a repo with no current-branch PR silently kept the old one, and
      // "Resolve snapshot" would then resolve THIS repo's PR of that number.
      setPrRef(info.pr ? String(info.pr.number) : '');
    } catch (e) {
      setInspect(null);
      setError({ message: (e as Error).message, hint: (e as Error & { hint?: string }).hint });
    } finally {
      setInspecting(false);
    }
  }

  async function resolve() {
    if (!inspect) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.snapshot(
        mode === 'pr'
          ? { kind: 'pr', repoRoot: inspect.root, prRef }
          : {
              kind: 'local',
              repoRoot: inspect.root,
              baseRef: baseRef || undefined,
              includeUntracked,
            },
      );
      setPreview(res);
    } catch (e) {
      setError({ message: (e as Error).message, hint: (e as Error & { hint?: string }).hint });
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (!preview) return;
    load(preview);
    onLoaded();
  }

  return (
    <div className="h-full overflow-auto" style={{ background: 'var(--paper)' }}>
      <div className="mx-auto max-w-3xl px-8 py-14">
        <header className="mb-10">
          <h1 className="text-[22px] font-semibold tracking-tight">Changelens</h1>
          <p className="muted mt-1 text-[13px]">
            Review what you're accepting — not every file touched.
          </p>
        </header>

        <Section n={1} title="Repository">
          {recentsError !== null && (
            <p
              className="mb-3 rounded-md border px-3 py-2 text-[12px]"
              style={{ borderColor: 'var(--rose)', background: 'var(--panel)' }}
            >
              Could not load recent repositories. {recentsError}
              <span className="muted block">
                Is the server running? <span className="mono">pnpm dev</span> starts both halves.
              </span>
            </p>
          )}
          {recentsError === null && recents.length === 0 && (
            <p className="muted mb-3 text-[12px] leading-relaxed">
              No recent repositories found. This list is built from your Claude Code and
              Codex session history, so it is empty until you have used one of them — or if
              they ran somewhere this machine cannot see, like a container or a remote host.
              <span className="block">Paste a repository path below to get started.</span>
            </p>
          )}
          {recents.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {recents.map((r) => (
                <button
                  key={r.path}
                  onClick={() => choose(r.path)}
                  className="rounded-md border px-3 py-2 text-left transition hover:opacity-80"
                  style={{
                    borderColor: path === r.path ? 'var(--accent)' : 'var(--line)',
                    background: 'var(--panel)',
                  }}
                >
                  <div className="text-[13px] font-medium">{r.name}</div>
                  <div className="muted mono text-[11px]">
                    {r.branch ?? 'detached'} · {r.agents.join('+')}
                    {r.worktrees && r.worktrees > 1 ? ` · ${r.worktrees} worktrees` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={(e) => e.target.value && choose(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && choose((e.target as HTMLInputElement).value)}
            placeholder="/path/to/repo"
            spellCheck={false}
            className="mono w-full rounded-md border px-3 py-2 text-[12px] outline-none"
            style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
          />
        </Section>

        {inspecting && (
          <p className="muted mb-8 text-[12px]">Reading repository and checking for a pull request…</p>
        )}

        {inspect && !inspecting && (
          <Section n={2} title="What to review">
            <div className="mb-3 flex gap-2">
              <Toggle active={mode === 'local'} onClick={() => setMode('local')}>
                Local branch
              </Toggle>
              <Toggle active={mode === 'pr'} onClick={() => setMode('pr')}>
                Pull request
              </Toggle>
            </div>

            {mode === 'local' ? (
              <div className="space-y-2">
                <label className="muted block text-[11px] uppercase tracking-wide">
                  Base (blank = discover, never assume main)
                </label>
                <input
                  list="branches"
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  placeholder="auto: merge-base against origin/HEAD"
                  spellCheck={false}
                  className="mono w-full rounded-md border px-3 py-2 text-[12px] outline-none"
                  style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
                />
                <datalist id="branches">
                  {inspect.branches.map((b) => <option key={b} value={b} />)}
                </datalist>
                {inspect.dirty && (
                  <label className="flex items-center gap-2 pt-1 text-[12px]">
                    <input
                      type="checkbox"
                      checked={includeUntracked}
                      onChange={(e) => setIncludeUntracked(e.target.checked)}
                    />
                    Include untracked files
                    <span className="muted">— working tree is dirty</span>
                  </label>
                )}
              </div>
            ) : (
              <div>
                <PrQuickSelect
                  prs={prs}
                  loading={prsLoading}
                  error={prsError}
                  selected={prRef}
                  onPick={(n) => setPrRef(String(n))}
                  onRetry={() => setPrsAttempt((n) => n + 1)}
                />
                <input
                  value={prRef}
                  onChange={(e) => setPrRef(e.target.value)}
                  placeholder="1234, #1234, or a full PR URL"
                  spellCheck={false}
                  className="mono w-full rounded-md border px-3 py-2 text-[12px] outline-none"
                  style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
                />
                {inspect.pr && (
                  <p className="muted mt-2 text-[12px]">
                    This branch has PR #{inspect.pr.number}: {inspect.pr.title}
                  </p>
                )}
              </div>
            )}

            <button
              onClick={resolve}
              disabled={busy}
              className="mt-4 rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--paper)' }}
            >
              {busy ? 'Resolving…' : 'Resolve snapshot'}
            </button>
          </Section>
        )}

        {error && (
          <div
            className="mt-4 rounded-md border px-4 py-3 text-[12px]"
            style={{ borderColor: 'var(--rose)', background: 'var(--panel)' }}
          >
            <div style={{ color: 'var(--rose)' }}>{error.message}</div>
            {error.hint && <div className="muted mt-1">{error.hint}</div>}
          </div>
        )}

        {preview && (
          <Section n={3} title="Evidence snapshot">
            <div
              className="rounded-md border p-4"
              style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
            >
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-[12px]">
                <Row label="Comparison">
                  <span className="mono">
                    {preview.snapshot.baseRef} … {preview.snapshot.headRef}
                  </span>
                </Row>
                <Row label="Base resolved by">
                  <span className="mono">{preview.snapshot.baseResolution}</span>
                </Row>
                <Row label="Base / head">
                  <span className="mono">
                    {preview.snapshot.baseSha.slice(0, 10)} … {preview.snapshot.headSha.slice(0, 10)}
                  </span>
                </Row>
                <Row label="Working tree">
                  <span className="mono">
                    {preview.snapshot.dirtyDigest
                      ? `dirty (${preview.snapshot.dirtyDigest.slice(0, 8)})`
                      : 'clean'}
                  </span>
                </Row>
                <Row label="Scope">
                  {preview.summary.reviewable} to review
                  {preview.summary.digest > 0 && `, ${preview.summary.digest} digested`}
                  {preview.summary.excluded > 0 && `, ${preview.summary.excluded} skipped as noise`}
                  {' · '}
                  <span style={{ color: 'var(--add-gutter)' }}>+{preview.snapshot.stats.additions}</span>{' '}
                  <span style={{ color: 'var(--del-gutter)' }}>−{preview.snapshot.stats.deletions}</span>
                </Row>
                <Row label="Review units">{preview.summary.units}</Row>
              </dl>

              {preview.summary.units === 0 && (
                <p className="mt-3 text-[12px]" style={{ color: 'var(--amber)' }}>
                  This comparison is empty. That is not the same as "clean" — check the base is right.
                </p>
              )}

              <button
                onClick={start}
                disabled={preview.summary.units === 0}
                className="mt-4 rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'var(--paper)' }}
              >
                Start review →
              </button>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * The PRs waiting on you, one click from resolved.
 *
 * A quick-select, not a replacement for the input below it: a PR that is
 * neither yours nor assigned to you is still reachable by typing its number.
 *
 * The four states are kept distinct on purpose. "No open PRs" and "GitHub
 * could not be asked" look identical if a failure collapses into an empty
 * list, and the empty list is the more believable of the two — so a failure
 * would be quietly believed.
 */
function PrQuickSelect({
  prs, loading, error, selected, onPick, onRetry,
}: {
  prs: PrLists | null;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  selected: string;
  onPick: (n: number) => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <p className="muted mb-3 text-[12px]">
        <span className="inline-block animate-pulse">Asking GitHub…</span>
      </p>
    );
  }

  if (error) {
    return (
      <div className="mb-3 text-[12px]">
        <div style={{ color: 'var(--rose)' }}>{error.message}</div>
        {error.hint && <div className="muted mt-1">{error.hint}</div>}
        <button
          onClick={onRetry}
          className="muted mt-1 text-[12px] underline-offset-2 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!prs) return null;

  const failures = [prs.mine.error, prs.reviewing.error].filter(Boolean) as NonNullable<
    PrGroup['error']
  >[];
  const empty = prs.mine.prs.length === 0 && prs.reviewing.prs.length === 0;

  // Both queries usually fail for the same reason — no remote, no auth — and
  // saying it twice reads as a malfunction.
  const bothFailedAlike =
    failures.length === 2 && failures[0].message === failures[1].message;

  return (
    <div className="mb-3 space-y-3">
      {bothFailedAlike ? (
        <Failure error={failures[0]} onRetry={onRetry} />
      ) : (
        <>
          <PrGroupView
            label="Yours"
            group={prs.mine}
            selected={selected}
            onPick={onPick}
            onRetry={onRetry}
            showAuthor={false}
          />
          <PrGroupView
            label="Awaiting your review"
            group={prs.reviewing}
            selected={selected}
            onPick={onPick}
            onRetry={onRetry}
            showAuthor
          />
        </>
      )}
      {empty && failures.length === 0 && (
        <p className="muted text-[12px]">
          No open pull requests you authored or were asked to review.
        </p>
      )}
    </div>
  );
}

/** A reason the list is missing, with a way to ask again. Never an empty list. */
function Failure({
  error, onRetry,
}: {
  error: NonNullable<PrGroup['error']>;
  onRetry: () => void;
}) {
  return (
    <div className="text-[12px]">
      <div style={{ color: 'var(--rose)' }}>{error.message}</div>
      {error.hint && <div className="muted mt-1">{error.hint}</div>}
      <button
        onClick={onRetry}
        className="muted mt-1 text-[12px] underline-offset-2 hover:underline"
      >
        Try again
      </button>
    </div>
  );
}

/** One labelled row of cards. An empty, successful group renders nothing. */
function PrGroupView({
  label, group, selected, onPick, onRetry, showAuthor,
}: {
  label: string;
  group: PrGroup;
  selected: string;
  onPick: (n: number) => void;
  onRetry: () => void;
  showAuthor: boolean;
}) {
  if (group.prs.length === 0 && !group.error) return null;
  return (
    <div>
      <div className="muted mb-1.5 text-[11px] uppercase tracking-wide">{label}</div>
      {group.error && <Failure error={group.error} onRetry={onRetry} />}
      <div className="flex flex-wrap gap-2">
        {group.prs.map((pr) => {
          const isSelected = selected.trim().replace(/^#/, '') === String(pr.number);
          return (
            <button
              key={pr.number}
              onClick={() => onPick(pr.number)}
              title={pr.title}
              className="max-w-full rounded-md border px-3 py-2 text-left transition hover:opacity-80"
              style={{
                borderColor: isSelected ? 'var(--accent)' : 'var(--line)',
                background: 'var(--panel)',
              }}
            >
              <div className="truncate text-[13px] font-medium">
                <span className="mono" style={{ color: 'var(--muted)' }}>#{pr.number}</span>{' '}
                {pr.title}
              </div>
              <div className="muted mono truncate text-[11px]">
                {[
                  pr.headRefName,
                  showAuthor ? `@${pr.author}` : null,
                  pr.isDraft ? 'draft' : null,
                  relativeAge(pr.updatedAt),
                ].filter(Boolean).join(' · ')}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide">
        <span
          className="mono flex h-5 w-5 items-center justify-center rounded-full text-[10px]"
          style={{ background: 'var(--raised)', color: 'var(--muted)' }}
        >
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border px-3 py-1.5 text-[12px] transition"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--line)',
        color: active ? 'var(--accent)' : 'var(--muted)',
        background: 'var(--panel)',
      }}
    >
      {children}
    </button>
  );
}
