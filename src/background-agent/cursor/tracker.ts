import { notificationsService } from '../../notifications/index';
import { wsManager } from '../../server/websocket';
import { logger } from '../../shared/logger';
import { getAgent, getConversation } from './client';
import type { CursorAgentMinimal, CursorConversationResponse } from './types';

type TrackedAgent = {
  id: string;
  apiKey: string;
  lastStatus?: CursorAgentMinimal['status'];
  lastAgent?: CursorAgentMinimal;
  conversation?: CursorConversationResponse;
  nextPollAt: number;
};

/**
 * CursorAgentTracker
 * Single orchestrator for polling Cursor safely and pushing WS updates.
 */
class CursorAgentTracker {
  private tracked = new Map<string, TrackedAgent>();
  private completed = new Map<string, { agent: CursorAgentMinimal; conversation?: CursorConversationResponse; expiresAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private readonly POLL_MS = 8000; // status cadence
  private readonly COMPLETED_TTL_MS = 15 * 60 * 1000; // 15m

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  track(id: string, apiKey: string) {
    const existing = this.tracked.get(id);
    if (existing) {
      // update apiKey if changed
      if (apiKey && existing.apiKey !== apiKey) existing.apiKey = apiKey;
      return;
    }
    // If this agent was previously marked completed, clear the cached snapshot
    if (this.completed.has(id)) {
      this.completed.delete(id);
    }
    this.tracked.set(id, {
      id,
      apiKey,
      nextPollAt: Date.now(),
    });
    this.start();
    logger.info('CursorTracker', 'track', { id });
  }

  ensureTracked(agents: CursorAgentMinimal[], apiKey: string) {
    agents.forEach(a => {
      if (a.status === 'CREATING' || a.status === 'RUNNING') {
        this.track(a.id, apiKey);
      }
    });
  }

  untrack(id: string) {
    this.tracked.delete(id);
  }

  getSnapshot(id: string): { agent?: CursorAgentMinimal; conversation?: CursorConversationResponse } | null {
    // Prefer live tracked state if available
    const t = this.tracked.get(id);
    if (t && (t.lastAgent || t.conversation)) {
      return { agent: t.lastAgent, conversation: t.conversation };
    }
    // Fallback to completed snapshot
    const done = this.completed.get(id);
    if (done) return { agent: done.agent, conversation: done.conversation };
    return null;
  }

  private async tick() {
    const now = Date.now();
    for (const t of this.tracked.values()) {
      if (t.nextPollAt > now) continue;
      // schedule next status poll
      t.nextPollAt = now + this.POLL_MS;
      try {
        const agent = await getAgent(t.apiKey, t.id);
        const statusChanged = agent.status !== t.lastStatus;
        t.lastStatus = agent.status;
        t.lastAgent = agent;

        if (statusChanged) {
          wsManager.broadcast({
            v: 1,
            id: crypto.randomUUID(),
            sessionId: 'cloud',
            ts: new Date().toISOString(),
            type: 'cloud:cursor:status',
            payload: { id: agent.id, status: agent.status, summary: agent.summary, target: agent.target },
            timestamp: Date.now(),
          });
        }

        if ((agent.status === 'FINISHED' || agent.status === 'ERROR' || agent.status === 'EXPIRED')) {
          // Finalize: fetch conversation once, store snapshot, stop polling
          let conv: CursorConversationResponse | undefined ;
          try {
            conv = await getConversation(t.apiKey, t.id);
            wsManager.broadcast({
              v: 1,
              id: crypto.randomUUID(),
              sessionId: 'cloud',
              ts: new Date().toISOString(),
              type: 'cloud:cursor:conversation',
              payload: { id: t.id, messages: conv.messages },
              timestamp: Date.now(),
            });
          } catch (e) {
            const msg = String((e as any)?.message || '');
            if (!msg.includes('cursor_conv_deleted')) {
              logger.error('CursorTracker', 'conversation_failed', e as any);
            }
          }
          // Push iOS notifications via Expo
          try {
            await notificationsService.notifyCloudAgentCompleted({
              id: t.id,
              status: agent.status,
              summary: agent.summary,
              target: agent.target,
            });
          } catch (e) {
            logger.error('Notifications', 'notify_failed', e as any);
          }
          this.completed.set(t.id, { agent, conversation: conv, expiresAt: Date.now() + this.COMPLETED_TTL_MS });
          this.tracked.delete(t.id); // stop polling entirely for finished
        }
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (msg.includes('404')) {
          // agent not found; stop tracking
          this.untrack(t.id);
        } else if (msg.includes('429')) {
          // rate limit: push back next poll
          t.nextPollAt = Date.now() + 30000;
        }
      }
    }
    // Cleanup expired completed snapshots
    const now2 = Date.now();
    for (const [id, snap] of this.completed.entries()) {
      if (snap.expiresAt <= now2) this.completed.delete(id);
    }
    if (this.tracked.size === 0) this.stop();
  }
}

export const cursorAgentTracker = new CursorAgentTracker();
