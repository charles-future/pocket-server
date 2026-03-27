import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { verifyAuthFromRequest } from '../auth/middleware';
import type { Router } from '../server/router';
import { logger } from '../shared/logger';
import { resolveDataPath } from '../shared/paths';

type Platform = 'ios' | 'android';

export interface PushDevice {
  deviceId: string;
  expoPushToken: string;
  platform: Platform;
  subscriptions?: string[];
  lastSeen: string; // ISO string
}

const DEVICES_PATH = resolveDataPath('notifications', 'devices.json');

function ensureRegistry(): void {
  const dir = dirname(DEVICES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(DEVICES_PATH)) {
    writeFileSync(DEVICES_PATH, JSON.stringify([]), 'utf8');
  }
}

function loadDevices(): PushDevice[] {
  try {
    ensureRegistry();
    const raw = readFileSync(DEVICES_PATH, 'utf8');
    const data = JSON.parse(raw) as PushDevice[];
    if (!Array.isArray(data)) return [];
    return data;
  } catch (e) {
    logger.error('Notifications', 'load_devices_failed', e as any);
    return [];
  }
}

function saveDevices(devices: PushDevice[]): void {
  try {
    ensureRegistry();
    writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), 'utf8');
  } catch (e) {
    logger.error('Notifications', 'save_devices_failed', e as any);
  }
}

function isValidExpoToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith('ExponentPushToken[');
}

async function sendExpoPush(messages: Array<{ to: string; title: string; body?: string; data?: Record<string, unknown> }>): Promise<void> {
  if (!messages.length) return;
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error('Notifications', 'expo_push_failed', { status: response.status, text });
    } else {
      // We could parse receipts, but not required for v1
      logger.info('Notifications', 'expo_push_sent', { count: messages.length });
    }
  } catch (e) {
    logger.error('Notifications', 'expo_push_error', e as any);
  }
}

export const notificationsService = {
  registerDevice(input: { deviceId: string; expoPushToken: string; platform: Platform; subscriptions?: string[] }): PushDevice | null {
    const { deviceId, expoPushToken, platform, subscriptions } = input;
    if (!deviceId || !expoPushToken || !platform) return null;
    if (!isValidExpoToken(expoPushToken)) {
      logger.warn('Notifications', 'invalid_expo_token', { deviceId });
      return null;
    }
    const devices = loadDevices();
    const now = new Date().toISOString();
    const idx = devices.findIndex(d => d.deviceId === deviceId);
    const updated: PushDevice = { deviceId, expoPushToken, platform, subscriptions, lastSeen: now };
    if (idx >= 0) {
      devices[idx] = { ...devices[idx], ...updated };
    } else {
      devices.push(updated);
    }
    saveDevices(devices);
    return updated;
  },

  unregisterDevice(input: { deviceId: string }): boolean {
    const { deviceId } = input;
    const devices = loadDevices();
    const before = devices.length;
    const after = devices.filter(d => d.deviceId !== deviceId);
    if (after.length !== before) {
      saveDevices(after);
      return true;
    }
    return false;
  },

  async notifyCloudAgentCompleted(payload: { id: string; status: string; summary?: string; target?: { url?: string; prUrl?: string; branchName?: string } }): Promise<void> {
    const devices = loadDevices();
    if (!devices.length) return;
    const title = payload.status === 'FINISHED' ? 'Cloud agent completed' : payload.status === 'ERROR' ? 'Cloud agent failed' : 'Cloud agent expired';
    const body = payload.summary || payload.target?.branchName || payload.target?.url || payload.target?.prUrl || payload.id;
    const url = `/cloud-agents?agentId=${encodeURIComponent(payload.id)}`;

    const messages = devices.map(d => ({
      to: d.expoPushToken,
      title,
      body,
      data: { url, agentId: payload.id, status: payload.status },
    }));
    await sendExpoPush(messages);
  },

  async notifyAgentPlanProgress(input: {
    deviceId: string;
    sessionId: string;
    sessionTitle: string;
    kind: 'created' | 'next' | 'completed';
    stepIndex: number; // 1-based when kind !== 'completed'
    total: number;
    taskTitle: string;
  }): Promise<void> {
    const devices = loadDevices();
    const target = devices.find(d => d.deviceId === input.deviceId);
    if (!target) return;
    const title = input.sessionTitle || 'Agent';
    const body = input.kind === 'completed'
      ? `Completed ${input.total}/${input.total} steps`
      : `Step ${input.stepIndex}/${input.total} — ${truncate(input.taskTitle, 120)}`;
    const url = `/chat?sessionId=${encodeURIComponent(input.sessionId)}`;
    await sendExpoPush([{ to: target.expoPushToken, title, body, data: { url, sessionId: input.sessionId, kind: input.kind } }]);
  },
};

function truncate(s: string, n: number): string {
  if (!s) return s;
  return s.length <= n ? s : (s.slice(0, n - 1) + '…');
}

export function registerNotificationRoutes(router: Router): void {
  // Protect notifications routes
  router.usePre(async (req) => {
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ success: false, error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });
  router.post('/register', async (req) => {
    try {
      const body = (await req.json()) as { deviceId: string; expoPushToken: string; platform: Platform; subscriptions?: string[] };
      const saved = notificationsService.registerDevice(body);
      if (!saved) return new Response(JSON.stringify({ success: false, error: 'invalid_input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ success: true, data: saved }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      logger.error('Notifications', 'register_failed', e as any);
      return new Response(JSON.stringify({ success: false, error: 'register_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });

  router.delete('/register', async (req) => {
    try {
      const body = (await req.json()) as { deviceId: string };
      if (!body?.deviceId) return new Response(JSON.stringify({ success: false, error: 'missing_deviceId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const ok = notificationsService.unregisterDevice({ deviceId: body.deviceId });
      return new Response(JSON.stringify({ success: true, data: { removed: ok } }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      logger.error('Notifications', 'unregister_failed', e as any);
      return new Response(JSON.stringify({ success: false, error: 'unregister_failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });
}
