/**
 * Agent Module
 * Main entry point for all AI agent providers
 */

import { promises as fs } from 'fs';
import { basename, extname, join } from 'path';
import { getDevice, updateLastSeen } from '../auth/device-registry';
import { verifyAuthFromRequest } from '../auth/middleware';
import { verifyAccessToken } from '../auth/token';
import type { Router } from '../server/router';
import { wsManager } from '../server/websocket';
import { resolveDataPath } from '../shared/paths';
import { handleAgentWebSocket, registerAgentRoutes } from './anthropic/index';
import { handleOpenAIWebSocket, registerOpenAIRoutes } from './openai/index.js';
import { setInitiatorDeviceId } from './session-initiators';
import { sessionStoreFs } from './store/session-store-fs';

/**
 * Register all agent modules with the router
 */
export function registerAgentModule(router: Router): void {
  // Protect all agent routes
  router.usePre(async (req) => {
    const url = new URL(req.url);
    // Allow query-token auth for asset route as image components cannot set headers
    if (url.pathname.endsWith('/agent/session/asset')) {
      const token = url.searchParams.get('token') || '';
      if (token) {
        try {
          const payload = await verifyAccessToken(token);
          if (payload) {
            const device = getDevice(payload.deviceId);
            if (device && !device.revoked) {
              try { updateLastSeen(payload.deviceId); } catch {}
              return null;
            }
          }
        } catch {}
      }
    }
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });
  // Register Anthropic routes
  registerAgentRoutes(router);
  // Register OpenAI routes (provider encapsulation)
  registerOpenAIRoutes(router);

  // Asset route: serve session-scoped images
  router.get('/session/asset', async (req: Request) => {
    try {
      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      const file = url.searchParams.get('file');
      if (!id || !file) {
        return new Response(JSON.stringify({ error: 'missing_parameters' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const safe = basename(file);
      if (safe !== file) {
        return new Response(JSON.stringify({ error: 'invalid_file' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const filePath = join(resolveDataPath('sessions', id, 'images'), safe);
      const data = await fs.readFile(filePath);
      // Node exposes Buffer#buffer as ArrayBufferLike; slice narrows it back to ArrayBuffer for fetch Response bodies.
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      const ext = extname(safe).toLowerCase();
      const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'application/octet-stream';
      return new Response(arrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
  });

  // Initialize file-based session store
  void sessionStoreFs.init();
  
  // Future: Add other providers here
  // registerOpenAIRoutes(router);
  // registerGeminiRoutes(router);
}

/**
 * Handle agent-related WebSocket messages
 * Routes to appropriate provider based on message type
 */
export type AgentInboundMessage = {
  type?: string;
  provider?: string;
  sessionId?: string;
};

interface ClientMetadata {
  deviceId?: string;
}

export async function handleAgentMessage(
  ws: WebSocket,
  clientId: string,
  message: AgentInboundMessage
): Promise<void> {
  // Route based on message type prefix
  if (message.type?.startsWith('agent:')) {
    // Capture initiator device for this session (for targeted pushes)
    try {
      if (message.type === 'agent:message' && typeof message.sessionId === 'string') {
        const client = wsManager.getClient(clientId);
        const deviceId = (client?.metadata as ClientMetadata | undefined)?.deviceId;
        if (deviceId) {
          setInitiatorDeviceId(message.sessionId, deviceId);
          // Persist if snapshot already exists
          void sessionStoreFs.setInitiator(message.sessionId, deviceId);
        }
      }
    } catch {}
    // Provider selection: 'openai' | 'anthropic' (default to 'openai' if unspecified)
    const provider = (message.provider as string | undefined)?.toLowerCase();
    if (provider === 'anthropic') {
      await handleAgentWebSocket(ws, clientId, message);
    } else {
      await handleOpenAIWebSocket(ws, clientId, message);
    }
  }
  
  // Future: Route to other providers
  // if (message.type?.startsWith('openai:')) {
  //   await handleOpenAIWebSocket(ws, clientId, message);
  // }
}

// Re-export types
export type { 
  AgentSession,
  ClientMessage,
  Conversation,
  ServerMessage,
  ToolOutput, 
  ToolRequest
} from './anthropic/types';
