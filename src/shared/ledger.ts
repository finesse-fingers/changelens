import type { Disposition, FindingVerdict } from './types.js';

/**
 * Only what the table needs.
 *
 * The server and the client each keep their own `Finding` shape, and this has
 * to work with both — asking for the union of the two would couple the export
 * to fields it never prints.
 */
export interface LedgerFinding {
  id: string;
  rank: number;
  file: string;
  line?: number;
  summary: string;
  shortSummary?: string;
  failureScenario: string;
  verdict?: FindingVerdict;
}

/**
 * The handoff artifact: a review's triage table as markdown.
 *
 * Pure so it can be tested. The table is what leaves the tool — pasted into a
 * PR, a doc or a message — so its correctness matters more than anything on
 * screen, and it is the one thing a reader cannot check against the app.
 */
export interface LedgerSnapshot {
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  kind: string;
  prNumber?: number;
}

/**
 * The handoff artifact.
 *
 * Carries the evidence snapshot with it: a triage decision only means anything
 * against the exact base and head it was made on, and a table pasted into a PR
 * without them invites someone to act on a stale call.
 */
export function renderLedger(
  findings: LedgerFinding[],
  dispositions: Record<string, Disposition>,
  snap: LedgerSnapshot | undefined,
  meta: { recipe: { tag: string; verifies: boolean } } | null,
): string {
  const lines: string[] = ['# Review ledger', ''];
  if (snap) {
    lines.push(
      `**Target.** ${snap.kind === 'pr' ? `PR #${snap.prNumber}` : snap.headRef} vs ${snap.baseRef}`,
      `**Evidence.** \`${snap.baseSha.slice(0, 10)}\`…\`${snap.headSha.slice(0, 10)}\``,
    );
  }
  if (meta) {
    lines.push(`**Recipe.** ${meta.recipe.tag}${meta.recipe.verifies ? '' : ' — no verify pass, findings are unverified'}`);
  }
  lines.push('', `${findings.filter((f) => dispositions[f.id]).length}/${findings.length} triaged.`, '');
  lines.push('| # | Anchor | Claim | Verdict | Disposition |', '|---|---|---|---|---|');
  for (const f of findings) {
    const anchor = `${f.file}${f.line !== undefined ? `:${f.line}` : ''}`;
    const claim = (f.shortSummary ?? f.summary).replace(/\|/g, '\\|');
    lines.push(`| ${f.rank + 1} | \`${anchor}\` | ${claim} | ${f.verdict ?? '—'} | ${dispositions[f.id] ?? '—'} |`);
  }

  const detailed = findings.filter((f) => dispositions[f.id] === 'fix' || dispositions[f.id] === 'blocked');
  if (detailed.length > 0) {
    lines.push('', '## Needs work', '');
    for (const f of detailed) {
      lines.push(`### #${f.rank + 1} — ${f.shortSummary ?? f.summary}`, '', `\`${f.file}${f.line !== undefined ? `:${f.line}` : ''}\``, '', f.summary, '', `**How it fails.** ${f.failureScenario}`, '');
    }
  }
  return lines.join('\n');
}
