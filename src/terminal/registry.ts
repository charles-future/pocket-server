import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ensureDirPath, resolveDataPath } from '../shared/paths';

export interface TerminalInfo {
  id: string;
  title?: string;
  cwd: string;
  createdAt: number;
  cols?: number;
  rows?: number;
  active: boolean;
  ownerClientId?: string;
  ownerDeviceId?: string;
  lastAttachedAt?: number;
}

type PersistShape = { sessions: TerminalInfo[]; updatedAt: number };

/**
 * TerminalRegistry maintains lightweight metadata about terminal sessions
 * so that other clients/CLI can list and identify sessions by friendly name.
 */
export class TerminalRegistry {
  private items = new Map<string, TerminalInfo>();
  private filePath: string;

  constructor() {
    const dir = resolveDataPath('runtime');
    ensureDirPath(dir);
    this.filePath = resolveDataPath('runtime', 'term-sessions.json');
    this.init();
  }

  private init(): void {
    // On boot, create/clear the registry file to avoid stale data after restarts
    try {
      const empty: PersistShape = { sessions: [], updatedAt: Date.now() };
      writeFileSync(this.filePath, JSON.stringify(empty, null, 2), 'utf8');
    } catch {}
  }

  private persist(): void {
    try {
      const payload: PersistShape = {
        sessions: Array.from(this.items.values()).sort((a, b) => a.createdAt - b.createdAt),
        updatedAt: Date.now(),
      };
      writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {}
  }

  upsert(meta: Partial<TerminalInfo> & { id: string }): TerminalInfo {
    const prev = this.items.get(meta.id);
    const next: TerminalInfo = {
      id: meta.id,
      cwd: meta.cwd ?? prev?.cwd ?? process.cwd(),
      createdAt: prev?.createdAt ?? Date.now(),
      title: meta.title ?? prev?.title,
      cols: meta.cols ?? prev?.cols,
      rows: meta.rows ?? prev?.rows,
      active: meta.active ?? prev?.active ?? false,
      ownerClientId: meta.ownerClientId ?? prev?.ownerClientId,
      ownerDeviceId: meta.ownerDeviceId ?? prev?.ownerDeviceId,
      lastAttachedAt: meta.lastAttachedAt ?? prev?.lastAttachedAt,
    };
    this.items.set(meta.id, next);
    this.persist();
    return next;
  }

  setTitle(id: string, title: string): void {
    const prev = this.items.get(id);
    if (!prev) return;
    prev.title = title;
    this.items.set(id, prev);
    this.persist();
  }

  setActive(id: string, isActive: boolean): void {
    const prev = this.items.get(id);
    if (!prev) return;
    prev.active = isActive;
    this.items.set(id, prev);
    this.persist();
  }

  remove(id: string): void {
    if (this.items.delete(id)) this.persist();
  }

  list(): TerminalInfo[] {
    return Array.from(this.items.values());
  }
}

