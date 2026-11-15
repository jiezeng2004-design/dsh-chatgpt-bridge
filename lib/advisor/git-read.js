import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { advisorError, utf8Boundary, workspacePath } from './paths.js';
import { loadSensitiveMatcher } from './sensitive.js';
const execute = promisify(execFile);
const prefix = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '--no-pager', '--literal-pathspecs'];
const MAX_BUFFER = 32 * 1024 * 1024;
async function git(root, args) {
    try {
        return (await execute('git', [...prefix, ...args], { cwd: root, timeout: 15000, maxBuffer: MAX_BUFFER,
            windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout;
    }
    catch (error) {
        const failure = error;
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && args[0] === 'diff') {
            advisorError('DIFF_TOO_LARGE', 'Raw diff exceeds 32 MiB; narrow paths.');
        }
        throw error;
    }
}
async function gitIdentity(root, required) {
    try {
        if ((await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true')
            throw new Error();
    }
    catch (error) {
        const code = error.code;
        if (code === 'EPERM' || code === 'ENOENT')
            advisorError('GIT_UNAVAILABLE', 'Git subprocess is unavailable.');
        if (required)
            advisorError('NOT_A_GIT_REPO', 'Workspace is not a Git working tree.');
        return { is_git_repo: false, branch: null, head: null };
    }
    let branch = null;
    let head = null;
    try {
        branch = (await git(root, ['branch', '--show-current'])).trim() || null;
    }
    catch { /* unavailable branch */ }
    try {
        head = (await git(root, ['rev-parse', '--short=12', 'HEAD'])).trim();
    }
    catch { /* unborn HEAD */ }
    return { is_git_repo: true, branch, head };
}
async function statusData(root, extra) {
    const repoPrefix = (await git(root, ['rev-parse', '--show-prefix'])).replace(/\r?\n$/, '');
    const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    const records = raw.split('\0');
    const entries = [];
    let hidden_count = 0;
    let total = 0;
    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        if (!row)
            continue;
        total++;
        const paths = [row.slice(3)];
        if (/[RC]/.test(row.slice(0, 2)))
            paths.push(records[++i] ?? '');
        let checked;
        try {
            for (const path of paths) {
                if (!path.startsWith(repoPrefix))
                    advisorError('PATH_OUTSIDE_WORKSPACE', 'Git path is outside workspace.');
                const current = await workspacePath(root, path.slice(repoPrefix.length), extra);
                checked ??= current;
            }
        }
        catch {
            hidden_count++;
            continue;
        }
        if (checked && entries.length < 500)
            entries.push({ path: checked.relative, index: row[0], worktree: row[1] });
    }
    return { entries, hidden_count, truncated: total - hidden_count > entries.length, total };
}
export async function workspaceInfo(root, workspace) {
    const identity = await gitIdentity(root, false);
    const dirty_count = identity.is_git_repo ? (await statusData(root, await loadSensitiveMatcher(root))).total : 0;
    return { id: workspace.id, title: workspace.title, path: workspace.path, mode: 'advisor', ...identity, dirty_count };
}
export async function gitStatus(root) {
    const { branch, head } = await gitIdentity(root, true);
    const { total: _total, ...status } = await statusData(root, await loadSensitiveMatcher(root));
    return { branch, head, ...status };
}
/** Decode Git's C-quoted path syntax, including octal UTF-8 bytes. */
function unquote(value) {
    if (!value.startsWith('"'))
        return value.includes('\0') ? null : value;
    if (!value.endsWith('"'))
        return null;
    const bytes = [];
    for (let i = 1; i < value.length - 1; i++) {
        if (value[i] !== '\\') {
            if (value[i] === '"')
                return null;
            const character = String.fromCodePoint(value.codePointAt(i));
            bytes.push(...Buffer.from(character));
            i += character.length - 1;
            continue;
        }
        const rest = value.slice(i + 1, -1);
        const octal = /^[0-7]{3}/.exec(rest);
        if (octal) {
            bytes.push(parseInt(octal[0], 8));
            i += 3;
            continue;
        }
        const escape = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"' };
        const decoded = escape[value[++i]];
        if (decoded === undefined)
            return null;
        bytes.push(...Buffer.from(decoded));
    }
    return Buffer.from(bytes).toString('utf8');
}
function sectionPaths(section) {
    const lines = section.split('\n');
    const header = lines[0].slice('diff --git '.length);
    // A quoted name has an unambiguous end; unquoted names may contain spaces.
    const quoted = '"(?:[^"\\\\]|\\\\.)*"';
    const pair = new RegExp(`^(${quoted}|a/.*?) (${quoted}|b/.*)$`).exec(header);
    if (!pair || (!header.startsWith('"') && header.split(' b/').length !== 2))
        return null;
    const paths = [];
    function add(raw, prefixed) {
        const decoded = unquote(raw);
        if (decoded === null)
            return false;
        if (decoded === '/dev/null' && prefixed)
            return true;
        if (prefixed && !/^[ab]\//.test(decoded))
            return false;
        paths.push(prefixed ? decoded.slice(2) : decoded);
        return true;
    }
    if (!add(pair[1], true) || !add(pair[2], true))
        return null;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Stop at hunks: added/deleted content can itself resemble metadata.
        if (line.startsWith('@@') || line === 'GIT binary patch')
            break;
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            // Git may append a tab separator after an unquoted filename containing spaces.
            const path = line.slice(4);
            if (!add(path.startsWith('"') ? path : path.replace(/\t$/, ''), true))
                return null;
        }
        for (const marker of ['rename from ', 'rename to ', 'copy from ', 'copy to ']) {
            if (line.startsWith(marker) && !add(line.slice(marker.length), false))
                return null;
        }
    }
    return paths;
}
export async function filterDiff(root, raw, extra) {
    const sections = raw.split(/(?=^diff --git )/m).filter(Boolean);
    let hidden_files = 0;
    const kept = [];
    for (const section of sections) {
        const paths = section.startsWith('diff --git ') ? sectionPaths(section) : null;
        if (!paths?.length) {
            hidden_files++;
            continue;
        }
        try {
            for (const path of paths)
                await workspacePath(root, path, extra);
        }
        catch {
            hidden_files++;
            continue;
        }
        kept.push(section);
    }
    return { diff: kept.join(''), hidden_files };
}
export async function gitDiff(root, options = {}) {
    const extra = await loadSensitiveMatcher(root);
    // Validate caller inputs before running any diff command.
    if (options.base !== undefined && (!/^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(options.base) || options.base.startsWith('-'))) {
        advisorError('INVALID_REF', 'Base must be a valid commit reference.');
    }
    const paths = [];
    for (const path of options.paths ?? [])
        paths.push((await workspacePath(root, path, extra)).relative);
    await gitIdentity(root, true);
    let commit;
    if (options.base !== undefined) {
        try {
            try {
                commit = (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.base}^{commit}`])).trim();
            }
            catch (error) {
                // Only old Git's explicit unsupported-option error permits the fallback.
                if (!/unknown (?:option|switch).*end-of-options|unrecognized option.*end-of-options/i.test(error.stderr ?? ''))
                    throw error;
                commit = (await git(root, ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`])).trim();
            }
            if (!/^[a-f0-9]{40,64}$/i.test(commit))
                throw new Error();
        }
        catch {
            advisorError('INVALID_REF', 'Base does not resolve to a commit.');
        }
    }
    let raw;
    try {
        raw = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--src-prefix=a/', '--dst-prefix=b/',
            ...(options.cached ? ['--cached'] : []), ...(commit ? [commit] : []), '--', ...(paths.length ? paths : ['.'])]);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'DIFF_TOO_LARGE')
            throw error;
        advisorError('GIT_FAILED', 'Git diff could not be read.');
    }
    const filtered = await filterDiff(root, raw, extra);
    const bytes = Buffer.from(filtered.diff);
    const offset = utf8Boundary(bytes, Math.max(0, options.offset ?? 0));
    const end = utf8Boundary(bytes, offset + Math.min(65536, Math.max(1, options.max_bytes ?? 65536)));
    return { diff: bytes.subarray(offset, end).toString('utf8'), offset, next_offset: end < bytes.length ? end : null,
        total_bytes: bytes.length, hidden_files: filtered.hidden_files, truncated: end < bytes.length };
}
