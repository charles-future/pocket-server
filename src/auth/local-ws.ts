import nodeCrypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolveDataPath } from '../shared/paths';

const LOCAL_WS_KEY_PATH = resolveDataPath('runtime', 'local-ws.key');

function ensureDir(): void {
  const dir = dirname(LOCAL_WS_KEY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getOrCreateLocalWsSecret(): string {
  ensureDir();
  if (!existsSync(LOCAL_WS_KEY_PATH)) {
    const buf = nodeCrypto.randomBytes(32);
    const token = buf.toString('base64url');
    writeFileSync(LOCAL_WS_KEY_PATH, token, 'utf8');
    try { (globalThis as any).__POCKET_LOCAL_WS_SECRET = token; } catch {}
    return token;
  }
  try {
    const raw = readFileSync(LOCAL_WS_KEY_PATH, 'utf8').trim();
    (globalThis as any).__POCKET_LOCAL_WS_SECRET = raw;
    return raw;
  } catch {
    const buf = nodeCrypto.randomBytes(32);
    const token = buf.toString('base64url');
    writeFileSync(LOCAL_WS_KEY_PATH, token, 'utf8');
    try { (globalThis as any).__POCKET_LOCAL_WS_SECRET = token; } catch {}
    return token;
  }
}

export function getLocalWsSecretFast(): string | null {
  const cached = (globalThis as any).__POCKET_LOCAL_WS_SECRET as string | undefined;
  return cached || null;
}

