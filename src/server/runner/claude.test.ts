import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs } from './claude.js';

const base = { cwd: '/tmp', prompt: 'hello' };

test('stream-json always carries --verbose (this build refuses it otherwise)', () => {
  const args = buildArgs(base, 'sid');
  const i = args.indexOf('--output-format');
  assert.equal(args[i + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), '--verbose is required with --print + stream-json');
});

test('the prompt is never a positional argument', () => {
  // --add-dir and --allowedTools are variadic: a trailing positional is
  // consumed as one of their values and the CLI reports "no input provided".
  const args = buildArgs({ ...base, addDirs: ['/repo'], allowedTools: ['Read', 'Grep'] }, 'sid');
  assert.ok(!args.includes('hello'), 'prompt must go over stdin');
  assert.equal(args[args.length - 2], '--add-dir');
  assert.equal(args[args.length - 1], '/repo');
});

test('session id is ours, minted before launch', () => {
  const args = buildArgs(base, 'my-session-id');
  assert.equal(args[args.indexOf('--session-id') + 1], 'my-session-id');
});

test('json schema is serialized as one argument', () => {
  const args = buildArgs({ ...base, jsonSchema: { type: 'object' } }, 'sid');
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
});
