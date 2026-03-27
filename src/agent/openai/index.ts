/**
 * OpenAI (GPT-5) Provider - Entry
 * Registers HTTP routes and handles agent WebSocket messages for OpenAI.
 */

import type { Router } from '../../server/router';
import type { ServerMessage } from '../anthropic/types';
import { Orchestrator } from '../core/orchestrator';
import { OpenAIAdapter } from '../providers/openai/adapter';
import { sessionStoreFs } from '../store/session-store-fs';
import { openAIService } from './service';

export function registerOpenAIRoutes(router: Router): void {
  // Sessions parity with Anthropic routes
  router.post('/session', handleCreateSession);
  router.get('/session', handleGetSession);
  router.delete('/session', handleClearSession);
  router.get('/sessions', handleListSessions);
  router.get('/session/snapshot', handleGetSessionSnapshot);
  router.put('/session/title', handleUpdateTitle);
}

export async function handleOpenAIWebSocket(
  ws: WebSocket,
  clientId: string,
  message: any
): Promise<void> {
  const apiKey = message.apiKey || process.env.OPENAI_API_KEY;
  const sessionId: string | undefined = message.sessionId;

  const sendMessage = async (msg: ServerMessage) => {
    if (!sessionId) return; // guard
    try {
      if (msg.type === 'agent:title' && (msg as any).title) {
        await sessionStoreFs.updateTitle(sessionId, (msg as any).title);
      }
      if (msg.type === 'agent:tool_output' && (msg as any).message) {
        await sessionStoreFs.recordToolOutputMessage(sessionId, (msg as any).message);
      }
      if (msg.type === 'agent:stream_complete' && (msg as any).finalMessage) {
        await sessionStoreFs.recordAssistantFinalMessage(sessionId, (msg as any).finalMessage);
      }
      if (msg.type === 'agent:status' && (msg as any).phase) {
        await sessionStoreFs.recordStatus(sessionId, (msg as any).phase);
      }
    } catch {}
    const envelope = {
      v: 1,
      id: crypto.randomUUID(),
      correlationId: (msg as any).messageId || undefined,
      sessionId,
      ts: new Date().toISOString(),
      seq: sessionStoreFs.nextSeq(sessionId),
    } as any;
    ws.send(JSON.stringify({ ...envelope, ...msg }));
  };

  if (!apiKey) {
    const err: ServerMessage = {
      type: 'agent:error',
      sessionId: sessionId || 'unknown',
      error: 'No OpenAI API key. Provide apiKey in message or set OPENAI_API_KEY.'
    } as any;
    ws.send(JSON.stringify(err));
    return;
  }

  try {
    const orch = new Orchestrator(new OpenAIAdapter(), apiKey);
    await orch.handle(message, (m) => { void sendMessage(m as any); });
  } catch (error: any) {
    sendMessage({ type: 'agent:error', sessionId: sessionId!, error: error?.message || 'OpenAI handler error' } as any);
  }
}

async function handleCreateSession(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { workingDir = process.cwd(), maxMode = false } = body || {};
    const id = await sessionStoreFs.createSession({ workingDir, maxMode });
    return new Response(JSON.stringify({ id }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleGetSession(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  if (!sessionId) return new Response(JSON.stringify({ error: 'Session ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const snap = await sessionStoreFs.getSnapshot(sessionId);
  if (!snap) return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const sessionInfo = {
    id: snap.id,
    title: snap.title,
    createdAt: snap.createdAt,
    lastActivity: snap.lastActivity,
    messageCount: snap.messageCount,
    workingDir: snap.workingDir,
    maxMode: snap.maxMode,
  };
  return new Response(JSON.stringify(sessionInfo), { headers: { 'Content-Type': 'application/json' } });
}

async function handleClearSession(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  if (!sessionId) return new Response(JSON.stringify({ error: 'Session ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  await sessionStoreFs.clearSession(sessionId);
  openAIService.clearSession(sessionId);
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleListSessions(_req: Request): Promise<Response> {
  const list = await sessionStoreFs.listSessions();
  return new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetSessionSnapshot(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  if (!sessionId) return new Response(JSON.stringify({ error: 'Session ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const snapshot = await sessionStoreFs.getSnapshot(sessionId);
  if (!snapshot) return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } });
}

async function handleUpdateTitle(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { id, title } = body || {};
    if (!id || !title) return new Response(JSON.stringify({ error: 'id and title required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    await sessionStoreFs.updateTitle(id, title);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
