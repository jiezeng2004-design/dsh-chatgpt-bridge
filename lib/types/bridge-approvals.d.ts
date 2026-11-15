import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { type ApprovalLayer, type ApprovalRequestLike, type PendingApproval, type PendingQuestion, type WaitingState } from './bridge-types.js';
import type { WorkspaceTracker } from './bridge-workspace.js';
import type { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import type { BridgeLogger } from './log.js';
import { type GoalControlStore, type GoalHistoryEvent } from './goal-control.js';
import { type UserApprovalPolicy } from './approval-policy.js';
import { type ApiProxyLike } from './web-gateway.js';
export interface ApprovalBrokerDeps {
    ctx: Context;
    log: BridgeLogger;
    managed: Set<string>;
    approvals: Map<string, PendingApproval>;
    questions: Map<string, PendingQuestion>;
    goalStore: GoalControlStore;
    workspace: WorkspaceTracker;
    workspaceGuard: WorkspaceConcurrencyGuard;
    /** Live accessors: tests and the Web mux attach replace the proxy on the Bridge. */
    getApiProxy: () => ApiProxyLike | undefined;
    setApiProxy: (api: ApiProxyLike | undefined) => void;
    getApprovalPolicy: () => UserApprovalPolicy;
    now: () => number;
    noteGoalEvent: (sessionId: string, type: GoalHistoryEvent['type'], extra?: {
        step_id?: string;
        metadata?: Record<string, unknown>;
    }) => void;
}
export declare class ApprovalBroker {
    private readonly deps;
    private readonly ctx;
    private readonly log;
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private readonly goalStore;
    private readonly workspace;
    private readonly workspaceGuard;
    private readonly now;
    private readonly noteGoalEvent;
    private questionSeq;
    private started;
    private muxAbort;
    private webOwnsApprovals;
    approvalsEnabled: boolean;
    questionsEnabled: boolean;
    constructor(deps: ApprovalBrokerDeps);
    private get apiProxy();
    private set apiProxy(value);
    private get approvalPolicy();
    /** Register the approval answerer and the user-questions provider. */
    start(): void;
    /** Parked + undecided approvals and questions for one session. */
    waitingFor(sessionId: string, events?: readonly SessionEvent[]): WaitingState;
    failClosedWaiting(sessionId: string): Promise<void>;
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    decideApproval(request: ApprovalRequestLike, next?: () => Promise<ApprovalOutcome> | ApprovalOutcome): Promise<ApprovalOutcome>;
    private rejectConstraint;
    answerQuestion(questionId: string, sessionId: string | undefined, answer: {
        selected: string[];
        custom?: string;
    }): Promise<{
        answered: true;
    }>;
    approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
        approval_id: string;
        session_id: string;
        decision: 'approve' | 'reject';
        outcome: ApprovalOutcome;
        layer: ApprovalLayer;
        fail_closed?: boolean;
    }>;
}
