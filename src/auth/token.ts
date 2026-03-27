import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { jwtVerify, SignJWT } from 'jose';
import { dirname, join } from 'path';
import { resolveDataPath } from '../shared/paths';

const SERVER_SECRET_PATH = resolveDataPath('runtime', 'server-secret.json');

function ensureSecret(): Uint8Array {
  const dir = dirname(SERVER_SECRET_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(SERVER_SECRET_PATH)) {
    const random = crypto.getRandomValues(new Uint8Array(32));
    const json = { k: Buffer.from(random).toString('base64url') };
    writeFileSync(SERVER_SECRET_PATH, JSON.stringify(json, null, 2), 'utf8');
  }
  const raw = readFileSync(SERVER_SECRET_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { k: string };
  const key = Buffer.from(parsed.k, 'base64url');
  return new Uint8Array(key);
}

// Node <20 WebCrypto getRandomValues polyfill via node:crypto
import nodeCrypto from 'crypto';

const crypto = globalThis.crypto ?? (nodeCrypto.webcrypto as any);

export interface AccessTokenPayload {
  deviceId: string;
}

export async function signAccessToken(payload: AccessTokenPayload, ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
  const key = ensureSecret();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const token = await new SignJWT({ deviceId: payload.deviceId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setSubject(payload.deviceId)
    .sign(key);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const key = ensureSecret();
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    const deviceId = String(payload.sub ?? payload.deviceId ?? '');
    if (!deviceId) return null;
    return { deviceId };
  } catch {
    return null;
  }
}


