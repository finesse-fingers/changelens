import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConventionCache, conventionsFor, describeChain } from './conventions.js';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'changelens-conv-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  clearConventionCache();
  return root;
}

test('a repo with no conventions file says so rather than inventing one', () => {
  const root = repo({ 'src/a.ts': 'x' });
  const chain = conventionsFor(root, 'src/a.ts');
  assert.deepEqual(chain.sources, []);
  assert.equal(chain.text, '');
  assert.equal(describeChain(chain), 'no conventions file found');
});

test('the nearest nested guide comes last, so it overrides the root', () => {
  const root = repo({
    'AGENTS.md': 'root rules',
    'typescript/AGENTS.md': 'typescript rules',
    'typescript/apps/worker/AGENTS.md': 'worker rules',
    'typescript/apps/worker/src/index.ts': 'x',
  });
  const chain = conventionsFor(root, 'typescript/apps/worker/src/index.ts');
  assert.deepEqual(chain.sources.map((s) => s.path), [
    'AGENTS.md',
    'typescript/AGENTS.md',
    'typescript/apps/worker/AGENTS.md',
  ]);
  // Order in the rendered text matters as much as order in the list.
  assert.ok(chain.text.indexOf('root rules') < chain.text.indexOf('worker rules'));
});

test('a sibling subtree’s rules are not picked up', () => {
  const root = repo({
    'AGENTS.md': 'root rules',
    'python/AGENTS.md': 'python rules',
    'typescript/AGENTS.md': 'typescript rules',
    'typescript/a.ts': 'x',
  });
  const chain = conventionsFor(root, 'typescript/a.ts');
  assert.deepEqual(chain.sources.map((s) => s.path), ['AGENTS.md', 'typescript/AGENTS.md']);
  assert.ok(!chain.text.includes('python rules'));
});

test('CONTRIBUTING.md is read at the root only', () => {
  const root = repo({
    'CONTRIBUTING.md': 'how to contribute',
    'pkg/CONTRIBUTING.md': 'subtree contributing',
    'pkg/a.ts': 'x',
  });
  const chain = conventionsFor(root, 'pkg/a.ts');
  assert.deepEqual(chain.sources.map((s) => s.path), ['CONTRIBUTING.md']);
});

test('the budget is spent nearest-first, so the specific rule survives', () => {
  // The root guide alone would eat the whole budget. The subtree guide is the
  // more specific rule and the one more likely to be violated, so it must not
  // be the thing that gets dropped.
  const root = repo({
    'AGENTS.md': 'ROOT'.repeat(400),
    'pkg/AGENTS.md': 'NEAREST rule that matters',
    'pkg/a.ts': 'x',
  });
  const chain = conventionsFor(root, 'pkg/a.ts', 200);
  const nearest = chain.sources.find((s) => s.path === 'pkg/AGENTS.md');
  assert.ok(nearest, 'the nearest guide was kept');
  assert.equal(nearest.truncated, false, 'and kept whole');
  assert.ok(chain.truncated, 'while the chain reports that something was cut');
});

test('truncation is disclosed in the text, never silent', () => {
  const root = repo({ 'AGENTS.md': 'A'.repeat(5000), 'a.ts': 'x' });
  const chain = conventionsFor(root, 'a.ts', 500);
  assert.ok(chain.truncated);
  assert.match(chain.text, /truncated to fit the prompt budget/);
  assert.match(describeChain(chain), /truncated/);
});

test('a path outside the repo does not walk up into the home directory', () => {
  const root = repo({ 'AGENTS.md': 'root rules', 'a.ts': 'x' });
  const chain = conventionsFor(root, '../../../etc/passwd');
  assert.deepEqual(chain.sources.map((s) => s.path), ['AGENTS.md']);
});

test('both AGENTS.md and CLAUDE.md are read when a directory has both', () => {
  const root = repo({ 'AGENTS.md': 'agents rules', 'CLAUDE.md': 'claude rules', 'a.ts': 'x' });
  const chain = conventionsFor(root, 'a.ts');
  assert.deepEqual(chain.sources.map((s) => s.path), ['AGENTS.md', 'CLAUDE.md', ]);
});

test('an edit to a conventions file is picked up rather than served stale', () => {
  const root = repo({ 'AGENTS.md': 'first', 'a.ts': 'x' });
  assert.match(conventionsFor(root, 'a.ts').text, /first/);
  const abs = join(root, 'AGENTS.md');
  writeFileSync(abs, 'second version entirely');
  // Same size would still differ by mtime; bump it explicitly so the test does
  // not depend on filesystem timestamp granularity.
  const later = new Date(Date.now() + 2000);
  utimesSync(abs, later, later);
  assert.match(conventionsFor(root, 'a.ts').text, /second version entirely/);
});

test('an empty conventions file is not treated as a conventions file', () => {
  const root = repo({ 'AGENTS.md': '   \n\n  ', 'a.ts': 'x' });
  assert.deepEqual(conventionsFor(root, 'a.ts').sources, []);
});
