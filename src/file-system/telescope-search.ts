/**
 * Telescope-like Search Service
 * Provides fast, fuzzy search capabilities across files, content, and symbols
 */

import { readdir, readFile, stat } from 'fs/promises';
import fuzzysort from 'fuzzysort';
import ignore from 'ignore';
import { basename, extname, join, relative } from 'path';
import type { Result } from '../shared/types/api';

export interface SearchResult {
  path: string;
  name: string;
  score: number;
  type: 'file' | 'directory';
  preview?: string;
  lineNumber?: number;
  matches?: Array<{ start: number; end: number }>;
}

export interface SearchOptions {
  query: string;
  cwd: string;
  mode: 'files' | 'content' | 'symbols' | 'all';
  limit?: number;
  includeHidden?: boolean;
  excludePatterns?: string[];
  maxDepth?: number;
}

export class TelescopeSearch {
  private fileCache = new Map<string, string[]>();
  private cacheTimeout = 30000; // 30 seconds cache
  private lastCacheTime = 0;

  /**
   * Main search entry point
   */
  async search(options: SearchOptions): Promise<Result<SearchResult[]>> {
    try {
      switch (options.mode) {
        case 'files':
          return await this.searchFiles(options);
        case 'content':
          return await this.searchContent(options);
        case 'symbols':
          return await this.searchSymbols(options);
        case 'all':
          return await this.searchAll(options);
        default:
          return { ok: true, value: [] };
      }
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Fast fuzzy file search using fuzzysort
   */
  private async searchFiles(options: SearchOptions): Promise<Result<SearchResult[]>> {
    try {
      const files = await this.getFileList(options.cwd, options);
      
      // Prepare files for fuzzysort
      const targets = files.map(file => ({
        file,
        target: file.replace(options.cwd + '/', ''),
      }));

      // Use fuzzysort for blazing fast fuzzy search
      const results = fuzzysort.go(options.query, targets, {
        key: 'target',
        limit: options.limit || 50,
        threshold: -10000, // Show all matches
      });

      return {
        ok: true,
        value: results.map((result, index) => ({
          path: result.obj.file,
          name: basename(result.obj.file),
          score: result.score,
          type: 'file' as const,
          matches: result.indexes?.map(i => ({ start: i, end: i + 1 })),
        })),
      };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Content search using JavaScript
   */
  private async searchContent(options: SearchOptions): Promise<Result<SearchResult[]>> {
    try {
      const files = await this.getFileList(options.cwd, options);
      const results: SearchResult[] = [];
      const searchQuery = options.query.toLowerCase();
      const isRegex = this.isRegexPattern(searchQuery);
      
      // Process files in parallel but limit concurrency
      const BATCH_SIZE = 10;
      const fileGroups = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        fileGroups.push(files.slice(i, i + BATCH_SIZE));
      }

      for (const group of fileGroups) {
        const groupResults = await Promise.all(
          group.map(async (file) => {
            // Skip binary files
            const ext = extname(file).toLowerCase();
            if (['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.exe', '.dll', '.so'].includes(ext)) {
              return [];
            }

            try {
              const content = await readFile(file, 'utf-8');
              const lines = content.split('\n');
              const fileResults: SearchResult[] = [];

              lines.forEach((line, index) => {
                const lineToSearch = line.toLowerCase();
                let matches = false;
                
                if (isRegex) {
                  try {
                    const regex = new RegExp(searchQuery, 'i');
                    matches = regex.test(line);
                  } catch {
                    matches = lineToSearch.includes(searchQuery);
                  }
                } else {
                  matches = lineToSearch.includes(searchQuery);
                }

                if (matches && fileResults.length < 5) { // Max 5 matches per file
                  fileResults.push({
                    path: file,
                    name: basename(file),
                    score: 100,
                    type: 'file',
                    preview: line.trim().substring(0, 200),
                    lineNumber: index + 1,
                  });
                }
              });

              return fileResults;
            } catch {
              return [];
            }
          })
        );

        results.push(...groupResults.flat());
        
        // Early exit if we have enough results
        if (results.length >= (options.limit || 50)) {
          break;
        }
      }

      return {
        ok: true,
        value: results.slice(0, options.limit || 50),
      };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Symbol search (functions, classes, etc.) using JavaScript
   */
  private async searchSymbols(options: SearchOptions): Promise<Result<SearchResult[]>> {
    try {
      const files = await this.getFileList(options.cwd, options);
      const results: SearchResult[] = [];
      const searchQuery = options.query.toLowerCase();
      
      // Symbol patterns to match
      const symbolPatterns = [
        /(?:function|const|let|var|class|interface)\s+(\w+)/g,
        /(?:export\s+(?:default\s+)?(?:function|const|class))\s+(\w+)/g,
        /(?:public|private|protected|static)\s+(\w+)\s*\(/g,
        /(\w+)\s*[:=]\s*(?:function|\(.*?\)\s*=>)/g, // Method/arrow function assignments
        /(?:def|func|fn)\s+(\w+)/g, // Python, Go, Rust
      ];

      // Only search in code files
      const codeExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.m', '.h'];
      const codeFiles = files.filter(f => codeExtensions.includes(extname(f).toLowerCase()));
      
      // Process files in parallel
      const BATCH_SIZE = 10;
      for (let i = 0; i < codeFiles.length && results.length < (options.limit || 50); i += BATCH_SIZE) {
        const batch = codeFiles.slice(i, i + BATCH_SIZE);
        
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            try {
              const content = await readFile(file, 'utf-8');
              const lines = content.split('\n');
              const fileResults: SearchResult[] = [];
              
              lines.forEach((line, index) => {
                // Try each pattern
                for (const pattern of symbolPatterns) {
                  const matches = [...line.matchAll(pattern)];
                  
                  for (const match of matches) {
                    const symbolName = match[1];
                    if (symbolName && symbolName.toLowerCase().includes(searchQuery)) {
                      fileResults.push({
                        path: file,
                        name: basename(file),
                        score: 100,
                        type: 'file',
                        preview: line.trim(),
                        lineNumber: index + 1,
                      });
                      break; // Only one match per line
                    }
                  }
                }
              });
              
              return fileResults;
            } catch {
              return [];
            }
          })
        );
        
        results.push(...batchResults.flat());
      }

      // Deduplicate and limit
      const seen = new Set<string>();
      const unique = results.filter(r => {
        const key = `${r.path}:${r.lineNumber}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return {
        ok: true,
        value: unique.slice(0, options.limit || 50),
      };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  /**
   * Combined search across files and content
   */
  private async searchAll(options: SearchOptions): Promise<Result<SearchResult[]>> {
    const [files, content] = await Promise.all([
      this.searchFiles({ ...options, limit: 25 }),
      this.searchContent({ ...options, limit: 25 }),
    ]);

    const results: SearchResult[] = [];
    
    if (files.ok) results.push(...files.value);
    if (content.ok) results.push(...content.value);

    // Sort by score and deduplicate
    const seen = new Set<string>();
    const unique = results
      .sort((a, b) => b.score - a.score)
      .filter(r => {
        if (seen.has(r.path)) return false;
        seen.add(r.path);
        return true;
      });

    return {
      ok: true,
      value: unique.slice(0, options.limit || 50),
    };
  }

  /**
   * Get cached or fresh file list
   */
  private async getFileList(dir: string, options: SearchOptions): Promise<string[]> {
    const now = Date.now();
    const cacheKey = `${dir}:${options.includeHidden}`;

    // Check cache
    if (this.fileCache.has(cacheKey) && now - this.lastCacheTime < this.cacheTimeout) {
      return this.fileCache.get(cacheKey)!;
    }

    // Build fresh list
    const files = await this.walkDirectory(dir, options, 0, options.maxDepth ?? 10);
    this.fileCache.set(cacheKey, files);
    this.lastCacheTime = now;

    return files;
  }

  /**
   * Recursively walk directory
   */
  private async walkDirectory(
    dir: string,
    options: SearchOptions,
    depth = 0,
    maxDepth = 10
  ): Promise<string[]> {
    if (depth > maxDepth) return [];

    const files: string[] = [];
    const ig = this.getIgnore(options);

    try {
      const entries = await readdir(dir);

      for (const entry of entries) {
        // Skip hidden files unless requested
        if (!options.includeHidden && entry.startsWith('.')) continue;

        const fullPath = join(dir, entry);
        const relativePath = relative(options.cwd, fullPath);

        // Check gitignore
        if (ig.ignores(relativePath)) continue;

        try {
          const stats = await stat(fullPath);

          if (stats.isDirectory()) {
            // Recurse into directory
            const subFiles = await this.walkDirectory(fullPath, options, depth + 1, maxDepth);
            files.push(...subFiles);
          } else if (stats.isFile()) {
            files.push(fullPath);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Skip inaccessible directories
    }

    return files;
  }

  /**
   * Get gitignore instance
   */
  private getIgnore(options: SearchOptions) {
    const ig = ignore();
    
    // Default ignores
    ig.add([
      'node_modules',
      '.git',
      '.DS_Store',
      '*.log',
      'dist',
      'build',
      '.next',
      '.nuxt',
      '.cache',
      'coverage',
      '.env*',
    ]);

    // Add custom excludes
    if (options.excludePatterns) {
      ig.add(options.excludePatterns);
    }

    return ig;
  }

  /**
   * Check if a query looks like a regex pattern
   */
  private isRegexPattern(query: string): boolean {
    // Common regex special characters
    return /[.*+?^${}()|[\]\\]/.test(query);
  }

}

// Export singleton instance
export const telescopeSearch = new TelescopeSearch();