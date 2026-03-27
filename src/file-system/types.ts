/**
 * File System Module Types
 * Clean, minimal type definitions for file operations
 */

import type { Result } from '../shared/types/api';

export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: Date;
  isHidden: boolean;
  
  // Optional metadata
  extension?: string;
  permissions?: string;
  projectType?: 'git' | 'node' | 'python' | 'bun' | 'unknown';
}

export interface DirectoryListing {
  path: string;
  parent?: string;
  nodes: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  language?: string;
  size: number;
}

export interface SearchOptions {
  query: string;
  path?: string;
  maxDepth?: number;
  includeHidden?: boolean;
  limit?: number;
}

export interface SearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  score: number;
  preview?: string;
}

export interface TerminalCommand {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface TerminalOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
}

// Service interfaces
export interface FileSystemService {
  list(path: string): Promise<Result<DirectoryListing>>;
  read(path: string): Promise<Result<FileContent>>;
  write(path: string, content: string): Promise<Result<FileNode>>;
  delete(path: string): Promise<Result<void>>;
  search(options: SearchOptions): Promise<Result<SearchResult[]>>;
  metadata(path: string): Promise<Result<FileNode>>;
}

export interface TerminalService {
  execute(cmd: TerminalCommand): Promise<Result<TerminalOutput>>;
  isCommandSafe(command: string): boolean;
}