import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLedger, type LedgerFinding, type LedgerSnapshot } from './ledger.js';
import type { Disposition } from './types.js';

const snap: LedgerSnapshot = {
  baseSha: '67f2f3be5d1122', headSha: '2716ec97b7aa44',
  baseRef: 'origin/main', headRef: 'fix/usage', kind: 'pr', prNumber: 315,
};

const finding = (p: Partial<LedgerFinding> & { id: string; rank: number }): LedgerFinding => ({
  file: 'src/a.ts',
  summary: 'A thing is wrong.',
  failureScenario: 'It breaks when x.',

  ...p,
});

test('the export carries the evidence snapshot with it', () => {
  // A triage call only means anything against the base and head it was made
  // on. A table pasted into a PR without them invites someone to act on a
  // stale decision.
  const md = renderLedger([finding({ id: 'a', rank: 0 })], {}, snap, null);
  assert.match(md, /PR #315 vs origin\/main/);
  assert.match(md, /67f2f3be5d/);
  assert.match(md, /2716ec97b7/);
});

test('an unverified recipe says so in the artifact, not just in the UI', () => {
  const md = renderLedger([finding({ id: 'a', rank: 0 })], {}, snap, {
    recipe: { tag: '10 inline angles → dedup (no verify)', verifies: false },
  });
  assert.match(md, /no verify pass, findings are unverified/);
});

test('rows keep reported order and show their disposition', () => {
  const findings = [
    finding({ id: 'a', rank: 0, shortSummary: 'First', line: 12 }),
    finding({ id: 'b', rank: 1, shortSummary: 'Second', file: 'src/b.ts' }),
    finding({ id: 'c', rank: 2, shortSummary: 'Third' }),
  ];
  const d: Record<string, Disposition> = { a: 'fix', c: 'reject' };
  const md = renderLedger(findings, d, snap, null);
  assert.ok(md.indexOf('First') < md.indexOf('Second'), 'rank order is preserved');
  assert.match(md, /\| 1 \| `src\/a\.ts:12` \| First \| — \| fix \|/);
  assert.match(md, /\| 2 \| `src\/b\.ts` \| Second \| — \| — \|/, 'a finding with no line has no :line suffix');
  assert.match(md, /2\/3 triaged/);
});

test('a pipe in a claim does not break the table', () => {
  // A finding about `a || b` would otherwise split its own row into extra
  // cells and silently corrupt every column after it.
  const md = renderLedger(
    [finding({ id: 'a', rank: 0, shortSummary: 'Uses a || b instead of a | b' })],
    {}, snap, null,
  );
  const row = md.split('\n').find((l) => l.includes('Uses a'))!;
  assert.ok(row.includes('a \\|\\| b'), 'the pipes in the claim are escaped');
  const cells = row.split(/(?<!\\)\|/);
  assert.equal(cells.length, 7, 'five cells between six unescaped pipes');
});

test('only fix and blocked get a written-up section', () => {
  const findings = [
    finding({ id: 'a', rank: 0, shortSummary: 'Needs fixing' }),
    finding({ id: 'b', rank: 1, shortSummary: 'Not real' }),
    finding({ id: 'c', rank: 2, shortSummary: 'Waiting on someone' }),
  ];
  const d: Record<string, Disposition> = { a: 'fix', b: 'reject', c: 'blocked' };
  const md = renderLedger(findings, d, snap, null);
  const detail = md.slice(md.indexOf('## Needs work'));
  assert.match(detail, /Needs fixing/);
  assert.match(detail, /Waiting on someone/);
  assert.ok(!detail.includes('Not real'), 'a rejected finding is in the table but not written up');
  assert.match(detail, /How it fails/);
});

test('with nothing triaged there is no Needs work section to mislead', () => {
  const md = renderLedger([finding({ id: 'a', rank: 0 })], {}, snap, null);
  assert.ok(!md.includes('## Needs work'));
  assert.match(md, /0\/1 triaged/);
});
