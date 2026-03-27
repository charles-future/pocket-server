export interface TurnResult {
  toolRequests?: Array<{ id: string; name: string; input: any; description?: string; responseId?: string }>;
  finalBlocks?: any[];
  responseId?: string;
}

export interface ProviderAdapter {
  // Generic dispatcher used by the orchestrator to forward client messages
  send(message: any, apiKey: string, onMessage: (m: any) => void): Promise<void>;
}

