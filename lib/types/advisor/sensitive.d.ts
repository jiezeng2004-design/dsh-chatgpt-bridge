export type ExtraMatcher = (relativePath: string) => boolean;
/** Small glob compiler shared by ignore rules and the Node search fallback. */
export declare function globRegex(pattern: string, ignoreCase?: boolean): RegExp;
export declare function isSensitivePath(relPath: string, extraMatcher?: ExtraMatcher): boolean;
/** Never follow an ignore-file link outside the registered root. Fail closed on unreadable rules. */
export declare function loadSensitiveMatcher(root: string): Promise<ExtraMatcher>;
