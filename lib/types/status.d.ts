/**
 * Pure status derivation over DSH state. No DSH imports beyond types, so the
 * rules are unit-testable with fixture events. The vocabulary is deliberately
 * DSH-native where DSH has a word for it ('idle', 'running', turn-end
 * reasons) and adds the bridge-level waiting states the protocol needs.
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
/** Bridge-level session status vocabulary. */
export type BridgeStatus = 'idle' | 'queued' | 'running' | 'waiting_for_user' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'max-tokens' | 'interrupted' | 'forked' | 'unknown';
export interface StatusInput {
    /** Whether the session is live in this process. */
    live?: boolean;
    /** The live agent's status, when live. */
    agentStatus?: 'idle' | 'running';
    /** Whether the live agent inbox holds pending messages. */
    hasPendingInbox?: boolean;
    /** Bridge-parked approvals for this session. */
    pendingApprovals: number;
    /** Bridge-parked user questions for this session. */
    pendingQuestions: number;
    /** The session event log (live or persisted). */
    events: readonly SessionEvent[];
}
/** The last turn/end reason in the log, if any. */
export declare function lastTurnEnd(events: readonly SessionEvent[]): {
    turn: number;
    reason: TurnEndReason;
} | undefined;
/** Derive the bridge status from a DSH state snapshot. */
export declare function deriveStatus(input: StatusInput): BridgeStatus;
/** An approval/asked event that has no matching approval/decided. */
export interface UndecidedApproval {
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
}
/**
 * Fold durable approval audit events. Used when the Web api-proxy (not this
 * process's parked map) owns the answerer.
 */
export declare function undecidedApprovals(events: readonly SessionEvent[]): UndecidedApproval[];
/** An ask_user_question tool call that has not yet produced a tool/result. */
export interface OpenAskUser {
    callId: string;
    arguments: string;
}
/**
 * Open ask_user_question calls. Questions are not durable session events;
 * the in-flight tool call is the only log signal when the Web provider owns the slot.
 */
export declare function openAskUserQuestions(events: readonly SessionEvent[]): OpenAskUser[];
/** One message pending in a session's inbox lists (cold fold of splice events). */
export interface PendingFold {
    nextTurn: number;
    nextStep: number;
}
/**
 * Fold the durable 'agent/inbox/spliced' events to recover pending-message
 * counts for a session that is not live (its Inbox projection is not
 * replayed into memory). Mirrors the Inbox splice semantics.
 */
export declare function foldPendingMessages(events: readonly SessionEvent[]): PendingFold;
