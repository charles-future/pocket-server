import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolveDataPath } from './paths';

const RUNTIME_PATH = resolveDataPath('runtime', 'public-base-url.json');

function ensureDir() {
  const dir = dirname(RUNTIME_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function setPublicBaseUrl(url: string | null): void {
  ensureDir();
  const data = { url };
  writeFileSync(RUNTIME_PATH, JSON.stringify(data, null, 2));
}

export function getPublicBaseUrl(): string | null {
  try {
    const raw = readFileSync(RUNTIME_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { url?: string | null };
    return parsed.url ?? null;
  } catch {
    return null;
  }
}


