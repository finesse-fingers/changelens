/**
 * What one annotation shard is allowed to spend before it is aborted.
 *
 * This is a runaway guard, not a price list — nothing surfaces it to the
 * reviewer. It exists because a shard that loops costs real money, and it is
 * scaled by model because a cap that every shard exceeds is worse than no cap
 * at all: the run aborts mid-analysis with no structured output, so the whole
 * thing is paid for and the file is left un-annotated.
 */

/**
 * Ceiling for one shard at sonnet, measured. A 30-line file in a repo with a
 * nested conventions chain came to $0.44; the chain and the surrounding-file
 * reads do not shrink with the diff, so this is close to the floor rather than
 * a generous allowance.
 */
export const SHARD_BUDGET_USD = 0.75;

/**
 * Spend relative to sonnet, from list pricing: opus is $15/$75 per Mtok
 * against sonnet's $3/$15, the same 5× on input and output. An unknown model
 * is assumed to match sonnet, because guessing low re-creates the abort bug
 * this scaling exists to prevent.
 */
export const MODEL_COST_FACTOR: Record<string, number> = { sonnet: 1, opus: 5 };

export function modelFactor(model: string | undefined): number {
  return MODEL_COST_FACTOR[model ?? 'sonnet'] ?? 1;
}

/** The cap for one shard, scaled so a pricier model is not capped into failing. */
export function shardBudgetUsd(model: string | undefined): number {
  return SHARD_BUDGET_USD * modelFactor(model);
}
