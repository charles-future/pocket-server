import { logger } from '../../shared/logger';
import type { ServerMessage } from '../anthropic/types';

interface HandleClientApprovalArgs {
  sessionId: string;
  toolResponse: { id: string; approved: boolean };
  apiKey: string;
  onMessage: (m: ServerMessage) => void;
  tools: any;
  previousResponseId?: string | null;
  workingDir?: string;
}

export const approvals = {
  async handleClientApproval({ sessionId, toolResponse, onMessage, apiKey, previousResponseId, workingDir = process.cwd() }: HandleClientApprovalArgs): Promise<void> {
    const { id, approved } = toolResponse;
    logger.agent('openai:client_approval', sessionId, { id, approved });
    // Acknowledge only; service.ts owns execution and continuation logic
    onMessage({ type: 'agent:approval', sessionId, approval: { id, approved } } as any);
  },
};
