/**
 * Run the real review job against a repo and report what actually happened.
 *
 * The failure this exists to catch is invisible from the result alone: a run
 * that dispatches its angle agents in the background ends its turn while they
 * are still going, and reports nothing. So this checks the transcript, not just
 * the return value.
 */
import { readFileSync } from 'node:fs';
import { resolveSnapshot } from '../src/server/git/snapshot.js';
import { extractUnits } from '../src/server/git/units.js';
import { runReviewJob } from '../src/server/jobs/review.js';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: tsx scripts/review-probe.ts <repo-path> [effort] [pr-number]');
  process.exit(1);
}

const effort = (process.argv[3] ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const pr = process.argv[4] ? Number(process.argv[4]) : undefined;

const snap = await resolveSnapshot(
  pr
    ? { kind: 'pr', repoRoot: repo, prNumber: pr }
    : { kind: 'local', repoRoot: repo, includeStaged: true, includeUnstaged: true, includeUntracked: true },
);
const units = snap.diff.files.flatMap((f) => extractUnits(f));
console.log(`${snap.diff.files.length} file(s), ${units.length} unit(s), ${effort} / sonnet`);

const started = Date.now();
const res = await runReviewJob(snap.snapshot, units, { effort, model: 'sonnet', target: pr ? String(pr) : undefined });

console.log('\n--- result');
console.log('findings:   ', res.findings.length);
console.log('recovered:  ', res.recovered);
console.log('conventions:', res.conventions);
console.log('incomplete: ', res.incomplete);
console.log('cost:        $' + res.costUsd.toFixed(3), '/', Math.round(res.durationMs / 1000) + 's');
// Where each finding would land in the margin. A finding that matches neither
// a unit nor a changed file renders nowhere at all, which is the failure this
// diagnostic exists to catch.
const paths = new Set(snap.diff.files.map((f) => f.path));
const unitIds = new Set(units.map((u) => u.id));
let orphaned = 0;
for (const f of res.findings) {
  const anchor = f.hunkId && unitIds.has(f.hunkId) ? 'unit' : paths.has(f.file) ? 'file header' : 'NOWHERE';
  if (anchor === 'NOWHERE') orphaned++;
  console.log(`  #${f.rank + 1} [${f.verdict ?? '-'}] ${f.shortSummary ?? f.summary}`);
  console.log(`      file=${f.file} line=${f.line ?? '-'} -> renders at: ${anchor}`);
}
console.log(`\nanchoring: ${res.findings.length - orphaned}/${res.findings.length} land somewhere; ${orphaned} would be invisible`);
console.log('snapshot paths (sample):', snap.diff.files.slice(0, 4).map((f) => f.path));

// The transcript is the only place the background/foreground choice is visible.
const slug = repo.replace(/\//g, '-');
const path = `${process.env.HOME}/.claude/projects/${slug}/${res.sessionId}.jsonl`;
try {
  const bg: unknown[] = [];
  let reportFindings = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as { message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
    for (const b of o.message?.content ?? []) {
      if (b.type !== 'tool_use') continue;
      if (b.name === 'Agent' || b.name === 'Task') bg.push(b.input?.run_in_background ?? null);
      if (b.name === 'ReportFindings') reportFindings++;
    }
  }
  console.log('\n--- transcript');
  console.log('agent dispatches:  ', bg.length, '| run_in_background values:', JSON.stringify(bg));
  console.log('ReportFindings calls:', reportFindings);
  console.log(bg.some((v) => v === true) ? 'FAIL: background dispatch happened' : 'OK: every agent ran in the foreground');
} catch (e) {
  console.log('\n(could not read transcript at', path, '-', (e as Error).message + ')');
}
