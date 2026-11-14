import type { ApprovalSession } from './bridge-types.js';
/** DSH version string, resolved lazily from the installed package. */
export declare function dshVersion(): string;
export declare function truncate(text: string, maxChars: number): string;
export declare function iso(ms: number): string;
export declare function approvalEvents(session: ApprovalSession | undefined): readonly {
    type: string;
    data?: unknown;
}[];
export declare function uniqueStrings(values: string[]): string[];
export declare function rememberCappedSet(target: Set<string>, value: string, cap?: number): void;
export declare function isMutatingTool(toolName: string, command?: string): boolean;
