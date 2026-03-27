/**
 * Core Title Generation
 * Shared title generator that prefers Anthropic when API key is available,
 * and falls back to a local heuristic otherwise. Usable by any provider.
 */

import Anthropic from '@anthropic-ai/sdk';

export async function generateConversationTitle(userMessage: string, anthropicApiKey?: string): Promise<string> {
  // Try Anthropic if a key is available (prefer mobile key, fallback to server env)
  const key = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 1500);
      
      try {
        const anthropic = new Anthropic({ apiKey: key });
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 20,
          temperature: 0.7,
          messages: [{
            role: 'user',
            content: `Generate a short title (max 3 words) for a conversation that starts with: "${userMessage}". Return only the title, no quotes or punctuation.`
          }]
        }, {
          signal: abortController.signal
        });
        clearTimeout(timeoutId);
        
        const content = response.content[0];
        if (content?.type === 'text') {
          const title = content.text.trim();
          const words = title.split(' ').filter(Boolean);
          return words.length > 3 ? words.slice(0, 3).join(' ') : (title || 'New Chat');
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Silently fall through to heuristic (includes timeout, auth errors, etc.)
    }
  }
  return generateFallbackTitle(userMessage);
}

function generateFallbackTitle(message: string): string {
  const lower = (message || '').toLowerCase();
  if (lower.includes('fix') || lower.includes('debug')) return 'Debug Issue';
  if (lower.includes('create') || lower.includes('build')) return 'Create Project';
  if (lower.includes('help') || lower.includes('how to')) return 'Help Request';
  if (lower.includes('error')) return 'Error Resolution';
  if (lower.includes('install')) return 'Installation';
  if (lower.includes('test')) return 'Testing';
  if (lower.includes('deploy')) return 'Deployment';
  if (lower.includes('update') || lower.includes('upgrade')) return 'Update Code';
  if (lower.includes('refactor')) return 'Refactoring';
  if (lower.includes('optimize')) return 'Optimization';
  const words = (message || '').split(' ').filter(Boolean).slice(0, 3);
  return words.length > 0 ? words.join(' ') : 'New Chat';
}

