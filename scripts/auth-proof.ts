import { runClaude } from '../src/server/runner/claude.js';

// No API key is set and none is passed — this can only succeed by inheriting
// the credentials your logged-in `claude` CLI already holds.
delete process.env.ANTHROPIC_API_KEY;

const r = await runClaude({
  cwd: process.cwd(),
  prompt: 'Reply with exactly: authenticated',
  timeoutMs: 90_000,
  maxBudgetUsd: 0.5,
});

console.log('ANTHROPIC_API_KEY set?', Boolean(process.env.ANTHROPIC_API_KEY));
console.log('reply:                ', JSON.stringify(r.text.trim().slice(0, 40)));
console.log('incomplete:           ', r.incomplete);
console.log('cost on your account: $' + r.costUsd.toFixed(5));
