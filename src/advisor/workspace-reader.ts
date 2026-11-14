import { open, opendir, stat } from 'node:fs/promises';
import { advisorError, utf8Boundary, workspacePath } from './paths.js';
import { loadSensitiveMatcher } from './sensitive.js';

export async function listDir(root: string, options: { path?: string; depth?: number; max_entries?: number } = {}) {
  const extra = await loadSensitiveMatcher(root);
  const base = await workspacePath(root, options.path ?? '.', extra);
  if (!base.info?.isDirectory()) advisorError('INVALID_PATH', 'Path must be a directory; linked directories are not traversed.');
  const entries: { path: string; type: 'file' | 'dir' | 'symlink'; size?: number }[] = [];
  let hidden_count = 0;
  let truncated = false;
  const limit = Math.min(500, Math.max(1, options.max_entries ?? 200));
  async function walk(path: string, depth: number): Promise<void> {
    const checked = await workspacePath(root, path, extra);
    if (checked.info?.isSymbolicLink()) return;
    for await (const entry of await opendir(checked.canonical)) {
      const rel = path === '.' ? entry.name : `${path}/${entry.name}`;
      let child;
      try { child = await workspacePath(root, rel, extra); } catch (error) {
        if ((error as { code?: string }).code === 'SENSITIVE_PATH') hidden_count++;
        continue;
      }
      if (entries.length >= limit) { truncated = true; return; }
      const info = child.info;
      if (!info) continue;
      const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'dir' : 'file';
      entries.push({ path: rel, type, ...(type === 'file' ? { size: info.size } : {}) });
      if (type === 'dir' && depth > 1) await walk(rel, depth - 1);
      if (truncated) return;
    }
  }
  await walk(base.relative, Math.min(3, Math.max(1, options.depth ?? 1)));
  return { entries, truncated, hidden_count };
}

export async function readFile(root: string, options: { path: string; start_line?: number; max_lines?: number; max_bytes?: number }) {
  const checked = await workspacePath(root, options.path, await loadSensitiveMatcher(root));
  // Check regular-file status before opening, to avoid blocking on pipes/devices.
  const handle = checked.info?.isFile() || checked.info?.isSymbolicLink()
    ? (await stat(checked.canonical)).isFile() ? await open(checked.canonical, 'r') : undefined
    : undefined;
  if (!handle) advisorError('INVALID_PATH', 'Path must be a regular file.');
  let data: Buffer;
  try {
    const size = (await handle.stat()).size;
    if (size > 10 * 1024 * 1024) advisorError('FILE_TOO_LARGE', 'File exceeds the 10 MiB read limit.');
    // Sized from stat (plus one byte to detect growth); still bounded if a
    // concurrent writer grows the file after stat.
    data = Buffer.alloc(size + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const read = await handle.read(data, bytes, data.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > size) advisorError('FILE_CHANGED', 'File grew while being read; retry.');
    data = data.subarray(0, bytes);
  } finally { await handle.close(); }
  if (data.subarray(0, 8192).includes(0)) advisorError('BINARY_FILE', 'Binary files are not readable.');
  const lines = data.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start_line = Math.max(1, options.start_line ?? 1);
  const selected = lines.slice(start_line - 1, start_line - 1 + Math.min(400, Math.max(1, options.max_lines ?? 400)));
  const bytes = Buffer.from(selected.join('\n'));
  const cut = utf8Boundary(bytes, Math.min(65536, Math.max(1, options.max_bytes ?? 65536)));
  const content = bytes.subarray(0, cut).toString('utf8');
  const count = cut === bytes.length ? selected.length : content === '' ? 0 : content.split('\n').length;
  const end_line = start_line + count - 1;
  const truncated = cut < bytes.length || end_line < lines.length;
  // A byte cut inside the page re-reads the partial last line next time. A cut
  // inside the FIRST line (one line longer than max_bytes) must still advance,
  // otherwise a client paging by next_start_line would loop forever.
  const partialFirstLine = cut < bytes.length && end_line <= start_line;
  const next_start_line = !truncated ? null
    : cut < bytes.length ? (partialFirstLine ? start_line + 1 : end_line)
      : end_line + 1;
  return { path: checked.relative, start_line, end_line, total_lines: lines.length, truncated,
    next_start_line, content, ...(partialFirstLine ? { partial_line: true } : {}) };
}
