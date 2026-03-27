import type { Router } from '../../server/router';
import { logger } from '../../shared/logger';
import { addFollowup, createAgent, deleteAgent, getAgent, getConversation, getMe, listAgents, listModels } from './client';
import { findPullRequestByBranch, getDefaultBranch, getStructuredDiff, getStructuredDiffFromCompare, parseRepositoryUrl } from './github';
import { cursorAgentTracker } from './tracker';
import type { CreateAgentInput } from './types';

function getApiKey(req: Request): string | null {
  // API key passed by mobile; never log it
  return req.headers.get('X-Cursor-Api-Key');
}

function getClientId(req: Request): string | undefined {
  return req.headers.get('X-Client-Id') || undefined;
}

export function registerCursorCloudRoutes(router: Router) {
  router.post('/cursor/agent', async (req) => {
    try {
      const apiKey = getApiKey(req);
      if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
      const body = (await req.json()) as CreateAgentInput;
      // Normalize repository URL to include scheme for Cursor API
      const normalizedRepo = body.source?.repository?.startsWith('http')
        ? body.source.repository
        : `https://${body.source.repository}`;
      const safeInput: CreateAgentInput = {
        ...body,
        source: { ...body.source, repository: normalizedRepo },
      };
      const created = await createAgent(apiKey, safeInput);
      // start tracking new agent until finished
      cursorAgentTracker.track(created.id, apiKey);
      return new Response(JSON.stringify(created), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'create_failed';
      logger.error('CloudCursor', 'create_agent_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.get('/cursor/agents', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') || 20);
    const cursor = url.searchParams.get('cursor') || undefined;
    try {
      const remote = await listAgents(apiKey, limit, cursor);
      // ensure active agents are tracked by server orchestrator
      cursorAgentTracker.ensureTracked(remote.agents || [], apiKey);
      return new Response(JSON.stringify(remote), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      const message = (e as any)?.message || 'list_failed';
      logger.error('CloudCursor', 'list_agents_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  // Snapshot endpoint for a single agent
  router.get('/cursor/agent/snapshot', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    try {
      // Try tracker snapshot first
      const snap = cursorAgentTracker.getSnapshot(id);
      if (snap?.agent || snap?.conversation) {
        return new Response(JSON.stringify({ agent: snap.agent, conversation: snap.conversation }), { headers: { 'Content-Type': 'application/json' } });
      }
      // Fallback: fetch agent (and try conversation if finished)
      const agent = await getAgent(apiKey, id);
      if (agent.status === 'FINISHED' || agent.status === 'ERROR' || agent.status === 'EXPIRED') {
        try {
          const conv = await getConversation(apiKey, id);
          return new Response(JSON.stringify({ agent, conversation: conv }), { headers: { 'Content-Type': 'application/json' } });
        } catch {}
      }
      return new Response(JSON.stringify({ agent }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'snapshot_failed';
      logger.error('CloudCursor', 'snapshot_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.get('/cursor/agent', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    try {
      const agent = await getAgent(apiKey, id);
      return new Response(JSON.stringify(agent), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'not_found';
      logger.error('CloudCursor', 'get_agent_failed', { message });
      return new Response(message, { status: 404 });
    }
  });

  router.get('/cursor/agent/conversation', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    try {
      const conv = await getConversation(apiKey, id);
      return new Response(JSON.stringify(conv), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'conv_failed';
      if (String(message).includes('cursor_conv_deleted')) {
        return new Response(JSON.stringify({ error: 'deleted' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
      }
      logger.error('CloudCursor', 'get_conversation_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.get('/cursor/agent/diff', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    
    // Get GitHub token from header
    const githubToken = req.headers.get('X-GitHub-Token');
    if (!githubToken) return new Response('Missing X-GitHub-Token', { status: 401 });
    
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    
    try {
      // First, get the agent details
      const agent = await getAgent(apiKey, id);

      // If PR exists, use it
      if (agent.target?.prUrl) {
        const diff = await getStructuredDiff(githubToken, agent.target.prUrl);
        if (!diff) {
          return new Response(JSON.stringify({ 
            error: 'Failed to fetch diff from GitHub',
            prUrl: agent.target.prUrl 
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ agentId: id, prUrl: agent.target.prUrl, diff }), { headers: { 'Content-Type': 'application/json' } });
      }

      // No PR yet — try to compute diffs via GitHub
      // 1) Parse owner/repo from agent.source.repository
      const repoInfo = parseRepositoryUrl(agent.source.repository.startsWith('http') ? agent.source.repository : `https://${agent.source.repository}`);
      if (!repoInfo) {
        return new Response(JSON.stringify({ error: 'Invalid repository URL', repository: agent.source.repository }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const { owner, repo } = repoInfo;

      // 2) Determine head branch from target.branchName; fallback to ref
      const headRef = agent.target?.branchName || agent.source.ref;
      if (!headRef) {
        return new Response(JSON.stringify({ error: 'No branch information available to compute diff' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      // 3) If a PR exists for this branch, use it
      const pr = await findPullRequestByBranch(githubToken, owner, repo, headRef);
      if (pr?.number) {
        const prUrl = `https://github.com/${owner}/${repo}/pull/${pr.number}`;
        const diff = await getStructuredDiff(githubToken, prUrl);
        if (diff) {
          return new Response(JSON.stringify({ agentId: id, prUrl, diff }), { headers: { 'Content-Type': 'application/json' } });
        }
      }

      // 4) Fallback: compare base...head
      const baseRef = (pr?.base?.ref as string) || (await getDefaultBranch(githubToken, owner, repo)) || 'main';
      const cmpDiff = await getStructuredDiffFromCompare(githubToken, owner, repo, baseRef, headRef);
      if (!cmpDiff) {
        return new Response(JSON.stringify({ error: 'No diff available yet', repository: `${owner}/${repo}`, baseRef, headRef }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ agentId: id, compare: { baseRef, headRef }, diff: cmpDiff }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (e: any) {
      const message = e?.message || 'diff_failed';
      logger.error('CloudCursor', 'get_diff_failed', { message, agentId: id });
      
      // Check for specific GitHub errors
      if (message.includes('401') || message.includes('Invalid GitHub token')) {
        return new Response(JSON.stringify({ error: 'Invalid GitHub token' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (message.includes('403') || message.includes('Access forbidden')) {
        return new Response(JSON.stringify({ error: 'Access forbidden - check repository permissions' }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (message.includes('404') || message.includes('not found')) {
        return new Response(JSON.stringify({ error: 'Diff not found' }), { 
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({ error: message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  router.post('/cursor/agent/followup', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    const body = (await req.json()) as { text: string; images?: { data: string; dimension?: { width: number; height: number } }[] };
    try {
      const result = await addFollowup(apiKey, id, body.text, body.images);
      // Re-track this agent in case it was previously completed and is now resuming
      cursorAgentTracker.track(id, apiKey);
      logger.info('CloudCursor', 'followup_resumed', { id });
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'followup_failed';
      logger.error('CloudCursor', 'followup_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.delete('/cursor/agent', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return new Response('missing id', { status: 400 });
    try {
      const result = await deleteAgent(apiKey, id);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'delete_failed';
      logger.error('CloudCursor', 'delete_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.get('/cursor/me', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    try {
      const me = await getMe(apiKey);
      return new Response(JSON.stringify(me), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'me_failed';
      logger.error('CloudCursor', 'me_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  router.get('/cursor/models', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    try {
      const models = await listModels(apiKey);
      return new Response(JSON.stringify(models), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
      const message = e?.message || 'models_failed';
      logger.error('CloudCursor', 'models_failed', { message });
      return new Response(message, { status: 500 });
    }
  });

  // Validation endpoint to test API keys
  router.get('/cursor/validate', async (req) => {
    const apiKey = getApiKey(req);
    if (!apiKey) return new Response('Missing X-Cursor-Api-Key', { status: 401 });
    
    try {
      logger.info('CloudCursor', 'validate_request', {
        providedHeader: 'X-Cursor-Api-Key',
        tokenPrefix: apiKey.substring(0, 6) + '...',
        tokenLength: apiKey.length,
      });
      // Try to get user info to validate the key
      const me = await getMe(apiKey);
      logger.info('CloudCursor', 'key_validated', { keyPrefix: apiKey.substring(0, 10) + '...' });
      return new Response(JSON.stringify({ 
        valid: true, 
        keyFormat: apiKey.substring(0, 10) + '...', 
        userInfo: me 
      }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    } catch (e: any) {
      const message = e?.message || 'validation_failed';
      logger.error('CloudCursor', 'key_validation_failed', { 
        keyPrefix: apiKey.substring(0, 10) + '...', 
        error: message 
      });
      return new Response(JSON.stringify({ 
        valid: false, 
        keyFormat: apiKey.substring(0, 10) + '...', 
        error: message 
      }), { 
        status: 200, // Return 200 so client can show the error details
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  });
}
