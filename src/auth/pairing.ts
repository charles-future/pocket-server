import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolveDataPath } from '../shared/paths';

type PairingMode = 'local' | 'remote';

type PairingState = {
  active: boolean;
  pinHash?: string; // sha256 of pin
  startedAt?: string;
  expiresAt?: string;
  mode?: PairingMode;
  pairToken?: string; // random base64url token for remote pairing
  attempts?: number; // number of failed attempts (remote only)
  maxAttempts?: number; // cap failed attempts (remote only)
};

const PAIRING_PATH = resolveDataPath('runtime', 'pairing.json');

function ensureStateFile(): void {
  const dir = dirname(PAIRING_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(PAIRING_PATH)) writeFileSync(PAIRING_PATH, JSON.stringify({ active: false }, null, 2), 'utf8');
}

export function getPairingState(): PairingState {
  try {
    ensureStateFile();
    const raw = readFileSync(PAIRING_PATH, 'utf8');
    const data = JSON.parse(raw) as PairingState;
    return data;
  } catch {
    return { active: false };
  }
}

function savePairingState(state: PairingState): void {
  ensureStateFile();
  writeFileSync(PAIRING_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function startPairingWindow(durationMs = 60_000, pin?: string, remote: boolean = false): { pin: string; expiresAt: string; pairToken?: string; mode: PairingMode } {
  const generated = typeof pin === 'string' && pin.length === 6 ? pin : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const pinHash = crypto.createHash('sha256').update(generated).digest('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + durationMs);
  const state: PairingState = {
    active: true,
    pinHash,
    startedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    mode: remote ? 'remote' : 'local',
    pairToken: remote ? crypto.randomBytes(24).toString('base64url') : undefined,
    attempts: 0,
    maxAttempts: remote ? 5 : undefined,
  };
  savePairingState(state);
  return { pin: generated, expiresAt: state.expiresAt!, pairToken: state.pairToken, mode: state.mode! };
}

export function stopPairingWindow(): void {
  savePairingState({ active: false });
}

export function isPairingActive(): boolean {
  const s = getPairingState();
  if (!s.active) return false;
  if (!s.expiresAt) return false;
  const withinWindow = Date.now() < new Date(s.expiresAt).getTime();
  if (!withinWindow) return false;
  if (s.mode === 'remote' && typeof s.maxAttempts === 'number' && typeof s.attempts === 'number') {
    return s.attempts < s.maxAttempts;
  }
  return true;
}

export function verifyPin(pin: string): boolean {
  const s = getPairingState();
  if (!s.active || !s.pinHash || !s.expiresAt) return false;
  if (Date.now() >= new Date(s.expiresAt).getTime()) return false;
  const hash = crypto.createHash('sha256').update(pin).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(s.pinHash, 'hex'));
}

/**
 * Verify remote pairing token (constant-time where practical)
 */
export function verifyRemotePairToken(token: string): boolean {
  const s = getPairingState();
  if (!s.active || s.mode !== 'remote' || !s.pairToken || !s.expiresAt) return false;
  if (Date.now() >= new Date(s.expiresAt).getTime()) return false;
  try {
    const a = Buffer.from(String(token), 'utf8');
    const b = Buffer.from(String(s.pairToken), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Record a remote pairing attempt. On success or exhaustion, closes the window.
 */
export function recordRemotePairAttempt(success: boolean): void {
  const s = getPairingState();
  if (!s.active) return;
  if (s.mode !== 'remote') return;
  if (success) {
    savePairingState({ active: false });
    return;
  }
  const attempts = (s.attempts || 0) + 1;
  const maxAttempts = typeof s.maxAttempts === 'number' ? s.maxAttempts : 5;
  if (attempts >= maxAttempts) {
    savePairingState({ active: false });
  } else {
    savePairingState({ ...s, attempts });
  }
}


