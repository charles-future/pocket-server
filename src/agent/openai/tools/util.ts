import { resolve } from 'node:path';

export function safeWorkingDir(dir?: string): string {
  return dir && dir.trim().length > 0 ? dir : process.cwd();
}

export function resolvePath(baseDir: string, path: string): string {
  return resolve(baseDir, path);
}


