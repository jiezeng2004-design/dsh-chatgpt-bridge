/**
 * Pure view helpers over a session event log: turn spans, assistant text,
 * tool calls, changed files and recent-message summaries, all bounded by
 * explicit budgets. Unit-testable with fixture events.
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'todo/write': {
            todos: readonly {
                content: string;
                status: string;
            }[];
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
export declare function lastTurnSpan(events: readonly SessionEvent[]): TurnSpan | undefined;
/** Concatenated text content of assistant messages inside one turn. */
export declare function assistantTextForTurn(events: readonly SessionEvent[], turn: number): string;
/** One model-requested tool invocation inside a turn, paired with its result. */
export interface ToolCallInfo {
    callId: string;
    name: string;
    /** Raw arguments JSON exactly as the model produced it. */
    arguments: string;
    isError?: boolean;
    error?: {
        name: string;
        code: string;
    };
}
/** Tool calls of one turn in call order, paired with their results. */
export declare function toolCallsForTurn(events: readonly SessionEvent[], turn: number, maxItems: number): ToolCallInfo[];
/** Files the turn's edit tools named, in first-seen order (data-driven from the log). */
export declare function changedFilesForTurn(events: readonly SessionEvent[], turn: number): string[];
/** One summarized message row for dsh_get_session. */
export interface MessageRow {
    seq: number;
    time: string;
    role: 'user' | 'assistant';
    text: string;
}
/** Recent user/assistant message rows, newest first, bounded by item/char budgets. */
export declare function summarizeMessages(events: readonly SessionEvent[], maxItems: number, maxChars: number): MessageRow[];
/** Last event timestamp (ms) or undefined for an empty log. */
export declare function lastEventTime(events: readonly SessionEvent[]): string | undefined;
/** The last todo/write snapshot, if any. */
export declare function lastTodos(events: readonly SessionEvent[]): {
    content: string;
    status: string;
}[] | undefined;
