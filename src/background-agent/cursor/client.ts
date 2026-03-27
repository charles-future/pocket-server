import type {
  CreateAgentInput,
  CursorAgentMinimal,
  CursorConversationResponse,
  CursorListAgentsResponse,
} from './types';

const CURSOR_BASE = 'https://api.cursor.com/v0';

import { logger } from '../../shared/logger';

function sanitizeBodyForLog(body: unknown): unknown {
  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    if (!obj || typeof obj !== 'object') return obj;
    const clone: any = JSON.parse(JSON.stringify(obj));
    // Redact webhook secrets if present
    if (clone?.webhook?.secret) {
      clone.webhook.secret = '[redacted]';
    }
    if (clone?.prompt?.images && Array.isArray(clone.prompt.images)) {
      clone.prompt.images = clone.prompt.images.map((img: any) => ({
        dataLen: img?.data ? String(img.data).length : 0,
        dimension: img?.dimension,
      }));
    }
    if (clone?.prompt?.text) {
      const txt: string = String(clone.prompt.text);
      clone.prompt.text = txt.length > 500 ? `${txt.slice(0, 500)}…` : txt;
    }
    return clone;
  } catch {
    return undefined;
  }
}

async function logResponseForDebug(url: string, auth: 'Bearer' | 'Basic', res: Response): Promise<void> {
  try {
    const clone = res.clone();
    const text = await clone.text();
    const snippet = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
    logger.info('Cursor', 'http_response', { url, auth, status: res.status, body: snippet });
  } catch {}
}

async function fetchWithAuth(apiKey: string, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input.toString();
  const sanitized = sanitizeBodyForLog(init.body as any);
  
  // Provide both Authorization and x-cursor-api-key headers for compatibility
  // Some Cursor endpoints expect x-cursor-api-key; others may accept Bearer
  const authInit: RequestInit = {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${apiKey}`,
      'x-cursor-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'pocket-server/1.0',
    },
  };
  
  // Extra diagnostics (do NOT log full keys)
  try {
    logger.info('Cursor', 'auth_debug', {
      hasAuthorization: !!(authInit.headers as any)?.Authorization,
      hasXCursorApiKey: !!(authInit.headers as any)?.['x-cursor-api-key'],
      tokenPrefix: `${apiKey.slice(0, 6)}...`,
      tokenLength: apiKey.length,
    });
  } catch {}

  logger.info('Cursor', 'http_request', { 
    url: urlStr, 
    method: init.method || 'GET', 
    auth: 'Bearer+x-cursor-api-key',
    body: sanitized 
  });
  
  const res = await fetch(input, authInit);
  await logResponseForDebug(urlStr, 'Bearer', res);
  
  return res;
}

export async function createAgent(apiKey: string, input: CreateAgentInput): Promise<CursorAgentMinimal> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/agents`, {
    method: 'POST',
    body: JSON.stringify({ ...input }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_create_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as CursorAgentMinimal;
}

export async function addFollowup(apiKey: string, id: string, text: string, images?: { data: string; dimension?: { width: number; height: number } }[]): Promise<{ id: string }> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/agents/${id}/followup`, {
    method: 'POST',
    body: JSON.stringify({ prompt: { text, ...(images?.length ? { images } : {}) } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_followup_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as { id: string };
}

export async function getAgent(apiKey: string, id: string): Promise<CursorAgentMinimal> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/agents/${id}`, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_get_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as CursorAgentMinimal;
}

export async function listAgents(apiKey: string, limit = 20, cursor?: string): Promise<CursorListAgentsResponse> {
  const url = new URL(`${CURSOR_BASE}/agents`);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);
  const res = await fetchWithAuth(apiKey, url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_list_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as CursorListAgentsResponse;
}

export async function getConversation(apiKey: string, id: string): Promise<CursorConversationResponse> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/agents/${id}/conversation`, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 409 && text && text.toLowerCase().includes('agent is deleted')) {
      throw new Error('cursor_conv_deleted');
    }
    throw new Error(`cursor_conv_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as CursorConversationResponse;
}

export async function deleteAgent(apiKey: string, id: string): Promise<{ id: string }> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/agents/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_delete_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as { id: string };
}

export async function getMe(apiKey: string): Promise<{ apiKeyName: string; createdAt: string; userEmail?: string }> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/me`, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_me_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as { apiKeyName: string; createdAt: string; userEmail?: string };
}

export async function listModels(apiKey: string): Promise<{ models: string[] }> {
  const res = await fetchWithAuth(apiKey, `${CURSOR_BASE}/models`, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cursor_models_failed status=${res.status} body=${text}`);
  }
  return (await res.json()) as { models: string[] };
}

