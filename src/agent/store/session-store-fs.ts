/**
 * SessionStoreFs
 * File-based, single-writer session store with per-session serialization.
 * - One directory per session: <base>/<sessionId>/
 *   - snapshot.json: authoritative snapshot for fast rebuild
 *   - events.jsonl: append-only log for debugging/audits (best-effort)
 * - index.json: lightweight list of sessions for quick sidebar rendering
 *
 * Notes:
 * - No retention policy here (user deletes via API/UI)
 * - We store workingDir and support filtering in list endpoint
 * - We generate a per-session seq in-memory; snapshot persists lastSeq on major writes
 */

import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { resolveDataPath } from '../../shared/paths';
import type { ContentBlock, MessageParam, StreamingState, ToolRequest } from '../anthropic/types';

type Json = Record<string, unknown>;

interface SessionIndexItem {
  id: string;
  title: string;
  createdAt: string; // ISO
  lastActivity: string; // ISO
  messageCount: number;
  workingDir: string;
  maxMode: boolean;
  phase?: string;
}

interface Snapshot {
  id: string;
  title: string;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
  workingDir: string;
  maxMode: boolean;
  phase?: string;
  pendingTools?: ToolRequest[];
  initiatorDeviceId?: string;
  previousResponseId?: string;
  workPlan?: {
    createdAt: string;
    updatedAt: string;
    items: Array<{
      id: string;
      title: string;
      order: number;
      estimated_seconds?: number;
      status: 'pending' | 'complete';
      completedAt?: string;
    }>;
  };
  conversation: { messages: MessageParam[] };
  streamingState?: StreamingState;
  lastSeq?: number;
}

function ensureArray<T>(v: T[] | undefined): T[] { return Array.isArray(v) ? v : []; }

class SessionStoreFs {
  private baseDir: string;
  private indexPath: string;
  private writeQueues = new Map<string, Promise<void>>();
  private lastSeq = new Map<string, number>();

  constructor(baseDir?: string) {
    const root = baseDir || resolve(resolveDataPath('sessions'));
    this.baseDir = root;
    this.indexPath = join(root, 'index.json');
  }

  async init(): Promise<void> {
    await this.ensureDir(this.baseDir);
    try {
      await fs.access(this.indexPath);
    } catch {
      await this.atomicWriteJson(this.indexPath, []);
    }
  }

  // --- Public API ---

  async createSession(opts: { workingDir: string; maxMode?: boolean; title?: string; id?: string }): Promise<string> {
    const id = opts.id || (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    const dir = this.sessionDir(id);
    await this.enqueue(id, async () => {
      await this.ensureDir(dir);
      const now = new Date().toISOString();
      const snap: Snapshot = {
        id,
        title: opts.title || 'New Chat',
        createdAt: now,
        lastActivity: now,
        messageCount: 0,
        workingDir: opts.workingDir || '',
        maxMode: !!opts.maxMode,
        phase: 'created',
        pendingTools: [],
        initiatorDeviceId: undefined,
        conversation: { messages: [] },
        streamingState: {
          currentMessage: null,
          contentBlocks: [],
          activeBlockIndex: null,
          activeBlockContent: '',
          isStreaming: false,
          error: null,
        },
        lastSeq: 0,
      };
      await this.writeSnapshot(id, snap);
      await this.upsertIndex({
        id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: 0,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
      this.lastSeq.set(id, 0);
    });
    return id;
  }

  async updateTitle(sessionId: string, newTitle: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      snap.title = newTitle;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      await this.rmrf(this.sessionDir(sessionId));
      // remove from index
      const list = await this.readIndex();
      const filtered = list.filter((s) => s.id !== sessionId);
      await this.atomicWriteJson(this.indexPath, filtered);
      this.lastSeq.delete(sessionId);
    });
  }

  async listSessions(filter?: { workingDir?: string }): Promise<SessionIndexItem[]> {
    const list = await this.readIndex();
    if (filter?.workingDir) {
      return list.filter((s) => s.workingDir === filter.workingDir);
    }
    return list;
  }

  async getSnapshot(sessionId: string): Promise<Snapshot | undefined> {
    return this.readSnapshot(sessionId);
  }

  async recordUserMessage(sessionId: string, content: string, opts: { workingDir: string; maxMode?: boolean; titleIfFirst?: string }): Promise<void> {
    if (!sessionId) throw new Error('recordUserMessage requires a valid sessionId');
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return; // caller must create session first
      // Update maxMode and workingDir if provided (reflect latest request settings)
      if (typeof opts.maxMode === 'boolean') {
        snap.maxMode = !!opts.maxMode;
      }
      if (opts.workingDir && opts.workingDir !== snap.workingDir) {
        snap.workingDir = opts.workingDir;
      }
      // If first message, set title if provided
      if (snap.messageCount === 0 && opts.titleIfFirst && snap.title === 'New Chat') {
        snap.title = opts.titleIfFirst;
      }
      // Append user message (string content)
      snap.conversation.messages.push({ role: 'user', content } satisfies MessageParam);
      snap.messageCount = snap.conversation.messages.length;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'user_message', content, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  /**
   * Persist a user message containing structured content blocks (e.g., images + text).
   * This stores the blocks array as-is to allow the client to re-render images on reload.
   */
  async recordUserMessageBlocks(sessionId: string, blocks: ContentBlock[], opts: { workingDir: string; maxMode?: boolean; titleIfFirst?: string }): Promise<void> {
    if (!sessionId) throw new Error('recordUserMessageBlocks requires a valid sessionId');
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      if (typeof opts.maxMode === 'boolean') {
        snap.maxMode = !!opts.maxMode;
      }
      if (opts.workingDir && opts.workingDir !== snap.workingDir) {
        snap.workingDir = opts.workingDir;
      }
      if (snap.messageCount === 0 && opts.titleIfFirst && snap.title === 'New Chat') {
        snap.title = opts.titleIfFirst;
      }
      snap.conversation.messages.push({ role: 'user', content: Array.isArray(blocks) ? blocks : [] } satisfies MessageParam);
      snap.messageCount = snap.conversation.messages.length;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'user_message_blocks', blocksCount: Array.isArray(blocks) ? blocks.length : 0, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async setInitiator(sessionId: string, deviceId: string): Promise<void> {
    if (!sessionId || !deviceId) return;
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      if (!snap.initiatorDeviceId) {
        snap.initiatorDeviceId = deviceId;
        snap.lastActivity = new Date().toISOString();
        await this.writeSnapshot(sessionId, snap);
        await this.appendEvent(sessionId, { type: 'initiator_set', deviceId, ts: snap.lastActivity });
        await this.upsertIndex({
          id: snap.id,
          title: snap.title,
          createdAt: snap.createdAt,
          lastActivity: snap.lastActivity,
          messageCount: snap.messageCount,
          workingDir: snap.workingDir,
          maxMode: snap.maxMode,
          phase: snap.phase,
        });
      }
    });
  }

  async recordWorkPlanCreate(sessionId: string, items: Array<{ id: string; title: string; order: number; estimated_seconds?: number }>): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      const now = new Date().toISOString();
      snap.workPlan = {
        createdAt: now,
        updatedAt: now,
        items: items.map((it) => ({ ...it, status: 'pending' as const })),
      };
      snap.lastActivity = now;
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'work_plan_created', items: items.map(i => ({ id: i.id, title: i.title, order: i.order })), ts: now });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async recordWorkPlanComplete(sessionId: string, id: string): Promise<
    | { total: number; completed: number; completedItem: { id: string; title: string }; next?: { id: string; title: string } }
    | null
  > {
    let result: { total: number; completed: number; completedItem: { id: string; title: string }; next?: { id: string; title: string } } | null = null;
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap || !snap.workPlan) return;
      const plan = snap.workPlan;
      const found = plan.items.find((it) => it.id === id);
      if (!found) return;
      if (found.status !== 'complete') {
        found.status = 'complete';
        found.completedAt = new Date().toISOString();
        plan.updatedAt = found.completedAt;
      }
      const total = plan.items.length;
      const completed = plan.items.filter((it) => it.status === 'complete').length;
      const nextPending = plan.items
        .filter((it) => it.status !== 'complete')
        .sort((a, b) => a.order - b.order)[0];
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'work_plan_completed', id, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
      result = {
        total,
        completed,
        completedItem: { id: found.id, title: found.title },
        next: nextPending ? { id: nextPending.id, title: nextPending.title } : undefined,
      };
    });
    return result;
  }

  async recordWorkPlanRevise(sessionId: string, items: Array<{ id: string; title?: string; order?: number; estimated_seconds?: number; remove?: boolean }>): Promise<{ total: number } | null> {
    let totalOut: number | null = null;
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap || !snap.workPlan) return;
      const plan = snap.workPlan;
      const map = new Map(plan.items.map((it) => [it.id, it] as const));
      for (const upd of items) {
        if (upd.remove) {
          if (map.has(upd.id)) map.delete(upd.id);
          continue;
        }
        const cur = map.get(upd.id);
        if (cur) {
          if (typeof upd.title === 'string') cur.title = upd.title;
          if (typeof upd.order === 'number') cur.order = upd.order;
          if (typeof upd.estimated_seconds === 'number') cur.estimated_seconds = upd.estimated_seconds;
        } else {
          map.set(upd.id, {
            id: upd.id,
            title: upd.title || upd.id,
            order: typeof upd.order === 'number' ? upd.order : map.size + 1,
            estimated_seconds: upd.estimated_seconds,
            status: 'pending',
          });
        }
      }
      plan.items = Array.from(map.values()).sort((a, b) => a.order - b.order);
      plan.updatedAt = new Date().toISOString();
      snap.lastActivity = plan.updatedAt;
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'work_plan_revised', items, ts: snap.lastActivity });
      totalOut = plan.items.length;
    });
    return totalOut === null ? null : { total: totalOut };
  }

  async recordAssistantFinalMessage(sessionId: string, finalMessage: any): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      // Merge by id if present
      const id = finalMessage?.id;
      if (id) {
        const idx = snap.conversation.messages.findIndex((m: any) => m.id === id);
        if (idx >= 0) {
          snap.conversation.messages[idx] = finalMessage;
        } else {
          snap.conversation.messages.push(finalMessage);
        }
      } else {
        snap.conversation.messages.push(finalMessage);
      }
      snap.messageCount = snap.conversation.messages.length;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'assistant_message', message: finalMessage, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async recordToolOutputMessage(sessionId: string, message: any): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      snap.conversation.messages.push(message);
      snap.messageCount = snap.conversation.messages.length;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'tool_output_message', message, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async recordStatus(sessionId: string, phase: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      snap.phase = phase;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'status', phase, ts: snap.lastActivity });
      await this.upsertIndex({
        id: snap.id,
        title: snap.title,
        createdAt: snap.createdAt,
        lastActivity: snap.lastActivity,
        messageCount: snap.messageCount,
        workingDir: snap.workingDir,
        maxMode: snap.maxMode,
        phase: snap.phase,
      });
    });
  }

  async setPreviousResponseId(sessionId: string, previousResponseId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const snap = await this.readSnapshot(sessionId);
      if (!snap) return;
      snap.previousResponseId = previousResponseId;
      snap.lastActivity = new Date().toISOString();
      await this.writeSnapshot(sessionId, snap);
      await this.appendEvent(sessionId, { type: 'prev_response_id', previousResponseId, ts: snap.lastActivity });
    });
  }

  nextSeq(sessionId: string): number {
    const current = this.lastSeq.get(sessionId) ?? 0;
    const next = current + 1;
    this.lastSeq.set(sessionId, next);
    return next;
  }

  // --- Internals ---

  private sessionDir(id: string): string {
    return join(this.baseDir, id);
  }

  private async readIndex(): Promise<SessionIndexItem[]> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const list = JSON.parse(raw) as SessionIndexItem[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async upsertIndex(item: SessionIndexItem): Promise<void> {
    const list = await this.readIndex();
    const idx = list.findIndex((s) => s.id === item.id);
    if (idx >= 0) list[idx] = item; else list.unshift(item);
    await this.atomicWriteJson(this.indexPath, list);
  }

  private async readSnapshot(sessionId: string): Promise<Snapshot | undefined> {
    try {
      const raw = await fs.readFile(join(this.sessionDir(sessionId), 'snapshot.json'), 'utf8');
      const snap = JSON.parse(raw) as Snapshot;
      // Initialize seq cache
      if (typeof snap.lastSeq === 'number' && !this.lastSeq.has(sessionId)) {
        this.lastSeq.set(sessionId, snap.lastSeq);
      }
      return snap;
    } catch {
      return undefined;
    }
  }

  private async writeSnapshot(sessionId: string, snap: Snapshot): Promise<void> {
    // Persist lastSeq if present
    const seq = this.lastSeq.get(sessionId);
    if (typeof seq === 'number') snap.lastSeq = seq;
    const file = join(this.sessionDir(sessionId), 'snapshot.json');
    await this.atomicWriteJson(file, snap);
  }

  private async appendEvent(sessionId: string, event: Json): Promise<void> {
    try {
      const file = join(this.sessionDir(sessionId), 'events.jsonl');
      await fs.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      // best-effort; ignore
    }
  }

  private async ensureDir(path: string): Promise<void> {
    try {
      await fs.mkdir(path, { recursive: true });
    } catch {}
  }

  private async rmrf(path: string): Promise<void> {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch {}
  }

  private async atomicWriteJson(path: string, obj: any): Promise<void> {
    const tmp = path + '.tmp';
    await this.ensureDir(dirname(path));
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fs.rename(tmp, path);
  }

  private enqueue(sessionId: string, op: () => Promise<void>): Promise<void> {
    const current = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = current.then(op).catch(() => {}).then(() => {
      // no-op
    });
    this.writeQueues.set(sessionId, next);
    return next;
  }
}

export const sessionStoreFs = new SessionStoreFs();
