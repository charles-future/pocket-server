import crypto from 'crypto';
import type { Router } from '../server/router';
import { logger } from '../shared/logger';
import { getPublicBaseUrl } from '../shared/public-url';
import { getDevice, upsertDevice } from './device-registry';
import { isLocalRequest } from './middleware';
import { getPairingState, isPairingActive, recordRemotePairAttempt, verifyPin, verifyRemotePairToken } from './pairing';
import { signAccessToken } from './token';

export function registerAuthRoutes(router: Router): void {
  // Public: check if a device is registered
  router.get('/device/status', async (req) => {
    try {
      const url = new URL(req.url);
      const deviceId = url.searchParams.get('deviceId') || '';
      const device = deviceId ? getDevice(deviceId) : undefined;
      return new Response(JSON.stringify({ registered: !!device && !device.revoked }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ registered: false }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  // Public: pairing status
  router.get('/pair/status', async () => {
    try {
      const active = isPairingActive();
      const state = getPairingState();
      const expiresAt = active ? state.expiresAt ?? null : null;
      const now = Date.now();
      const secondsLeft = active && expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000)) : 0;
      const body = JSON.stringify({ active, mode: state.mode || 'local', expiresAt, secondsLeft });
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          // Disable caches for live countdowns
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Surrogate-Control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ active: false, expiresAt: null, secondsLeft: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
  });

  // Public: pair device (local by default; remote allowed only with active remote token)
  router.post('/pair', async (req) => {
    if (!isPairingActive()) {
      return new Response(JSON.stringify({ success: false, error: 'pairing_not_active' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const publicHost = getPublicBaseUrl();
    try {
      const body = await req.json() as { deviceId: string; pin: string; platform?: string; name?: string; reset?: boolean; pairToken?: string };
      if (!body?.deviceId || !body?.pin) {
        return new Response(JSON.stringify({ success: false, error: 'invalid_input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      // Determine locality and mode
      const local = isLocalRequest(req, publicHost);
      const state = getPairingState();
      if (!local) {
        // Remote requests are only allowed if pairing window is remote and token matches
        if (state.mode !== 'remote') {
          return new Response(JSON.stringify({ success: false, error: 'pairing_not_local' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        if (!body.pairToken || !verifyRemotePairToken(body.pairToken)) {
          recordRemotePairAttempt(false);
          return new Response(JSON.stringify({ success: false, error: 'pairing_denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
      }
      if (!verifyPin(body.pin)) {
        if (!local && state.mode === 'remote') recordRemotePairAttempt(false);
        return new Response(JSON.stringify({ success: false, error: 'invalid_pin' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      const existing = getDevice(body.deviceId);
      if (existing && !existing.revoked && !body.reset) {
        logger.info('Auth', 'device_already_paired', { deviceId: existing.deviceId });
        if (!local && state.mode === 'remote') recordRemotePairAttempt(true);
        return new Response(JSON.stringify({ success: true, alreadyPaired: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      const secret = existing && !existing.revoked && body.reset
        ? crypto.randomBytes(32).toString('hex')
        : crypto.randomBytes(32).toString('hex');
      const saved = upsertDevice({ deviceId: body.deviceId, secret, platform: body.platform, name: body.name });
      logger.info('Auth', existing && body.reset ? 'device_secret_rotated' : 'device_paired', { deviceId: saved.deviceId, platform: saved.platform, name: saved.name });
      if (!local && state.mode === 'remote') recordRemotePairAttempt(true);
      return new Response(JSON.stringify({ success: true, data: { deviceId: saved.deviceId, secret: saved.secret }, alreadyPaired: false }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      logger.error('Auth', 'pair_failed', e as any);
      return new Response(JSON.stringify({ success: false, error: 'pair_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });

  // Public: issue challenge
  router.post('/challenge', async (req) => {
    try {
      const body = await req.json() as { deviceId: string };
      if (!body?.deviceId) return new Response(JSON.stringify({ error: 'invalid_input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const device = getDevice(body.deviceId);
      if (!device || device.revoked) return new Response(JSON.stringify({ error: 'device_unregistered' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      const nonce = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      // Stateless nonce is okay if we require immediate token exchange; to keep minimal, we embed the nonce in the token request signed by device secret.
      return new Response(JSON.stringify({ nonce, expiresAt }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      logger.error('Auth', 'challenge_failed', e as any);
      return new Response(JSON.stringify({ error: 'challenge_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });

  // Public: exchange for token
  router.post('/token', async (req) => {
    try {
      const body = await req.json() as { deviceId: string; nonce: string; signature: string };
      if (!body?.deviceId || !body?.nonce || !body?.signature) return new Response(JSON.stringify({ error: 'invalid_input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const device = getDevice(body.deviceId);
      if (!device || device.revoked) return new Response(JSON.stringify({ error: 'device_unregistered' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      // Verify signature = sha256(secret + "\n" + deviceId + "\n" + nonce) as hex
      const expected = crypto.createHash('sha256').update(`${device.secret}\n${body.deviceId}\n${body.nonce}`).digest('hex');
      const sig = (body.signature || '').toLowerCase();
      if (expected.length !== sig.length) return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      const ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
      if (!ok) return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      const { token, expiresAt } = await signAccessToken({ deviceId: body.deviceId }, 15 * 60);
      return new Response(JSON.stringify({ token, expiresAt }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      logger.error('Auth', 'token_failed', e as any);
      return new Response(JSON.stringify({ error: 'token_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });
}


