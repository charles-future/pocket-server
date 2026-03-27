import os from 'node:os';
import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { MAX_CONTEXT_BYTES, MAX_IMPORT_DEPTH } from './config';

export type ProjectContextSource = 'CLAUDE.md' | 'AGENTS.md';

export interface ProjectContext {
  source: ProjectContextSource;
  path: string;
  content: string;
  resolvedImports?: string[];
  truncated?: boolean;
}

/**
 * Load project context by searching upward from workingDir for CLAUDE.md (preferred) or AGENTS.md.
 * For CLAUDE.md, resolve @imports recursively up to MAX_IMPORT_DEPTH, skipping code blocks/spans.
 */
export async function loadProjectContext(
  workingDir: string,
  options?: { preferred?: 'claude' | 'agents' }
): Promise<ProjectContext | null> {
  const foundClaude = await findNearestFileUp(workingDir, 'CLAUDE.md');
  const foundAgents = await findNearestFileUp(workingDir, 'AGENTS.md');

  const preferAgents = (options?.preferred === 'agents');
  const chosen = preferAgents ? (foundAgents || foundClaude) : (foundClaude || foundAgents);
  if (!chosen) return null;

  const source: ProjectContextSource = chosen.endsWith(`${sep}CLAUDE.md`) ? 'CLAUDE.md' : 'AGENTS.md';

  let content = await fs.readFile(chosen, 'utf8').catch(() => '');
  const resolvedImports: string[] = [];

  if (source === 'CLAUDE.md') {
    content = await resolveClaudeImports(content, dirname(chosen), 0, resolvedImports);
  }

  // Normalize and cap size
  const normalized = normalizeContent(content);
  const { text, truncated } = capText(normalized, MAX_CONTEXT_BYTES);

  return {
    source,
    path: chosen,
    content: text,
    resolvedImports,
    truncated,
  };
}

async function findNearestFileUp(startDir: string, filename: string): Promise<string | null> {
  try {
    let dir = resolve(startDir);
    while (true) {
      const candidate = join(dir, filename);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {}
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeContent(text: string): string {
  // Collapse excessive blank lines and trim
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Find a safe cut point roughly at limit
  let end = maxBytes;
  // back up to previous newline boundary to avoid splitting mid-line
  while (end > 0 && bytes[end] !== 10 /* \n */) end--;
  if (end <= 0) end = maxBytes;
  const sliced = bytes.slice(0, end);
  const decoder = new TextDecoder();
  const head = decoder.decode(sliced);
  const notice = '\n\n[Note] Project context truncated due to size limit.\n';
  return { text: head + notice, truncated: true };
}

// Resolve @imports for CLAUDE.md, skipping matches inside fenced code blocks and inline code spans.
async function resolveClaudeImports(
  content: string,
  baseDir: string,
  depth: number,
  seen: string[]
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return content;

  // Tokenize into segments (text vs code) so we only scan text segments for imports
  const segments = splitMarkdownSegments(content);
  const resolvedSegments: string[] = [];
  for (const seg of segments) {
    if (seg.type === 'code') {
      resolvedSegments.push(seg.text);
      continue;
    }
    const lines = seg.text.split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Match lines containing @path tokens (may be multiple). Keep original line, append inlined files after.
      const imports = extractAtImports(trimmed);
      if (imports.length === 0) {
        out.push(line);
        continue;
      }
      out.push(line);
      for (const imp of imports) {
        const abs = await resolveImportPath(imp, baseDir);
        if (!abs) continue;
        if (seen.includes(abs)) continue;
        seen.push(abs);
        try {
          const fileText = await fs.readFile(abs, 'utf8');
          const inlined = await resolveClaudeImports(fileText, dirname(abs), depth + 1, seen);
          resolvedSegments.push(`\n\n<!-- begin import: ${abs} -->\n${inlined}\n<!-- end import: ${abs} -->\n`);
        } catch {}
      }
    }
    resolvedSegments.push(out.join('\n'));
  }
  return resolvedSegments.join('');
}

function splitMarkdownSegments(text: string): Array<{ type: 'code' | 'text'; text: string }> {
  const parts: Array<{ type: 'code' | 'text'; text: string }> = [];
  const fenceRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  for (const match of text.matchAll(fenceRegex)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) parts.push({ type: 'text', text: text.slice(lastIndex, matchIndex) });
    parts.push({ type: 'code', text: match[0] });
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });

  // Now split inline code spans inside text segments to avoid scanning them
  const refined: Array<{ type: 'code' | 'text'; text: string }> = [];
  for (const p of parts) {
    if (p.type === 'code') { refined.push(p); continue; }
    const spanRegex = /`[^`]*`/g;
    let idx = 0;
    for (const m of p.text.matchAll(spanRegex)) {
      const mIndex = m.index ?? 0;
      if (mIndex > idx) refined.push({ type: 'text', text: p.text.slice(idx, mIndex) });
      refined.push({ type: 'code', text: m[0] });
      idx = mIndex + m[0].length;
    }
    if (idx < p.text.length) refined.push({ type: 'text', text: p.text.slice(idx) });
  }
  return refined;
}

function extractAtImports(line: string): string[] {
  // Look for tokens starting with @ that are not email-like and not URLs
  const matches = line.match(/(^|\s)@[^\s]+/g) || [];
  return matches
    .map((m) => m.trim().replace(/^@/, ''))
    .filter((p) => !p.includes('@') && !p.startsWith('http://') && !p.startsWith('https://'));
}

async function resolveImportPath(pathToken: string, baseDir: string): Promise<string | null> {
  try {
    let abs: string;
    if (pathToken.startsWith('~/')) {
      abs = resolve(os.homedir(), pathToken.slice(2));
    } else if (pathToken.startsWith('/')) {
      abs = resolve(pathToken);
    } else {
      abs = resolve(baseDir, pathToken);
    }
    let stat: import('fs').Stats | null = null;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) return null;
    return abs;
  } catch {
    return null;
  }
}
