/**
 * Anthropic Agent Module
 * Exports and route registration
 */

import type { Router } from '../../server/router';
import { Orchestrator } from '../core/orchestrator';
import { AnthropicAdapter } from '../providers/anthropic/adapter';
import { sessionStoreFs } from '../store/session-store-fs';
import { anthropicService } from './anthropic';
import type { ClientMessage, ServerMessage } from './types';

/**
 * Register agent routes with the router
 */
export function registerAgentRoutes(router: Router): void {
  // HTTP endpoints for non-streaming operations
  router.post('/generate-title', handleGenerateTitle);
  // sessions
  router.post('/session', handleCreateSession);
  router.get('/session', handleGetSession);
  router.delete('/session', handleClearSession);
  router.get('/sessions', handleListSessions);
  router.get('/session/snapshot', handleGetSessionSnapshot);
  router.put('/session/title', handleUpdateTitle);
}

/**
 * Handle agent WebSocket messages
 */
export async function handleAgentWebSocket(
  ws: WebSocket,
  clientId: string,
  message: any
): Promise<void> {
  const clientMessage = message as ClientMessage;
  
  // Extract API key from message or use environment variable
  const apiKey = message.apiKey || process.env.ANTHROPIC_API_KEY;
  try {
    console.log(
      JSON.stringify({
        at: 'ws_message_received',
        provider: 'anthropic',
        clientId,
        sessionId: clientMessage?.sessionId,
        type: clientMessage?.type
      })
    );
  } catch {}
  
  if (!apiKey) {
    const errorMessage: ServerMessage = {
      type: 'agent:error',
      sessionId: clientMessage.sessionId,
      error: 'No API key provided. Please provide apiKey in message or set ANTHROPIC_API_KEY environment variable.'
    };
    ws.send(JSON.stringify(errorMessage));
    return;
  }

  // Message callback to send responses back through WebSocket with envelope
  const sendMessage = async (msg: ServerMessage) => {
    const sid = clientMessage.sessionId;
    // Persist based on message type before emitting
    try {
      if (msg.type === 'agent:title' && (msg as any).title) {
        await sessionStoreFs.updateTitle(sid, (msg as any).title);
      }
      if (msg.type === 'agent:tool_output' && (msg as any).message) {
        await sessionStoreFs.recordToolOutputMessage(sid, (msg as any).message);
      }
      if (msg.type === 'agent:stream_complete' && (msg as any).finalMessage) {
        await sessionStoreFs.recordAssistantFinalMessage(sid, (msg as any).finalMessage);
      }
      if (msg.type === 'agent:status' && (msg as any).phase) {
        await sessionStoreFs.recordStatus(sid, (msg as any).phase);
      }
    } catch (e) {
      // best-effort persistence; continue emitting
      console.error('[Agent] Persistence error:', e);
    }
    const envelope = {
      v: 1,
      id: crypto.randomUUID(),
      correlationId: (msg as any).messageId || undefined,
      sessionId: sid,
      ts: new Date().toISOString(),
      seq: sessionStoreFs.nextSeq(sid),
    } as any;
    try {
      console.log(
        JSON.stringify({
          at: 'ws_message_send',
          provider: 'anthropic',
          sessionId: sid,
          type: msg?.type,
          seq: envelope.seq,
          turnId: (msg as any)?.turnId,
          event: (msg as any)?.event
        })
      );
    } catch {}
    ws.send(JSON.stringify({ ...envelope, ...msg }));
  };

  try {
    const orch = new Orchestrator(new AnthropicAdapter(), apiKey);
    await orch.handle(clientMessage, (m) => { void sendMessage(m as any); });
  } catch (error: any) {
    console.error('[Agent] Error handling WebSocket message:', error);
    sendMessage({
      type: 'agent:error',
      sessionId: clientMessage.sessionId,
      error: error.message
    });
  }
}

/**
 * HTTP handler for title generation
 */
async function handleGenerateTitle(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { message, apiKey } = body;
    
    if (!message) {
      return new Response(JSON.stringify({ error: 'Message required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!effectiveApiKey) {
      return new Response(JSON.stringify({ error: 'API key required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const title = await anthropicService.generateTitle(message, effectiveApiKey);
    
    return new Response(JSON.stringify({ title }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * HTTP handler for creating a session
 */
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

/**
 * HTTP handler for getting session
 */
async function handleGetSession(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const snap = await sessionStoreFs.getSnapshot(sessionId);
  if (!snap) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const sessionInfo = {
    id: snap.id,
    title: snap.title,
    createdAt: snap.createdAt,
    lastActivity: snap.lastActivity,
    messageCount: snap.messageCount,
    workingDir: snap.workingDir,
    maxMode: snap.maxMode,
  };
  
  return new Response(JSON.stringify(sessionInfo), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * HTTP handler for clearing session
 */
async function handleClearSession(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  await sessionStoreFs.clearSession(sessionId);
  anthropicService.clearSession(sessionId);
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * HTTP handler for listing sessions
 */
async function handleListSessions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workingDir = url.searchParams.get('workingDir') || undefined;
  const list = await sessionStoreFs.listSessions(workingDir ? { workingDir } : undefined);
  return new Response(JSON.stringify(list), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * HTTP handler for getting a session snapshot
 */
async function handleGetSessionSnapshot(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('id');
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Session ID required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const snapshot = await sessionStoreFs.getSnapshot(sessionId);
  if (!snapshot) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  // Merge runtime activeTurn from either provider service if present
  let activeTurn: any = undefined;
  try {
    const rtA = (await import('./anthropic.js')).anthropicService.getSnapshot(sessionId) as any;
    if (rtA && (rtA as any).activeTurn) activeTurn = (rtA as any).activeTurn;
  } catch {}
  try {
    const rtO = (await import('../openai/service.js')).openAIService as any;
    if (!activeTurn && typeof rtO.peekActiveTurn === 'function') {
      const t = rtO.peekActiveTurn(sessionId);
      if (t) activeTurn = t;
    }
  } catch {}
  const merged = { ...snapshot, ...(activeTurn ? { activeTurn } : {}) };
  return new Response(JSON.stringify(merged), {
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * HTTP handler for updating a session title
 */
async function handleUpdateTitle(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { id, title } = body || {};
    if (!id || !title) {
      return new Response(JSON.stringify({ error: 'id and title required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    await sessionStoreFs.updateTitle(id, title);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// Export service for direct access if needed
export { anthropicService } from './anthropic';
export type * from './types';
