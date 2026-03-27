import { getDevice, updateLastSeen } from './device-registry';
import { verifyAccessToken } from './token';

export async function verifyAuthFromRequest(req: Request): Promise<{ ok: true; deviceId: string } | { ok: false; status: number; reason: string }> {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Pocket ')) {
    return { ok: false, status: 401, reason: 'missing_token' } as const;
  }
  const token = auth.slice('Pocket '.length).trim();
  const payload = await verifyAccessToken(token);
  if (!payload) {
    return { ok: false, status: 401, reason: 'invalid_token' } as const;
  }
  const device = getDevice(payload.deviceId);
  if (!device || device.revoked) {
    return { ok: false, status: 401, reason: 'device_unregistered' } as const;
  }
  try { updateLastSeen(payload.deviceId); } catch {}
  return { ok: true, deviceId: payload.deviceId } as const;
}

export function isLocalRequest(req: Request, publicHost?: string | null): boolean {
  try {
    const url = new URL(req.url);
    const host = url.hostname;
    // If request Host matches known public host, treat as non-local
    if (publicHost && publicHost.includes(host)) return false;
    // RFC1918 ranges and localhost
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.startsWith('10.')) return true;
    const parts = host.split('.');
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  } catch {
    return false;
  }
}


