import type { ServerMessage } from '../../anthropic/types';
import type { ProviderAdapter } from '../../core/adapters';
import { openAIService } from '../../openai/service';

export class OpenAIAdapter implements ProviderAdapter {
  async send(message: any, apiKey: string, onMessage: (m: ServerMessage) => void): Promise<void> {
    switch (message.type) {
      case 'agent:message':
        await openAIService.processMessage(message, apiKey, onMessage);
        break;
      case 'agent:tool_response':
        await openAIService.processToolResponse(message, apiKey, onMessage);
        break;
      case 'agent:stop':
        openAIService.stopStream(message.sessionId);
        onMessage({ type: 'agent:status', sessionId: message.sessionId, phase: 'stopped' } as any);
        break;
      default:
        onMessage({ type: 'agent:error', sessionId: message.sessionId, error: `Unknown message type: ${message.type}` } as any);
    }
  }
}
