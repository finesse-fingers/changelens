import { runClaude } from './claude.js';
import { isAssistant, isResult, isSuccess, toolUses } from './events.js';

/**
 * What this CLI build actually honours.
 *
 * The CLI accepts unknown flags silently and exits 0, so a flag that does
 * nothing is indistinguishable from one that works unless its effect is
 * observed. Anything the app depends on is verified here, once, rather than
 * assumed from `--help`.
 */
export interface Capabilities {
  version: string;
  /** `--json-schema` populates `structured_output` on the result. */
  structuredOutput: boolean;
  /** `--max-budget-usd` actually aborts rather than being ignored. */
  budgetCap: boolean;
  /**
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` stops the model dispatching
   * subagents in the background.
   *
   * Load-bearing for the review: a background dispatch makes the model yield
   * the turn to wait for a notification, and under `--print` the session ends
   * there — so the fan-out completes into a process that has already exited
   * and the findings are never reported.
   */
  foregroundAgents: boolean;
  probedAt: string;
  notes: string[];
}

let cached: Capabilities | null = null;

export async function probeCapabilities(cwd: string, force = false): Promise<Capabilities> {
  if (cached && !force) return cached;
  const notes: string[] = [];

  const version = await runClaude({ cwd, prompt: 'reply with the single word: ok', timeoutMs: 60_000 })
    .then((r) => {
      const init = r.events.find((e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init');
      return (init as { claude_code_version?: string } | undefined)?.claude_code_version ?? 'unknown';
    })
    .catch(() => 'unknown');

  // Ask for a shape nothing would produce by accident, so a populated
  // `structured_output` can only mean the flag was honoured.
  const schema = {
    type: 'object',
    properties: { probe_value: { type: 'string' }, probe_number: { type: 'integer' } },
    required: ['probe_value', 'probe_number'],
    additionalProperties: false,
  };
  const structured = await runClaude({
    cwd,
    prompt: 'Set probe_value to "changelens" and probe_number to 7.',
    jsonSchema: schema,
    timeoutMs: 120_000,
    maxBudgetUsd: 0.5,
  }).catch(() => null);

  const so = structured?.structuredOutput as { probe_value?: string } | undefined;
  const structuredOutput = Boolean(so && typeof so.probe_value === 'string');
  if (!structuredOutput) {
    notes.push(
      'No structured_output came back for --json-schema. Every job that needs a ' +
      'typed result will report itself incomplete rather than returning nothing ' +
      'quietly; there is no fenced-JSON fallback.',
    );
  }

  // A budget this small cannot be satisfied; if the flag works the run aborts
  // with error_max_budget_usd rather than completing normally.
  const budget = await runClaude({
    cwd,
    prompt: 'Write a detailed three paragraph explanation of the CAP theorem.',
    maxBudgetUsd: 0.0001,
    timeoutMs: 120_000,
  }).catch(() => null);
  const budgetResult = budget?.events.find(isResult);
  const budgetCap = Boolean(
    budgetResult && (!isSuccess(budgetResult) && budgetResult.subtype === 'error_max_budget_usd'),
  );
  if (!budgetCap) {
    notes.push(
      '--max-budget-usd did not abort a run that should have exceeded it. ' +
      'Cost is bounded by the wall-clock timeout and tool allowlist instead.',
    );
  }

  // Ask for a background agent explicitly. With the suppression on, the model
  // still dispatches but `run_in_background` comes back unset and the agent
  // runs inline.
  const bgPrompt =
    'Use the Agent tool right now to launch ONE agent with run_in_background set to ' +
    'true. Its task: reply with the single word ok. Nothing else.';
  const askedForBackground = async (env?: Record<string, string>) => {
    const r = await runClaude({
      cwd,
      prompt: bgPrompt,
      allowedTools: ['Task'],
      // Not `plan`: plan mode refuses to launch an unrelated agent at all,
      // which would make both arms of this probe look identical.
      maxBudgetUsd: 0.8,
      timeoutMs: 180_000,
      env,
    }).catch(() => null);
    if (!r) return null;
    return r.events.some(
      (e) =>
        isAssistant(e) &&
        toolUses(e, 'Agent').some((t) => t.input.run_in_background === true),
    );
  };

  const withoutSuppression = await askedForBackground();
  const withSuppression = await askedForBackground({
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  });
  // Only a real difference counts. If the model never dispatched in the
  // background even unsuppressed, the probe proves nothing either way.
  const foregroundAgents = withoutSuppression === true && withSuppression === false;
  if (!foregroundAgents) {
    notes.push(
      withoutSuppression === true
        ? 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS did not stop background dispatch. ' +
          'A fanned-out review may end its turn while angles are still running.'
        : 'Background-dispatch suppression could not be verified — the probe never ' +
          'saw a background dispatch to suppress.',
    );
  }

  cached = {
    version, structuredOutput, budgetCap, foregroundAgents,
    probedAt: new Date().toISOString(), notes,
  };
  return cached;
}

export function cachedCapabilities(): Capabilities | null {
  return cached;
}
