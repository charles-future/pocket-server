/**
 * File System Service
 * Core file operations with security boundaries
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { Result } from '../shared/types/api';
import type { DirectoryListing, FileContent, FileNode, FileSystemService, SearchOptions, SearchResult } from './types';

/**
 * Security boundary - restrict operations to home directory
 */
const HOME_DIR = homedir();

function isPathSafe(targetPath: string): boolean {
  const resolved = resolve(targetPath);
  return resolved.startsWith(HOME_DIR);
}

/**
 * Detect project type by checking for marker files
 */
async function detectProjectType(dirPath: string): Promise<FileNode['projectType']> {
  try {
    const files = await readdir(dirPath);
    
    if (files.includes('.git')) return 'git';
    if (files.includes('bun.lockb')) return 'bun';
    if (files.includes('package.json')) return 'node';
    if (files.includes('requirements.txt') || files.includes('pyproject.toml')) return 'python';
    
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get language from file extension
 */
function getLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.swift': 'swift',
    '.java': 'java',
    '.cpp': 'cpp',
    '.c': 'c',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.md': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.sql': 'sql',
    '.sh': 'bash',
  };
  
  return languages[ext] || 'text';
}

/**
 * Create FileNode from stats
 */
async function createFileNode(path: string, name: string): Promise<FileNode> {
  const stats = await stat(path);
  
  return {
    path,
    name,
    type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
    size: stats.size,
    modified: stats.mtime,
    isHidden: name.startsWith('.'),
    extension: stats.isFile() ? extname(name) : undefined,
    permissions: (stats.mode & 0o777).toString(8),
    projectType: stats.isDirectory() ? await detectProjectType(path) : undefined,
  };
}

/**
 * File System Service Implementation
 */
class FileSystemServiceImpl implements FileSystemService {
  /**
   * List directory contents
   */
  async list(dirPath: string): Promise<Result<DirectoryListing>> {
    try {
      const resolved = resolve(dirPath);
      
      if (!isPathSafe(resolved)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      const items = await readdir(resolved);
      const nodes: FileNode[] = [];
      
      // Process items in parallel for performance
      await Promise.all(
        items.map(async (name) => {
          try {
            const itemPath = join(resolved, name);
            const node = await createFileNode(itemPath, name);
            nodes.push(node);
          } catch {
            // Skip items we can't access
          }
        })
      );
      
      // Sort: directories first, then alphabetically
      nodes.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });
      
      // Calculate parent path (if not at home)
      const parent = resolved !== HOME_DIR ? dirname(resolved) : undefined;
      
      return {
        ok: true,
        value: {
          path: resolved,
          parent: parent && isPathSafe(parent) ? parent : undefined,
          nodes,
        },
      };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
  
  /**
   * Read file contents
   */
  async read(filePath: string): Promise<Result<FileContent>> {
    try {
      const resolved = resolve(filePath);
      
      if (!isPathSafe(resolved)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      const [content, stats] = await Promise.all([
        readFile(resolved, 'utf8'),
        stat(resolved),
      ]);
      
      return {
        ok: true,
        value: {
          path: resolved,
          content,
          encoding: 'utf8',
          language: getLanguage(resolved),
          size: stats.size,
        },
      };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
  
  /**
   * Write file contents
   */
  async write(filePath: string, content: string): Promise<Result<FileNode>> {
    try {
      const resolved = resolve(filePath);
      
      if (!isPathSafe(resolved)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      // Ensure directory exists
      const dir = dirname(resolved);
      await mkdir(dir, { recursive: true });
      
      // Write file
      await writeFile(resolved, content, 'utf8');
      
      // Return file metadata
      const node = await createFileNode(resolved, basename(resolved));
      return { ok: true, value: node };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
  
  /**
   * Delete file or directory
   */
  async delete(filePath: string): Promise<Result<void>> {
    try {
      const resolved = resolve(filePath);
      
      if (!isPathSafe(resolved)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      // Prevent deleting home directory
      if (resolved === HOME_DIR) {
        return { ok: false, error: new Error('Cannot delete home directory') };
      }
      
      await unlink(resolved);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
  
  /**
   * Search for files and directories
   */
  async search(options: SearchOptions): Promise<Result<SearchResult[]>> {
    try {
      const { query, path = HOME_DIR, maxDepth = 3, includeHidden = false, limit = 50 } = options;
      const searchPath = resolve(path);
      
      if (!isPathSafe(searchPath)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      const results: SearchResult[] = [];
      const visited = new Set<string>();
      
      // Simple fuzzy match scoring
      const scoreMatch = (name: string, query: string): number => {
        const nameLower = name.toLowerCase();
        const queryLower = query.toLowerCase();
        
        if (nameLower === queryLower) return 100;
        if (nameLower.includes(queryLower)) return 80;
        
        // Character-by-character fuzzy match
        let score = 0;
        let queryIndex = 0;
        
        for (const char of nameLower) {
          if (queryIndex < queryLower.length && char === queryLower[queryIndex]) {
            score += 10;
            queryIndex++;
          }
        }
        
        return queryIndex === queryLower.length ? score : 0;
      };
      
      // Recursive search
      const searchDir = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth || visited.has(dir) || results.length >= limit) return;
        visited.add(dir);
        
        try {
          const items = await readdir(dir);
          
          await Promise.all(
            items.map(async (name) => {
              if (!includeHidden && name.startsWith('.')) return;
              if (results.length >= limit) return;
              
              const itemPath = join(dir, name);
              const score = scoreMatch(name, query);
              
              if (score > 0) {
                try {
                  const stats = await stat(itemPath);
                  results.push({
                    path: itemPath,
                    name,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    score,
                  });
                } catch {
                  // Skip inaccessible items
                }
              }
              
              // Recurse into directories
              try {
                const stats = await stat(itemPath);
                if (stats.isDirectory() && !name.startsWith('.')) {
                  await searchDir(itemPath, depth + 1);
                }
              } catch {
                // Skip
              }
            })
          );
        } catch {
          // Skip inaccessible directories
        }
      };
      
      await searchDir(searchPath, 0);
      
      // Sort by score (highest first)
      results.sort((a, b) => b.score - a.score);
      
      return { ok: true, value: results.slice(0, limit) };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
  
  /**
   * Get file/directory metadata
   */
  async metadata(filePath: string): Promise<Result<FileNode>> {
    try {
      const resolved = resolve(filePath);
      
      if (!isPathSafe(resolved)) {
        return { ok: false, error: new Error('Access denied: Path outside home directory') };
      }
      
      const node = await createFileNode(resolved, basename(resolved));
      return { ok: true, value: node };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}

export const fileSystemService = new FileSystemServiceImpl();