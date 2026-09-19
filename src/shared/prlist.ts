/**
 * Shaping the two PR queries into the two lists the picker renders.
 *
 * Pure and shared: the server produces these lists and the client renders
 * them, and the one rule that matters — a PR you authored *and* were asked to
 * review belongs in one list, not both — is easier to trust with a test beside
 * it than to re-derive on either side.
 */

export interface PrSummary {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  author: string;
  /** ISO 8601, straight from `gh`. */
  updatedAt: string;
}

/**
 * One group's outcome.
 *
 * `error` present means the query failed and `prs` is empty because nothing was
 * learned — not because there is nothing. Collapsing those two into a bare
 * array is the mistake this whole feature is built to avoid.
 */
export interface PrGroup {
  prs: PrSummary[];
  error?: { message: string; hint?: string };
}

export interface PrLists {
  /** Open PRs the user authored. */
  mine: PrGroup;
  /** Open PRs where the user is a requested reviewer. */
  reviewing: PrGroup;
}

/**
 * Newest first, and never the same PR twice.
 *
 * Authorship wins the tie: being asked to review your own PR is a quirk of how
 * some teams use review requests, and "Yours" is the truer label for it.
 */
export function mergePrLists(
  mine: PrSummary[],
  reviewing: PrSummary[],
): { mine: PrSummary[]; reviewing: PrSummary[] } {
  const authored = new Set(mine.map((p) => p.number));
  return {
    mine: byNewest(mine),
    reviewing: byNewest(reviewing.filter((p) => !authored.has(p.number))),
  };
}

/** Copies before sorting: the caller's array is theirs, not ours to reorder. */
function byNewest(prs: PrSummary[]): PrSummary[] {
  return prs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * How long ago, in the space a card sub-line has.
 *
 * A PR list is scanned for "what is still open and how stale is it", which an
 * absolute date answers badly — nobody converts 2026-09-17 into "yesterday" at
 * a glance.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
