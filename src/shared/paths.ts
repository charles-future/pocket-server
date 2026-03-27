import { existsSync, mkdirSync } from 'fs';
import os from 'os';
import { join } from 'path';

/**
 * Resolves a path under the server's data directory.
 * Defaults to process.env.POCKET_DATA_DIR || <homedir>/.pocket-server/data
 */
export function resolveDataPath(...segments: string[]): string {
  const defaultBase = join(os.homedir(), '.pocket-server', 'data');
  const base = process.env.POCKET_DATA_DIR ? process.env.POCKET_DATA_DIR : defaultBase;
  const full = join(base, ...segments);
  return full;
}

/** Ensures that a directory exists. */
export function ensureDirPath(dirPath: string): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}



