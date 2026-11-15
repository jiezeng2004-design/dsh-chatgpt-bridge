export interface SearchOptions {
    query: string;
    regex?: boolean;
    glob?: string;
    max_matches?: number;
    /** Internal test hook, never exposed through MCP. */
    forceNode?: boolean;
}
export declare function searchWorkspace(root: string, options: SearchOptions): Promise<{
    matches: {
        path: string;
        line: number;
        text: string;
    }[];
    truncated: boolean;
    hidden_count: number;
    engine: "ripgrep";
} | {
    matches: {
        path: string;
        line: number;
        text: string;
    }[];
    truncated: boolean;
    hidden_count: number;
    engine: "node";
}>;
