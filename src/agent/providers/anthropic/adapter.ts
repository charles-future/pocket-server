import { randomUUID } from 'node:crypto';
import { anthropicService } from '../../anthropic/anthropic';
import type { ServerMessage } from '../../anthropic/types';
import type { ProviderAdapter } from '../../core/adapters';

export class AnthropicAdapter implements ProviderAdapter {
  async send(message: any, apiKey: string, onMessage: (m: ServerMessage) => void): Promise<void> {
    try {
      console.log(
        JSON.stringify({
          at: 'provider_dispatch',
          provider: 'anthropic',
          sessionId: message?.sessionId,
          type: message?.type
        })
      );
    } catch {}
    switch (message.type) {
      case 'agent:message':
        await anthropicService.processMessage(message, apiKey, onMessage);
        break;
      case 'agent:tool_response':
        await anthropicService.processToolResponse(message, apiKey, onMessage);
        break;
      case 'agent:stop':
        anthropicService.stopStream(message.sessionId);
        // Emit a status and a synthetic stream_complete so the client reliably resets UI
        onMessage({ type: 'agent:status', sessionId: message.sessionId, phase: 'stopped' } as any);
        try {
          const session = anthropicService.getSession(message.sessionId);
          const state: any = session?.streamingState;
          if (state && (state.currentMessage || state.activeBlockContent || (state.contentBlocks && state.contentBlocks.length > 0))) {
            let blocks: any[] = Array.isArray(state.contentBlocks) ? [...state.contentBlocks] : [];
            if (state.activeBlockIndex != null && blocks[state.activeBlockIndex] && (blocks[state.activeBlockIndex] as any).type === 'text') {
              blocks[state.activeBlockIndex] = { type: 'text', text: state.activeBlockContent || '' } as any;
            }
            if (blocks.length === 0 && (state.activeBlockContent || '') !== '') {
              blocks = [{ type: 'text', text: state.activeBlockContent }] as any;
            }
            const finalMessage = {
              id: (state.currentMessage?.id as string) || randomUUID(),
              type: 'message',
              role: 'assistant',
              content: blocks,
              model: 'claude-sonnet-4-20250514',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            } as any;
            onMessage({ type: 'agent:stream_complete', sessionId: message.sessionId, finalMessage } as any);
          }
        } catch {}
        break;
      default:
        onMessage({ type: 'agent:error', sessionId: message.sessionId, error: `Unknown message type: ${message.type}` } as any);
    }
  }
}
