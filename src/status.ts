/**
 * Pure status derivation over DSH state. No DSH imports beyond types, so the
 * rules are unit-testable with fixture events. The vocabulary is deliberately
 * DSH-native where DSH has a word for it ('idle', 'running', turn-end
 * reasons) and adds the bridge-level waiting states the protocol needs.
 */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';

/** Bridge-level session status vocabulary. */
export type BridgeStatus =
  | 'idle' // live session, no turn in flight, no pending work, no terminal turn yet
  | 'queued' // messages pending in the agent inbox, driver not yet running
  | 'running' // the DSH agent driver is actively working
  | 'waiting_for_user' // a user-question is parked and awaits an answer
  | 'waiting_for_approval' // a permission approval is parked and awaits a decision
  | 'completed' // last turn ended completed
  | 'failed' // last turn ended with an error
  | 'cancelled' // last turn ended aborted (cancelled)
  | 'blocked' // last turn ended blocked (DSH turn-end reason)
  | 'max-tokens' // last turn ended max-tokens (DSH turn-end reason)
  | 'interrupted' // last turn ended interrupted (crash-orphan closed on reload)
  | 'forked' // fork seed closes an inherited open turn; not task completion
  | 'unknown'; // session not live and has no persisted log

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
export function lastTurnEnd(events: readonly SessionEvent[]): { turn: number; reason: TurnEndReason } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'turn/end') {
      return { turn: event.data.turn, reason: event.data.reason };
    }
  }
  return undefined;
}

/** Derive the bridge status from a DSH state snapshot. */
export function deriveStatus(input: StatusInput): BridgeStatus {
  if (input.pendingApprovals > 0) return 'waiting_for_approval';
  if (input.pendingQuestions > 0) return 'waiting_for_user';
  if (input.agentStatus === 'running') return 'running';
  if (input.hasPendingInbox) return 'queued';
  const last = lastTurnEnd(input.events);
  if (last === undefined) return input.live === false ? 'unknown' : 'idle';
  switch (last.reason.kind) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    case 'aborted':
      return 'cancelled';
    default:
      return last.reason.kind; // blocked | max-tokens | interrupted | forked
  }
}

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
export function undecidedApprovals(events: readonly SessionEvent[]): UndecidedApproval[] {
  const asked = new Map<string, UndecidedApproval>();
  const decided = new Set<string>();
  for (const event of events) {
    const data = event.data as { id?: string; toolName?: string; callId?: string; reason?: string } | undefined;
    if (event.type === 'approval/decided' && typeof data?.id === 'string') {
      decided.add(data.id);
    } else if (event.type === 'approval/asked' && typeof data?.id === 'string' && typeof data.toolName === 'string') {
      asked.set(data.id, {
        id: data.id,
        toolName: data.toolName,
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        ...(data.reason === undefined ? {} : { reason: data.reason }),
      });
    }
  }
  return [...asked.values()].filter((item) => !decided.has(item.id));
}

/** An ask_user_question tool call that has not yet produced a tool/result. */
export interface OpenAskUser {
  callId: string;
  arguments: string;
}

/**
 * Open ask_user_question calls. Questions are not durable session events;
 * the in-flight tool call is the only log signal when the Web provider owns the slot.
 */
export function openAskUserQuestions(events: readonly SessionEvent[]): OpenAskUser[] {
  const open = new Map<string, OpenAskUser>();
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      open.set(event.data.callId, { callId: event.data.callId, arguments: event.data.arguments });
    } else if (event.type === 'tool/result') {
      const callId = (event.data.message as { source?: { callId?: string } } | undefined)?.source?.callId;
      if (callId !== undefined) open.delete(callId);
    }
  }
  return [...open.values()];
}

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
export function foldPendingMessages(events: readonly SessionEvent[]): PendingFold {
  const lists: { 'next-turn': string[]; 'next-step': string[] } = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount, inserted } = event.data;
    const list = lists[target];
    const clamp = Math.max(0, Math.min(start, list.length));
    const remove = removedCount === undefined ? list.length - clamp : Math.min(removedCount, list.length - clamp);
    list.splice(clamp, remove, ...inserted.map((message) => message.id));
  }
  return { nextTurn: lists['next-turn'].length, nextStep: lists['next-step'].length };
}
