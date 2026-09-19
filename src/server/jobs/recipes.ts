/**
 * What `/code-review` actually runs for a given model and effort.
 *
 * Extracted from the shipped 2.1.274 binary's routing table. It matters
 * because the mapping is not monotonic: opus-5 at `xhigh` runs ten inline
 * angles with NO verify pass (so findings carry no verdict), while the same
 * model at `max` does verify, and sonnet-5 verifies from `medium` up.
 *
 * Surfaced in the UI rather than baked into a default, so the choice is the
 * reviewer's and its consequences are visible.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Recipe {
  tag: string;
  verifies: boolean;
  cap: number;
  sweep: boolean;
}

const RECIPES: Record<string, Recipe> = {
  low: { tag: '1 diff pass → no verify → ≤4 findings', verifies: false, cap: 4, sweep: false },
  'low-sonnet5': { tag: '1 diff pass → no verify', verifies: false, cap: 4, sweep: false },
  medium: { tag: '3+5 angles × 6 candidates → 1-vote verify → ≤8', verifies: true, cap: 8, sweep: false },
  high: { tag: '3+5 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10', verifies: true, cap: 10, sweep: false },
  xhigh: { tag: '5+5 angles × 8 candidates → 1-vote verify → sweep → ≤15', verifies: true, cap: 15, sweep: true },
  max: { tag: '5+5 angles × 8 candidates → 1-vote verify → sweep → ≤15', verifies: true, cap: 15, sweep: true },
  'o48-med-v1': { tag: '8 inline angles → dedup (no verify) → ≤8', verifies: false, cap: 8, sweep: false },
  'o48-high-v1': { tag: '8 inline angles → dedup (no verify) → ≤10', verifies: false, cap: 10, sweep: false },
  'o48-xhigh-v1': { tag: '10 inline angles → dedup (no verify) → sweep → ≤15', verifies: false, cap: 15, sweep: true },
  'o5-bmin': { tag: 'minimal prompt → single careful diff pass → ≤15', verifies: false, cap: 15, sweep: false },
};

const OPUS5: Record<Effort, string> = {
  low: 'low', medium: 'o5-bmin', high: 'o5-bmin', xhigh: 'o48-xhigh-v1', max: 'max',
};
const OPUS48: Record<Effort, string> = {
  low: 'o48-low-v1', medium: 'o48-med-v1', high: 'o48-high-v1', xhigh: 'o48-xhigh-v1', max: 'max',
};
const SONNET5: Record<Effort, string> = {
  low: 'low-sonnet5', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};
const DEFAULT: Record<Effort, string> = { ...OPUS5, high: 'o48-high-v1' };

function family(model: string | undefined): Record<Effort, string> {
  if (!model) return DEFAULT;
  const m = model.toLowerCase();
  if (m.includes('sonnet')) return SONNET5;
  if (m.includes('opus-4-8') || m.includes('opus-4.8')) return OPUS48;
  if (m.includes('opus')) return OPUS5;
  return DEFAULT;
}

export function recipeFor(model: string | undefined, effort: Effort): Recipe {
  const cell = family(model)[effort];
  return RECIPES[cell] ?? { tag: cell, verifies: false, cap: 15, sweep: false };
}

export const MODELS = ['sonnet', 'opus'] as const;
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The whole matrix, for the run dialog. */
export function recipeMatrix(): { model: string; effort: Effort; recipe: Recipe }[] {
  return MODELS.flatMap((model) => EFFORTS.map((effort) => ({ model, effort, recipe: recipeFor(model, effort) })));
}
