import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isPathInsideWorkspace } from '../paths.js';
/** Small glob compiler shared by ignore rules and the Node search fallback. */
export function globRegex(pattern, ignoreCase = true) {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            i++;
            if (pattern[i + 1] === '/') {
                source += '(?:.*/)?';
                i++;
            }
            else
                source += '.*';
        }
        else if (c === '*')
            source += '[^/]*';
        else if (c === '?')
            source += '[^/]';
        else
            source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}
export function isSensitivePath(relPath, extraMatcher) {
    const path = relPath.replace(/\\/g, '/').toLowerCase();
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.some((part) => (part === '.env' || part.startsWith('.env.')) && part !== '.env.example'))
        return true;
    if (parts.some((part) => ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker'].includes(part)))
        return true;
    if (parts.some((part, i) => part === '.config' && parts[i + 1] === 'gcloud'))
        return true;
    const base = parts.at(-1) ?? '';
    if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base))
        return true;
    if (['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', 'credentials', 'credentials.json', 'token.json', '.pgpass'].includes(base))
        return true;
    if (/\.(token|kdbx|pem|key|p12|pfx|jks|keystore|crt|cer|der|asc)$/.test(base))
        return true;
    // Users must always be able to inspect the root ignore policy itself.
    return path === '.dshadvisorignore' ? false : extraMatcher?.(path) ?? false;
}
/** Never follow an ignore-file link outside the registered root. Fail closed on unreadable rules. */
export async function loadSensitiveMatcher(root) {
    const file = join(root, '.dshadvisorignore');
    try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 65536 || !isPathInsideWorkspace(file, root))
            return () => true;
        const canonical = await realpath(file);
        if (isSensitivePath(relative(await realpath(root), canonical)))
            return () => true;
        const rules = (await readFile(canonical, 'utf8')).split(/\r?\n/)
            .map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
            .map((line) => {
            const pattern = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
            return { regex: globRegex(pattern), basename: !pattern.includes('/') };
        });
        return (path) => {
            // Each ancestor is checked too, so directory matches protect all descendants.
            const parts = path.split('/');
            return rules.some(({ regex, basename }) => parts.some((part, i) => regex.test(basename ? part : parts.slice(0, i + 1).join('/'))));
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return () => false;
        return () => true;
    }
}
