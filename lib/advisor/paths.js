import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { BridgeError } from '../bridge.js';
import { isPathInsideWorkspace, pathsEqual } from '../paths.js';
import { isSensitivePath } from './sensitive.js';
export function advisorError(code, message) { throw new BridgeError(code, message); }
/** One gate for caller paths and paths discovered by all data-plane readers. */
export async function workspacePath(root, input, extra) {
    if (!input || input.includes('\0'))
        advisorError('INVALID_PATH', 'Path is empty or malformed.');
    if (/^[\\/]|^[a-z]:/i.test(input) || input.split(/[\\/]/).includes('..')) {
        advisorError('PATH_OUTSIDE_WORKSPACE', 'Path must stay inside the registered workspace.');
    }
    // Reject NTFS alternate streams and other Windows aliases, on every platform.
    if (input.includes(':'))
        advisorError('INVALID_PATH', 'Path is malformed.');
    const rel = input.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.').join('/') || '.';
    if (isSensitivePath(rel, extra))
        advisorError('SENSITIVE_PATH', 'Sensitive workspace path is not readable.');
    const absolute = resolve(root, rel);
    if (!isPathInsideWorkspace(absolute, root))
        advisorError('PATH_OUTSIDE_WORKSPACE', 'Path escapes the registered workspace.');
    const realRoot = await realpath(root);
    let ancestor = absolute;
    let info;
    try {
        info = await lstat(absolute);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            advisorError('INVALID_PATH', 'Path cannot be inspected.');
    }
    // Resolve the nearest existing ancestor as well (deleted Git paths can still have linked parents).
    let canonical;
    for (;;) {
        try {
            canonical = await realpath(ancestor);
            break;
        }
        catch (error) {
            if (error.code !== 'ENOENT' || pathsEqual(ancestor, root)) {
                advisorError('INVALID_PATH', 'Path cannot be resolved.');
            }
            ancestor = dirname(ancestor);
        }
    }
    const target = resolve(canonical, relative(ancestor, absolute));
    if (!isPathInsideWorkspace(target, realRoot))
        advisorError('PATH_OUTSIDE_WORKSPACE', 'Path escapes the registered workspace.');
    if (isSensitivePath(relative(realRoot, target).replace(/\\/g, '/'), extra)) {
        advisorError('SENSITIVE_PATH', 'Sensitive workspace path is not readable.');
    }
    return { absolute, canonical: target, relative: rel, info };
}
/** Round a byte position down to a UTF-8 character boundary. */
export function utf8Boundary(buffer, position) {
    let end = Math.min(Math.max(0, position), buffer.length);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80)
        end--;
    return end;
}
