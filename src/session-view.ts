/**
 * Pure view helpers over a session event log: turn spans, assistant text,
 * tool calls, changed files and recent-message summaries, all bounded by
 * explicit budgets. Unit-testable with fixture events.
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'todo/write': {
      todos: readonly { content: string; status: string }[];
    };
  }
}

/** One turn's span in the log. */
export interface TurnSpan {
  turn: number;
  startSeq: number;
  endSeq: number;
  reason?: TurnEndReason;
}

/** The last turn that ended (or is still open), scanning from the tail. */
export function lastTurnSpan(events: readonly SessionEvent[]): TurnSpan | undefined {
  let open: TurnSpan | undefined;
  let lastEnd: TurnSpan | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = { turn: event.data.turn, startSeq: event.seq, endSeq: event.seq };
    } else if (event.type === 'turn/end' && open !== undefined && open.turn === event.data.turn) {
      open = { ...open, endSeq: event.seq, reason: event.data.reason };
      lastEnd = open;
      open = undefined;
    }
  }
    // An open turn is the most recent activity and must win: a consumer
  // polling a running task needs the in-flight turn, not the last completed
  // one. Only when no turn is open does the last ended turn count.
  return open ?? lastEnd;
}

/** Concatenated text content of assistant messages inside one turn. */
export function assistantTextForTurn(events: readonly SessionEvent[], turn: number): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.turn !== turn) continue;
    const text = event.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/** One model-requested tool invocation inside a turn, paired with its result. */
export interface ToolCallInfo {
  callId: string;
  name: string;
  /** Raw arguments JSON exactly as the model produced it. */
  arguments: string;
  isError?: boolean;
  error?: { name: string; code: string };
}

/** Tool calls of one turn in call order, paired with their results. */
export function toolCallsForTurn(events: readonly SessionEvent[], turn: number, maxItems: number): ToolCallInfo[] {
  const calls = new Map<string, ToolCallInfo>();
  const order: string[] = [];
  for (const event of events) {
    if (event.data === undefined) continue;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'tool/call' && data.turn === turn) {
      const callId = data.callId as string;
      calls.set(callId, { callId, name: data.name as string, arguments: data.arguments as string });
      order.push(callId);
    } else if (event.type === 'tool/result' && data.turn === turn) {
      const callId = (data.message as { source?: { callId?: string } })?.source?.callId as string | undefined;
      if (callId !== undefined) {
        const call = calls.get(callId);
        if (call !== undefined) {
          call.isError = (data.message as { content?: { isError?: boolean }[] })?.content?.[0]?.isError ?? false;
          if (data.error !== undefined) call.error = data.error as { name: string; code: string };
        }
      }
    }
  }
  return order.slice(-maxItems).map((callId) => calls.get(callId) as ToolCallInfo);
}

/** Tool names whose arguments carry a file path and that mutate files. */
const EDIT_TOOL_NAMES = new Set([
  'write', 'edit', 'str_replace', 'insert', 'replace', 'apply_patch', 'str-replace-editor',
  'rename', 'move', 'delete', 'rm', 'cp', 'mv',
]);
const PATH_ARG_KEYS = ['file_path', 'path', 'filepath', 'old_path', 'new_path', 'src', 'dest', 'old_file', 'new_file'];

/** Files the turn's edit tools named, in first-seen order (data-driven from the log). */
export function changedFilesForTurn(events: readonly SessionEvent[], turn: number): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool/call' || event.data.turn !== turn) continue;
    if (!EDIT_TOOL_NAMES.has(event.data.name)) continue;
    let args: unknown;
    try {
      args = JSON.parse(event.data.arguments);
    } catch {
      continue;
    }
    if (args === null || typeof args !== 'object') continue;
    for (const key of PATH_ARG_KEYS) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '' && !seen.has(value)) {
        seen.add(value);
        paths.push(value);
      }
    }
  }
  return paths;
}

/** One summarized message row for dsh_get_session. */
export interface MessageRow {
  seq: number;
  time: string;
  role: 'user' | 'assistant';
  text: string;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

/** Recent user/assistant message rows, newest first, bounded by item/char budgets. */
export function summarizeMessages(
  events: readonly SessionEvent[],
  maxItems: number,
  maxChars: number,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = event.data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text !== '') rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'user', text: truncate(text, maxChars) });
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text !== '') rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'assistant', text: truncate(text, maxChars) });
    }
  }
  return rows.slice(-maxItems).reverse();
}

/** Last event timestamp (ms) or undefined for an empty log. */
export function lastEventTime(events: readonly SessionEvent[]): string | undefined {
  const last = events[events.length - 1];
  return last === undefined ? undefined : new Date(last.time).toISOString();
}

/** The last todo/write snapshot, if any. */
export function lastTodos(events: readonly SessionEvent[]): { content: string; status: string }[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'todo/write') return event.data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
  }
  return undefined;
}