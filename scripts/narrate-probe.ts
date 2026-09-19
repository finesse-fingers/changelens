/**
 * Run the real narrate job and report whether it earned its place in the margin.
 *
 * Two things matter and neither is visible from the annotations alone: how much
 * of the output is routine (if none of it is, the noise problem is not fixed),
 * and whether every convention citation quotes text that genuinely appears in
 * the file it names (one fabricated citation discredits all the real ones).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSnapshot } from '../src/server/git/snapshot.js';
import { extractUnits } from '../src/server/git/units.js';
import { narrateAll } from '../src/server/jobs/narrate.js';

const repo = process.argv[2];
if (!repo) {
  console.error('usage: tsx scripts/narrate-probe.ts <repo-path> [--effort <level>]');
  process.exit(1);
}

const effort = process.argv.includes('--effort')
  ? process.argv[process.argv.indexOf('--effort') + 1]
  : undefined;
const snap = await resolveSnapshot({
  kind: 'local', repoRoot: repo,
  includeStaged: true, includeUnstaged: true, includeUntracked: true,
});
const units = snap.diff.files.flatMap((f) => extractUnits(f));
console.log(`${snap.diff.files.length} file(s), ${units.length} unit(s)`);

const res = await narrateAll(snap.snapshot, snap.diff.files, units, () => undefined, {
  model: 'sonnet',
  effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
});

const by = { major: 0, minor: 0, routine: 0 };
let withWatchFor = 0, withAxes = 0;
for (const n of res.narrations) {
  by[n.significance]++;
  if (n.watchFor) withWatchFor++;
  if (n.axes?.length) withAxes++;
}
const total = res.narrations.length;
const pct = (n: number) => `${n} (${total ? Math.round((n / total) * 100) : 0}%)`;

console.log('\n--- shape');
console.log('conventions used:', res.conventions);
console.log('annotations:     ', total, '| failed shards:', res.failed.length, '| cost: $' + res.costUsd.toFixed(3));
console.log('major/minor/routine:', pct(by.major), '/', pct(by.minor), '/', pct(by.routine));
console.log('with watchFor:   ', pct(withWatchFor));
console.log('with any axis:   ', pct(withAxes));

console.log('\n--- convention citations (each verified against the file it names)');
let cited = 0, bogus = 0;
for (const n of res.narrations) {
  for (const a of n.axes ?? []) {
    if (a.axis !== 'conventions') continue;
    cited++;
    const text = (() => { try { return readFileSync(join(repo, a.source ?? ''), 'utf8'); } catch { return ''; } })();
    // Whitespace in the quote rarely survives a round trip; compare on words.
    const needle = (a.rule ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hay = text.replace(/\s+/g, ' ').toLowerCase();
    const ok = needle.length > 0 && hay.includes(needle);
    if (!ok) bogus++;
    console.log(`  [${ok ? 'VERBATIM' : 'NOT FOUND'}] ${a.source}: "${(a.rule ?? '').slice(0, 90)}"`);
  }
}
console.log(cited === 0 ? '  (none)' : `  ${cited} citation(s), ${bogus} not found verbatim`);

console.log('\n--- a sample of what lands in the margin');
for (const n of res.narrations.slice(0, 8)) {
  console.log(`  ${'*'.repeat(n.score)}${'.'.repeat(5 - n.score)} ${n.significance.padEnd(7)} ${n.what.slice(0, 92)}`);
  for (const a of n.axes ?? []) console.log(`      ${a.axis}/${a.rating}: ${a.reason.slice(0, 84)}`);
  if (n.watchFor) console.log(`      watch: ${n.watchFor.slice(0, 84)}`);
}
