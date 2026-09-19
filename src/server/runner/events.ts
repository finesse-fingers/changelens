/**
 * The `--output-format stream-json` wire format.
 *
 * Deliberately permissive: the `system` subtype enum grows between CLI
 * versions, so anything unrecognised must pass through rather than throw.
 */

export interface InitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  cwd: string;
  tools: string[];
  slash_commands: string[];
  permissionMode: string;
  claude_code_version: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string }

export type ContentBlock = ToolUseBlock | TextBlock | ThinkingBlock | { type: string };

export interface AssistantEvent {
  type: 'assistant';
  message: { id: string; model: string; role: 'assistant'; content: ContentBlock[]; stop_reason: string | null };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface UserEvent {
  type: 'user';
  message: { role: 'user'; content: ContentBlock[] };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface ResultSuccess {
  type: 'result';
  subtype: 'success';
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
  session_id: string;
  result_index?: number;
  structured_output?: unknown;
  permission_denials: { tool_name: string }[];
}

export interface ResultError {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  /** The error variant has NO `result` field — branch on subtype before reading it. */
  errors: string[];
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms: number;
  session_id: string;
  result_index?: number;
}

export type ResultEvent = ResultSuccess | ResultError;

export interface SystemEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
  [k: string]: unknown;
}

export type StreamEvent = InitEvent | AssistantEvent | UserEvent | ResultEvent | SystemEvent | { type: string };

export function isInit(e: StreamEvent): e is InitEvent {
  return e.type === 'system' && (e as SystemEvent).subtype === 'init';
}
export function isAssistant(e: StreamEvent): e is AssistantEvent {
  return e.type === 'assistant';
}
export function isResult(e: StreamEvent): e is ResultEvent {
  return e.type === 'result';
}
export function isSuccess(e: ResultEvent): e is ResultSuccess {
  return e.subtype === 'success';
}

/** Pull every tool_use block with the given name out of an assistant message. */
export function toolUses(e: AssistantEvent, name: string): ToolUseBlock[] {
  return e.message.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use' && (b as ToolUseBlock).name === name,
  );
}

export function assistantText(e: AssistantEvent): string {
  return e.message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
