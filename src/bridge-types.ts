/**
 * Bridge wire/domain types: the typed `BridgeError`, parked approval/question
 * records, session/result/health views and the internal `LoadedView`. This
 * module owns shapes only (plus the error class); behaviour lives in the
 * collaborators next to it. Everything public is re-exported from bridge.ts.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { BridgeStatus } from './status.js';
import type { MessageRow, ToolCallInfo } from './session-view.js';
import type { ExecutionSupervisionView } from './goal.js';
import type { BlockedInfo } from './goal-graph.js';
import type { GoalHistoryEvent, GoalSupervisionView } from './goal-control.js';
import type { ResultSchema } from './result-schema.js';

/** Typed bridge error with a stable machine-readable code. */
export class BridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  command?: string;
  capability?: string;
  level?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  /** Set when the Web api-proxy parked this ask; settle via respond(). */
  muxRpcId?: string;
}

/** Who blocked or decided an approval, for deadlock diagnostics. */
export type ApprovalLayer = 'user' | 'bridge_policy' | 'dsh_policy' | 'platform';

export interface ApprovalSession {
  events?: readonly { type: string; data?: unknown }[];
  snapshotEvents?: () => readonly { type: string; data?: unknown }[];
  header?: { cwd?: string };
}

export interface ApprovalRequestLike {
  agent: {
    id: string;
    session?: ApprovalSession;
  };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
  id: string;
  sessionId?: string;
  questions: AskUserQuestionItem[];
  resolve: (answer: AskUserQuestionAnswer) => void;
  muxRpcId?: string;
}

/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
  approval_id: string;
  session_id: string;
  tool_name: string;
  call_id?: string;
  reason?: string;
}

/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
  question_id: string;
  session_id?: string;
  questions: AskUserQuestionItem[];
}

export interface WaitingState {
  approvals: ApprovalSummary[];
  questions: QuestionSummary[];
}

export interface HealthReport {
  status: string;
  bridge: { name: string; version: string };
  dsh: { version: string };
  runtime: { pid: number; uptimeMs: number };
  sessions: { live: number; persisted: number; active: number };
  capabilities: {
    transports: string[];
    authMode: 'token' | 'none';
    workspaceRegistry: boolean;
    sessionPersistence: boolean;
    agentPresets: boolean;
    userQuestions: boolean;
    approvals: boolean;
    workspaces: number;
    webSurface: boolean;
    goalSupervision: boolean;
  };
}

export interface WorkspaceView {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}

export interface SessionView {
  session_id: string;
  title?: string;
  workspace?: string;
  status: BridgeStatus;
  created_at: string;
  updated_at?: string;
  agent?: { status: 'idle' | 'running'; inbox: { nextTurn: number; nextStep: number } };
  pending: { nextTurn: number; nextStep: number };
  waiting: WaitingState;
  messages: MessageRow[];
  last_turn?: { turn: number; reason?: string };
  todos?: { content: string; status: string }[];
  blocked?: BlockedInfo;
  deferred_steps?: string[];
  blocked_steps?: string[];
  remaining_runnable_steps?: string[];
  goal?: GoalSupervisionView;
  execution?: ExecutionSupervisionView;
  history?: GoalHistoryEvent[];
}

export interface SessionSummary {
  session_id: string;
  title?: string;
  workspace?: string;
  status?: BridgeStatus;
  created_at: string;
  updated_at?: string;
}

export interface ResultView {
  session_id: string;
  status: BridgeStatus;
  turn: number;
  summary: string;
  assistant_text: string;
  changed_files: string[];
  tool_calls: ToolCallInfo[];
  error?: { code: string; message: string };
  result_schema?: ResultSchema;
}


/** One loaded session view: the live agent when attached, else persisted events. */
export interface LoadedView {
  agent?: Agent;
  session?: Session;
  events: readonly SessionEvent[];
  header: SessionHeader;
}

/** Goal-supervision fields shared by dsh_get_session / dsh_get_task_status. */
export interface GoalFields {
  todos?: { content: string; status: string }[];
  blocked?: BlockedInfo;
  deferred_steps?: string[];
  blocked_steps?: string[];
  remaining_runnable_steps?: string[];
  goal?: GoalSupervisionView;
  execution?: ExecutionSupervisionView;
  history?: GoalHistoryEvent[];
}
