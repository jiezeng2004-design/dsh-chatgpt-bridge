export type AdvisorState = 'INIT' | 'PLAN' | 'EXECUTING' | 'EXECUTED' | 'HANDOFF' | 'DONE' | 'BLOCKED' | 'ERROR';
export type AdvisorVerdict = 'done' | 'blocked' | 'plan';
export type AdvisorRequestKind = 'INIT' | 'EXECUTED' | 'HANDOFF';
export interface AdvisorPlan {
    rationale: string;
    actions: string[];
    files_likely: string[];
    tests: string[];
    success_criteria: string[];
}
export interface AdvisorTestResult {
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'not_run';
}
export interface AdvisorExecuted {
    iteration: number;
    changed_files_count: number;
    tests: AdvisorTestResult[];
    summary: string;
}
export interface AdvisorVerdictEntry {
    iteration: number;
    verdict: AdvisorVerdict;
    reason?: string;
    created_at: string;
}
export interface AdvisorTask {
    schemaVersion: 1;
    task_id: string;
    workspace_id: string;
    session_id?: string;
    goal: string;
    state: AdvisorState;
    iteration: number;
    max_iterations: number;
    plan?: AdvisorPlan;
    last_executed?: AdvisorExecuted;
    verdict_history: AdvisorVerdictEntry[];
    handoff_reason?: string;
    blocked_reason?: string;
    error?: string;
    created_at: string;
    updated_at: string;
    checkpoint: {
        state: AdvisorState;
        iteration: number;
        next_step: string;
    };
}
export interface AdvisorRequest {
    request_id: string;
    task_id: string;
    kind: AdvisorRequestKind;
    iteration: number;
    workspace_id: string;
    goal: string;
    last_executed?: AdvisorExecuted;
    handoff_reason?: string;
}
export interface AdvisorStoreOptions {
    dir?: string;
    maxIterations?: number;
    now?: () => number;
    retentionMs?: number;
    idleTtlMs?: number;
    logger?: {
        warn(msg: string): void;
    };
}
export interface CreateAdvisorTaskInput {
    workspace_id: string;
    goal: string;
    session_id?: string;
}
export interface AdvisorPollInput {
    task_id?: string;
    wait_ms?: number;
}
export interface SubmitAdvisorPlanInput extends AdvisorPlan {
    task_id: string;
    iteration: number;
}
export interface ReportAdvisorExecutedInput extends AdvisorExecuted {
    task_id: string;
}
export interface SubmitAdvisorVerdictInput {
    task_id: string;
    iteration: number;
    verdict: AdvisorVerdict;
    reason?: string;
    plan?: AdvisorPlan;
}
export type AdvisorPlanResult = {
    task_id: string;
    iteration: number;
    plan: AdvisorPlan;
} | {
    task_id: string;
    state: AdvisorState;
    terminal: true;
    verdict?: AdvisorVerdict;
    blocked_reason?: string;
    error?: string;
} | {
    task_id: string;
    state: AdvisorState;
    waiting: true;
};
export type AdvisorRequestResult = {
    request: AdvisorRequest;
} | {
    idle: true;
};
export declare function clampAdvisorWaitMs(value?: unknown): number;
export declare function advisorStateDir(dshHome: string): string;
/**
 * Control metadata only: never put file contents, diffs or logs here. Text fields
 * are bounded to 2048 characters; code and evidence belong in the read-only data plane.
 * Each instance owns its directory (no cross-process writer coordination).
 */
export declare class AdvisorStore {
    private readonly tasks;
    private readonly chains;
    private readonly waiters;
    private readonly dir?;
    private readonly maxIterations;
    private readonly now;
    private readonly retentionMs;
    private readonly idleTtlMs;
    private readonly logger?;
    private readonly ready;
    private maintenance?;
    private lastCleanup;
    private version;
    private closed;
    constructor(options?: AdvisorStoreOptions);
    static open(options?: AdvisorStoreOptions): Promise<AdvisorStore>;
    /** Idempotent initialization barrier; does not reload over live in-memory transitions. */
    load(): Promise<void>;
    private time;
    private readTasks;
    private serial;
    private prepare;
    private get;
    private state;
    private iteration;
    private signal;
    private persist;
    private save;
    private mutate;
    createTask(input: CreateAdvisorTaskInput): Promise<AdvisorTask>;
    submitPlan(input: SubmitAdvisorPlanInput): Promise<AdvisorTask>;
    reportExecuted(input: ReportAdvisorExecutedInput): Promise<AdvisorTask>;
    handoff(input: {
        task_id: string;
        reason: string;
    }): Promise<AdvisorTask>;
    submitVerdict(input: SubmitAdvisorVerdictInput): Promise<AdvisorTask>;
    getTask(id: string): Promise<AdvisorTask>;
    listTasks(input?: {
        workspace_id?: string;
        include_terminal?: boolean;
    }): Promise<AdvisorTask[]>;
    private pending;
    private poll;
    waitRequest(input?: AdvisorPollInput): Promise<AdvisorRequestResult>;
    getPlan(input: {
        task_id: string;
        wait_ms?: number;
    }): Promise<AdvisorPlanResult>;
    private runCleanup;
    cleanup(): Promise<void>;
    close(): Promise<void>;
}
