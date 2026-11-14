/**
 * Pure bridge helpers with no state: text/time formatting, capped-set
 * bookkeeping, mutating-tool classification, approval event access and the
 * lazily resolved DSH version. Re-exported (where public) from bridge.ts.
 */
import { createRequire } from 'node:module';
import { classesForTool } from './goal-constraints.js';
const require = createRequire(import.meta.url);
/** DSH version string, resolved lazily from the installed package. */
export function dshVersion() {
    try {
        return require('@deepseek-ai/dsh/package.json').version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
}
export function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + '…[truncated]';
}
export function iso(ms) {
    return new Date(ms).toISOString();
}
export function approvalEvents(session) {
    return session?.snapshotEvents?.() ?? session?.events ?? [];
}
export function uniqueStrings(values) {
    return [...new Set(values.filter((item) => item.trim() !== ''))];
}
export function rememberCappedSet(target, value, cap = 2048) {
    if (target.has(value))
        target.delete(value);
    target.add(value);
    while (target.size > cap) {
        const oldest = target.values().next().value;
        if (oldest === undefined)
            break;
        target.delete(oldest);
    }
}
export function isMutatingTool(toolName, command) {
    const classes = classesForTool(toolName, command);
    return classes.includes('filesystem.write')
        || classes.includes('git.mutate')
        || classes.includes('npm.publish')
        || classes.includes('github.release')
        || classes.includes('external_path.write');
}
