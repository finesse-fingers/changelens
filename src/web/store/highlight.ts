/**
 * Syntax highlighting for diff rows.
 *
 * The one file that touches Shiki, so the diff stays a renderer. Everything
 * here is best-effort: any failure — an unknown language, a grammar that will
 * not load, a tokenizer result that does not line up — leaves the rows exactly
 * as they render without it, in plain `--ink`. Nothing throws.
 *
 * Colours come back as the literal strings `var(--shiki-token-keyword)` and so
 * on, because the highlighter is built with Shiki's css-variables theme rather
 * than a real editor theme. Those variables are defined in `theme.css` in terms
 * of the app's own palette, which is what keeps a diff looking like this app and
 * not like VS Code — and it means switching between the dark and paper themes
 * recolours instantly, without re-tokenizing anything, since the `color` string
 * itself never changes.
 *
 * Accuracy has one known limit. A hunk is tokenized on its own, so a hunk that
 * *starts* already inside a block comment has no opener to see and renders as
 * code. Git gives three lines of context, so that needs an edit buried deep in a
 * long comment. Fixing it properly means Shiki's `grammarState`, which needs the
 * file text above the hunk — i.e. fetching whole files, which this deliberately
 * does not do.
 */
import { useEffect, useState } from 'react';
import type { Hunk } from '../../shared/types.js';
import { mapHunkSides } from '../../shared/hunk-sides.js';

/** Structural, so nothing outside this file depends on Shiki's types. */
export interface CodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

/** One entry per line of a hunk, aligned to `hunk.lines`. */
export type HunkTokens = (CodeToken[] | null)[];

/** The name `createCssVariablesTheme()` registers itself under. */
const THEME = 'css-variables';

async function createHighlighter() {
  const { createHighlighterCore, createCssVariablesTheme } = await import('shiki/core');
  const { createOnigurumaEngine } = await import('shiki/engine/oniguruma');
  return createHighlighterCore({
    themes: [createCssVariablesTheme()],
    // Loaded on demand instead: see `loadLanguage`.
    langs: [],
    // The WASM engine over the pure-JS one, measured on this repo: 1.6ms vs
    // 12.5ms for a twelve-line hunk, which is the real unit of work here. The
    // wasm is base64-inlined, so it is an ordinary lazy chunk with no separate
    // asset for the built server to have to serve.
    engine: createOnigurumaEngine(import('shiki/wasm')),
  });
}

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighter: Promise<Highlighter> | null = null;
const getHighlighter = () => (highlighter ??= createHighlighter());

/** id → whether its grammar is usable. Attempted at most once per language. */
const languages = new Map<string, Promise<boolean>>();

function loadLanguage(hl: Highlighter, id: string): Promise<boolean> {
  let loading = languages.get(id);
  if (loading) return loading;

  loading = (async () => {
    const { bundledLanguages } = await import('shiki/langs');
    // `languageOf` already emits Shiki ids, but it is a hand-written map and
    // this is data from the server: check rather than trust.
    if (!(id in bundledLanguages)) return false;
    try {
      await hl.loadLanguage(await bundledLanguages[id as keyof typeof bundledLanguages]());
      // Compile the grammar's patterns now, on one character. That work happens
      // inside the first real `codeToTokensBase` otherwise — ~170ms, synchronous,
      // and charged at random to whichever hunk got there first, blowing through
      // an idle deadline no matter how small the hunk was. Same total cost, paid
      // somewhere predictable.
      hl.codeToTokensBase('a', { lang: id, theme: THEME });
      return true;
    } catch {
      return false;
    }
  })();

  languages.set(id, loading);
  return loading;
}

async function tokenize(hunk: Hunk, language: string): Promise<HunkTokens | null> {
  try {
    const hl = await getHighlighter();
    if (!(await loadLanguage(hl, language))) return null;
    return mapHunkSides<CodeToken[]>(hunk.lines, (code, lineCount) => {
      const rows = hl.codeToTokensBase(code, { lang: language, theme: THEME });
      return rows.length === lineCount ? rows : null;
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Module-level, following `derive.ts`'s `streamCache`: a `useMemo` would be
 * per-component-instance and so would re-tokenize on every remount.
 *
 * Keyed on the hunk *object*, not on `hunk.id`. Ids are `path@index`, which is
 * unique within a snapshot and repeats across them — every PR has a
 * `src/foo.ts@0` — so a string key would serve the previous target's colours
 * against the current text. Identity is snapshot-scoped by construction, and it
 * makes the cache self-bounding: the old diff's entries become collectable the
 * moment the store drops it.
 */
const cache = new WeakMap<Hunk, HunkTokens>();

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * One hunk at a time, between idle callbacks.
 *
 * A hunk costs ~1.6ms, which is nothing until a large diff has a thousand of
 * them and the page locks up for two seconds before showing anything. Draining
 * one at a time in document order means the diff paints in plain text
 * immediately and colour fills in from the top — the same progressive behaviour
 * the annotation margin already has.
 */
type Task = () => Promise<void>;

const pending: Task[] = [];
let busy = false;

const whenIdle: (run: () => void) => void =
  typeof requestIdleCallback === 'function'
    // A background tab is never idle, so without the timeout a diff left in one
    // would come back still plain.
    ? (run) => void requestIdleCallback(() => run(), { timeout: 500 })
    : (run) => void setTimeout(run, 0);

function pump() {
  if (busy) return;
  const task = pending.shift();
  if (!task) return;
  busy = true;
  whenIdle(() => {
    void task().finally(() => {
      busy = false;
      pump();
    });
  });
}

/** Returns a cancel that drops the task if it has not started. */
function enqueue(task: Task): () => void {
  pending.push(task);
  pump();
  return () => {
    const at = pending.indexOf(task);
    if (at >= 0) pending.splice(at, 1);
  };
}

// ---------------------------------------------------------------------------

/**
 * Tokens for one hunk, or null while there are none.
 *
 * Cancelling on unmount is what keeps switching PRs cheap: every row of the old
 * diff unmounts at once, taking its queued work with it rather than leaving the
 * browser tokenizing a thousand hunks nobody is looking at.
 */
export function useHunkTokens(hunk: Hunk, language: string | undefined): HunkTokens | null {
  const [tokens, setTokens] = useState<HunkTokens | null>(() => cache.get(hunk) ?? null);

  useEffect(() => {
    const known = cache.get(hunk) ?? null;
    // Also clears stale tokens when this component moves to a different hunk.
    setTokens(known);
    if (!language || known) return;

    let live = true;
    const cancel = enqueue(async () => {
      const result = await tokenize(hunk, language);
      if (!result) return;
      cache.set(hunk, result);
      if (live) setTokens(result);
    });
    return () => {
      live = false;
      cancel();
    };
  }, [hunk, language]);

  return tokens;
}
