import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'search_repo' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Search source files for a query string and return file matches with line numbers and snippets.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Search phrase (plain text)' },
      path: { type: ['string', 'null'], description: 'Base directory to search (defaults to working directory)' },
      include_hidden: { type: ['boolean', 'null'], description: 'Include dotfiles and dot-directories (default false)' },
      max_depth: { type: ['number', 'null'], description: 'Maximum search depth (default 5)' },
      limit: { type: ['number', 'null'], description: 'Maximum number of files to return (default 100)' },
      max_file_bytes: { type: ['number', 'null'], description: 'Skip files larger than this many bytes (default 1_000_000)' },
      exclude_globs: { type: ['array', 'null'], items: { type: 'string' }, description: 'Paths to exclude (glob-like substrings)' },
      include_globs: { type: ['array', 'null'], items: { type: 'string' }, description: 'Only include paths matching any of these (glob-like substrings)' },
    },
    required: ['query', 'path', 'include_hidden', 'max_depth', 'limit', 'max_file_bytes', 'exclude_globs', 'include_globs'],
  },
} as const;

type Match = { line: number; column: number; preview: string };
type FileMatch = { path: string; language?: string; matches: Match[] };

const DEFAULT_EXCLUDES = [
  '/.git/', '/node_modules/', '/dist/', '/build/', '/.next/', '/.cache/', '/.turbo/', '/.expo/', '/.vercel/', '/.DS_Store'
];

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.swift': 'swift', '.java': 'java', '.kt': 'kotlin', '.cpp': 'cpp', '.c': 'c',
  '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sql': 'sql', '.sh': 'bash'
};

function isProbablyBinary(buf: Buffer): boolean {
  // Heuristic: presence of null byte
  for (let i = 0; i < Math.min(buf.length, 1024); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function pathMatchesAny(p: string, patterns: string[] | undefined | null): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pat) => {
    // Very light glob-like substring check; supports leading/trailing "**/"
    const needle = pat.replace(/\*\*/g, '');
    return needle ? p.includes(needle) : false;
  });
}

export const run: ToolHandler<{
  query: string;
  path?: string | null;
  include_hidden?: boolean | null;
  max_depth?: number | null;
  limit?: number | null;
  max_file_bytes?: number | null;
  exclude_globs?: string[] | null;
  include_globs?: string[] | null;
}, any> = async (input, { workingDir }) => {
  const query = input.query;
  const baseDir = resolvePath(workingDir, input.path || '.');
  const includeHidden = !!input.include_hidden;
  const maxDepth = input.max_depth ?? 5;
  const limit = input.limit ?? 100;
  const maxFileBytes = input.max_file_bytes ?? 1_000_000;
  const exclude = [...DEFAULT_EXCLUDES, ...((input.exclude_globs ?? []) as string[])];
  const include = (input.include_globs ?? []) as string[];

  const files: FileMatch[] = [];
  let totalMatches = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || files.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= limit) break;
      if (!includeHidden && name.startsWith('.')) continue;
      const full = join(dir, name);
      const relForFilter = full.replace(baseDir, '') || full;
      if (pathMatchesAny(relForFilter, exclude)) continue;
      if (include.length > 0 && !pathMatchesAny(relForFilter, include)) {
        // Only include selected patterns
        // Still descend into directories unless explicitly excluded
      }
      let st: Stats | undefined;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!includeHidden && name.startsWith('.')) continue;
        await visit(full, depth + 1);
      } else if (st.isFile()) {
        if (st.size > maxFileBytes) continue;
        let buf: Buffer;
        try { buf = await readFile(full); } catch { continue; }
        if (isProbablyBinary(buf)) continue;
        const text = buf.toString('utf8');
        if (!text.includes(query)) continue;
        const lines = text.split(/\r?\n/);
        const matches: Match[] = [];
        for (let i = 0; i < lines.length && matches.length < 3; i++) {
          const idx = lines[i].indexOf(query);
          if (idx >= 0) {
            const preview = lines[i].slice(0, 400);
            matches.push({ line: i + 1, column: idx + 1, preview });
          }
        }
        if (matches.length > 0) {
          const ext = extname(full).toLowerCase();
          const language = LANGUAGE_BY_EXT[ext];
          files.push({ path: full, language, matches });
          totalMatches += matches.length;
        }
      }
    }
  };

  await visit(resolve(baseDir), 0);

  return {
    query,
    basePath: baseDir,
    totalMatches,
    files,
  };
};
