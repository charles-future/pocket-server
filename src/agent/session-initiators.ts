/**
 * Simple in-memory mapping of agent session -> initiating deviceId.
 * This complements the persisted snapshot's initiatorDeviceId, providing
 * an early mapping before the snapshot is created.
 */

const initiators = new Map<string, string>();

export function setInitiatorDeviceId(sessionId: string, deviceId: string): void {
  if (!sessionId || !deviceId) return;
  if (!initiators.has(sessionId)) {
    initiators.set(sessionId, deviceId);
  }
}

export function getInitiatorDeviceId(sessionId: string): string | undefined {
  return initiators.get(sessionId);
}

