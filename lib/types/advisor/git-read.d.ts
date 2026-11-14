import type { ExtraMatcher } from './sensitive.js';
export declare function workspaceInfo(root: string, workspace: {
    id: string;
    title: string;
    path: string;
}): Promise<{
    dirty_count: number;
    is_git_repo: boolean;
    branch: string | null;
    head: string | null;
    id: string;
    title: string;
    path: string;
    mode: "advisor";
}>;
export declare function gitStatus(root: string): Promise<{
    entries: {
        path: string;
        index: string;
        worktree: string;
    }[];
    hidden_count: number;
    truncated: boolean;
    branch: string | null;
    head: string | null;
}>;
export declare function filterDiff(root: string, raw: string, extra: ExtraMatcher): Promise<{
    diff: string;
    hidden_files: number;
}>;
export declare function gitDiff(root: string, options?: {
    base?: string;
    paths?: string[];
    cached?: boolean;
    offset?: number;
    max_bytes?: number;
}): Promise<{
    diff: string;
    offset: number;
    next_offset: number | null;
    total_bytes: number;
    hidden_files: number;
    truncated: boolean;
}>;
