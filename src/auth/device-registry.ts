import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { resolveDataPath } from '../shared/paths';

export interface RegisteredDevice {
  deviceId: string;
  secret: string; // per-device secret for client proof
  platform?: string;
  name?: string;
  createdAt: string; // ISO
  lastSeen?: string; // ISO
  revoked?: boolean;
}

const DEVICES_PATH = resolveDataPath('auth', 'devices.json');

function ensureRegistry(): void {
  const dir = dirname(DEVICES_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(DEVICES_PATH)) writeFileSync(DEVICES_PATH, JSON.stringify([], null, 2), 'utf8');
}

export function loadDevices(): RegisteredDevice[] {
  try {
    ensureRegistry();
    const raw = readFileSync(DEVICES_PATH, 'utf8');
    const data = JSON.parse(raw) as RegisteredDevice[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveDevices(devices: RegisteredDevice[]): void {
  ensureRegistry();
  writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), 'utf8');
}

export function getDevice(deviceId: string): RegisteredDevice | undefined {
  const devices = loadDevices();
  return devices.find((d) => d.deviceId === deviceId);
}

export function upsertDevice(input: Omit<RegisteredDevice, 'createdAt'> & { createdAt?: string }): RegisteredDevice {
  const devices = loadDevices();
  const now = new Date().toISOString();
  const idx = devices.findIndex((d) => d.deviceId === input.deviceId);
  const toSave: RegisteredDevice = {
    deviceId: input.deviceId,
    secret: input.secret,
    platform: input.platform,
    name: input.name,
    createdAt: input.createdAt || now,
    lastSeen: now,
    revoked: input.revoked,
  };
  if (idx >= 0) devices[idx] = { ...devices[idx], ...toSave };
  else devices.push(toSave);
  saveDevices(devices);
  return toSave;
}

export function updateLastSeen(deviceId: string): void {
  const devices = loadDevices();
  const idx = devices.findIndex((d) => d.deviceId === deviceId);
  if (idx >= 0) {
    devices[idx].lastSeen = new Date().toISOString();
    saveDevices(devices);
  }
}

export function revokeDevice(deviceId: string): boolean {
  const devices = loadDevices();
  const idx = devices.findIndex((d) => d.deviceId === deviceId);
  if (idx >= 0) {
    devices[idx].revoked = true;
    saveDevices(devices);
    return true;
  }
  return false;
}


