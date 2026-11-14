import { execFile } from 'node:child_process';
import { open, opendir } from 'node:fs/promises';
import { advisorError, workspacePath } from './paths.js';
import { globRegex, loadSensitiveMatcher } from './sensitive.js';

export interface SearchOptions {
  query: string;
  regex?: boolean;
  glob?: string;
  max_matches?: number;
  /** Internal test hook, never exposed through MCP. */
  forceNode?: boolean;
}

export async function searchWorkspace(root: string, options: SearchOptions) {
  let expression: RegExp | undefined;
  try { if (options.regex) expression = new RegExp(options.query); }
  catch { advisorError('INVALID_QUERY', 'Search expression is invalid.'); }
  const extra = await loadSensitiveMatcher(root);
  const matches: { path: string; line: number; text: string }[] = [];
  const limit = Math.min(100, Math.max(1, options.max_matches ?? 50));
  let hidden_count = 0;
  let truncated = false;
  function add(path: string, line: number, text: string) {
    if (matches.length >= limit) { truncated = true; return; }
    matches.push({ path, line, text: text.replace(/\r?\n$/, '').slice(0, 500) });
  }
  if (!options.forceNode) {
    const result = await new Promise<{ stdout: string; error: { code?: string | number | null; stderr?: string } | null }>((resolve) => {
      const args = ['--json', '--no-follow', '--max-filesize', '1M', '--hidden', '--no-ignore', '--glob', '!.git', '--glob', '!node_modules',
        ...(options.regex ? [] : ['--fixed-strings']), ...(options.glob ? ['--glob', options.glob] : []), '-e', options.query, '--', '.'];
      execFile('rg', args, { cwd: root, timeout: 15000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ stdout, error: error ? Object.assign(error, { stderr }) : null });
      });
    });
    if (result.error && /regex parse error|error parsing regex/i.test(result.error.stderr ?? '')) {
      advisorError('INVALID_QUERY', 'Search expression is invalid.');
    }
    const code = result.error?.code;
    if (!result.error || Number(code) === 1 || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      truncated = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      const searchable = new Map<string, boolean>();
      for (const row of result.stdout.split('\n')) {
        if (!row) continue;
        let event;
        try { event = JSON.parse(row); } catch { truncated = true; continue; }
        if (event.type !== 'match') continue;
        const data = event.data;
        const path = data.path.text ?? Buffer.from(data.path.bytes, 'base64').toString('utf8');
        let checked;
        try { checked = await workspacePath(root, path, extra); }
        catch (error) {
          if ((error as { code?: string }).code === 'SENSITIVE_PATH') hidden_count++;
          continue;
        }
        if (!checked.info?.isFile() || checked.info.size > 1024 * 1024) continue;
        // rg JSON can emit an early match before reporting a later NUL byte.
        // Apply the same first-8-KiB binary rule as the Node reader.
        if (!searchable.has(checked.relative)) {
          const file = await open(checked.canonical, 'r');
          try {
            const probe = Buffer.alloc(8192);
            const read = await file.read(probe, 0, probe.length, 0);
            searchable.set(checked.relative, (await file.stat()).size <= 1024 * 1024 && !probe.subarray(0, read.bytesRead).includes(0));
          } finally { await file.close(); }
        }
        if (!searchable.get(checked.relative)) continue;
        add(checked.relative, data.line_number, data.lines.text ?? Buffer.from(data.lines.bytes, 'base64').toString('utf8'));
      }
      return { matches, truncated, hidden_count, engine: 'ripgrep' as const };
    }
    if (code !== 'ENOENT') advisorError('SEARCH_UNAVAILABLE', code === 'EPERM' ? 'Ripgrep subprocess spawn failed with EPERM.' : 'Ripgrep search could not complete.');
  }
  // JavaScript's backtracking RegExp can be driven into catastrophic runtime
  // by a crafted pattern (ReDoS) and would block the bridge event loop.
  // ripgrep's engine is linear-time, so regex search is ripgrep-only.
  if (expression !== undefined) advisorError('REGEX_REQUIRES_RIPGREP', 'Regex search needs ripgrep on PATH; use a fixed-string query.');
  const glob = options.glob ? globRegex(options.glob, false) : undefined;
  async function walk(path: string): Promise<void> {
    const dir = await workspacePath(root, path, extra);
    if (!dir.info?.isDirectory()) return;
    for await (const entry of await opendir(dir.canonical)) {
      if (entry.name.toLowerCase() === '.git' || entry.name.toLowerCase() === 'node_modules') continue;
      const rel = path === '.' ? entry.name : `${path}/${entry.name}`;
      let checked;
      try { checked = await workspacePath(root, rel, extra); }
      catch (error) {
        if ((error as { code?: string }).code === 'SENSITIVE_PATH') hidden_count++;
        continue;
      }
      if (checked.info?.isSymbolicLink()) continue;
      if (checked.info?.isDirectory()) { await walk(rel); continue; }
      if (!checked.info?.isFile() || checked.info.size > 1024 * 1024) continue;
      if (glob && !glob.test(options.glob?.includes('/') ? rel : entry.name)) continue;
      const file = await open(checked.canonical, 'r');
      let bytes: Buffer;
      try {
        bytes = Buffer.alloc(1024 * 1024 + 1);
        let size = 0;
        while (size < bytes.length) {
          const part = await file.read(bytes, size, bytes.length - size, size);
          if (!part.bytesRead) break;
          size += part.bytesRead;
        }
        bytes = bytes.subarray(0, size);
      } finally { await file.close(); }
      if (bytes.length > 1024 * 1024 || bytes.subarray(0, 8192).includes(0)) continue;
      const lines = bytes.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      for (let i = 0; i < lines.length; i++) {
        if (expression ? expression.test(lines[i]) : lines[i].includes(options.query)) add(rel, i + 1, lines[i]);
      }
    }
  }
  await walk('.');
  return { matches, truncated, hidden_count, engine: 'node' as const };
}
