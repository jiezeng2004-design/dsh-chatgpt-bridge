export declare function listDir(root: string, options?: {
    path?: string;
    depth?: number;
    max_entries?: number;
}): Promise<{
    entries: {
        path: string;
        type: "file" | "dir" | "symlink";
        size?: number;
    }[];
    truncated: boolean;
    hidden_count: number;
}>;
export declare function readFile(root: string, options: {
    path: string;
    start_line?: number;
    max_lines?: number;
    max_bytes?: number;
}): Promise<{
    partial_line?: boolean | undefined;
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    truncated: boolean;
    next_start_line: number | null;
    content: string;
}>;
