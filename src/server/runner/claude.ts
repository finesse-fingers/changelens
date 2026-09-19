import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NdjsonParser } from './ndjson.js';
import {
  isResult, isSuccess, type ResultEvent, type StreamEvent,
} from './events.js';

export interface RunOptions {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Our own output contract; the result then carries `structured_output`. */
  jsonSchema?: unknown;
  allowedTools?: string[];
  permissionMode?: 'plan' | 'acceptEdits' | 'dontAsk' | 'auto';
  addDirs?: string[];
  /** Enables the typed ReportFindings tool. Only meaningful with stream-json. */
  reportFindings?: boolean;
  /**
   * Extra system-prompt text. The jobs' carefully worded instructions are
   * useless as a user message when the model is also holding a diff — they
   * belong above it.
   */
  appendSystemPrompt?: string;
  /** Re-enter an existing session instead of starting a new one. */
  resume?: string;
  /** Extra environment for the child, merged over the inherited env. */
  env?: Record<string, string>;
  forwardSubagentText?: boolean;
  maxBudgetUsd?: number;
  /** Hard wall-clock ceiling. Enforced here, not by any CLI flag. */
  timeoutMs?: number;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  sessionId: string;
  events: StreamEvent[];
  result: ResultEvent | null;
  structuredOutput?: unknown;
  text: string;
  costUsd: number;
  durationMs: number;
  /** Set when the run produced no usable result. Never treat this as "clean". */
  incomplete: string | null;
  /** Tools the run asked for and was refused. Empty is the normal case. */
  permissionDenials: string[];
  /** Stream lines that failed to parse. Each one is a silently lost event. */
  parseErrors: number;
  argv: string[];
  exitCode: number | null;
  stderr: string;
}

export const CLAUDE_BIN = process.env.CHANGELENS_CLAUDE_BIN ?? 'claude';

/**
 * Build the argv for a headless run.
 *
 * `--output-format stream-json` is not optional when `reportFindings` is set:
 * the CLI force-disables the typed ReportFindings tool under `text` and `json`
 * output, silently degrading the review to a lossier prose contract.
 */
export function buildArgs(o: RunOptions, sessionId: string): string[] {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    // Required: this build rejects stream-json under --print without it
    // ("--output-format=stream-json requires --verbose"). Verified against the
    // CLI rather than taken from --help, which does not document the coupling.
    '--verbose',
    '--permission-prompts', 'none',
  ];
  // A resumed run continues an existing session, so it carries that id instead
  // of minting one.
  if (o.resume) args.push('--resume', o.resume);
  else args.push('--session-id', sessionId);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.forwardSubagentText) args.push('--forward-subagent-text');
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  // The prompt goes over stdin, never as a positional argument. `--add-dir` and
  // `--allowedTools` are variadic, so a trailing positional gets swallowed as
  // one of their values and the CLI then reports no input at all. Stdin also
  // sidesteps ARG_MAX, which a full diff can approach.
  return args;
}

/**
 * Run `claude` headlessly and collect its event stream.
 *
 * `onEvent` fires as events arrive so the UI can fill progressively — a
 * five-minute review that shows nothing until it finishes reads as a hang.
 */
export async function runClaude(
  o: RunOptions,
  onEvent?: (e: StreamEvent) => void,
): Promise<RunResult> {
  const sessionId = o.sessionId ?? randomUUID();
  const args = buildArgs(o, sessionId);

  const env = { ...process.env, ...o.env };
  if (o.reportFindings) env.CLAUDE_CODE_REPORT_FINDINGS = '1';

  const child = spawn(CLAUDE_BIN, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* closed early; the exit path reports it */ });
  child.stdin.end(o.prompt);

  const parser = new NdjsonParser();
  const events: StreamEvent[] = [];
  let stderr = '';
  let lastResultIndex = -1;
  let droppedResults = 0;
  const started = Date.now();

  // The only reliable ceiling: no CLI turn/time flag can be trusted, because
  // unknown flags are accepted silently and would give a cap that does nothing.
  const timeout = o.timeoutMs ?? 10 * 60_000;
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, timeout);

  const onAbort = () => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  };
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const ingest = (raw: unknown) => {
    const e = raw as StreamEvent;
    events.push(e);
    if (isResult(e)) {
      const idx = (e as { result_index?: number }).result_index;
      if (typeof idx === 'number') {
        // A result whose write failed still consumes its number, so a gap in
        // the sequence means a result was lost rather than never produced.
        if (lastResultIndex !== -1 && idx > lastResultIndex + 1) {
          droppedResults += idx - lastResultIndex - 1;
        }
        lastResultIndex = idx;
      }
    }
    onEvent?.(e);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const raw of parser.push(chunk)) ingest(raw);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { stderr = (stderr + c).slice(-8_000); });

  let spawnError: NodeJS.ErrnoException | null = null;
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    // Keep the error rather than collapsing it into a null exit code: a missing
    // binary and a crashed one are the same value otherwise, and the first is
    // what someone hits on their very first run.
    child.on('error', (err: NodeJS.ErrnoException) => { spawnError = err; resolve(null); });
  });
  clearTimeout(killTimer);
  o.signal?.removeEventListener('abort', onAbort);
  for (const raw of parser.flush()) ingest(raw);

  const result = [...events].reverse().find(isResult) ?? null;
  const success = result && isSuccess(result) ? result : null;

  let incomplete: string | null = null;
  if (timedOut) incomplete = `Timed out after ${Math.round(timeout / 1000)}s`;
  else if (o.signal?.aborted) incomplete = 'Cancelled';
  else if (spawnError) incomplete = cannotRun(spawnError);
  else if (!result) incomplete = `No result event (exit ${exitCode}). ${stderr.slice(-300)}`.trim();
  else if (!isSuccess(result)) incomplete = result.errors?.join('; ') || result.subtype;
  else if (droppedResults > 0) incomplete = `${droppedResults} result(s) lost in the stream`;

  // A malformed line is a lost event that nothing downstream can see. Findings
  // payloads are the largest lines in the stream and so the likeliest to be
  // truncated — a run that drops one looks identical to a run that found
  // nothing, which is exactly the confusion this field exists to prevent.
  const parseErrors = events.filter((e) => e.type === 'parse_error').length;
  if (parseErrors > 0) {
    const note = `${parseErrors} stream line(s) could not be parsed and were lost`;
    incomplete = incomplete ? `${incomplete}; ${note}` : note;
  }

  const permissionDenials = [
    ...new Set((success?.permission_denials ?? []).map((d) => d.tool_name)),
  ];

  return {
    sessionId,
    events,
    result,
    structuredOutput: success?.structured_output,
    text: success?.result ?? '',
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: result?.duration_ms ?? Date.now() - started,
    incomplete,
    permissionDenials,
    parseErrors,
    argv: args,
    exitCode,
    stderr,
  };
}

/**
 * Say which binary could not be run, and how to fix it.
 *
 * A spawn failure used to surface as `No result event (exit null).` — true, and
 * useless. This is the first thing someone sees if Claude Code is not installed.
 */
function cannotRun(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return `Could not run \`${CLAUDE_BIN}\`. Install Claude Code from ` +
      'https://claude.com/claude-code and make sure it is on your PATH, ' +
      'or set CHANGELENS_CLAUDE_BIN to its full path.';
  }
  return `Could not run \`${CLAUDE_BIN}\`: ${err.message}`;
}
