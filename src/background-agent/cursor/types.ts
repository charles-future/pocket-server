/**
 * Cursor Background Agent Types
 */

export type CloudAgentStatus = 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'EXPIRED';

// Local persistent records removed with webhook-less design

export interface CreateAgentInput {
  prompt: { text: string; images?: { data: string; dimension?: { width: number; height: number } }[] };
  source: { repository: string; ref?: string };
  model?: string; // optional model name; if omitted, Cursor picks
  target?: { autoCreatePr?: boolean };
}

export interface CursorAgentMinimal {
  id: string;
  name: string;
  status: CloudAgentStatus;
  source: { repository: string; ref?: string };
  target?: { branchName?: string; url?: string; prUrl?: string; autoCreatePr?: boolean };
  summary?: string;
  createdAt: string;
}

export interface CursorListAgentsResponse {
  agents: CursorAgentMinimal[];
  nextCursor?: string;
}

export interface CursorConversationMessage {
  id: string;
  type: 'user_message' | 'assistant_message';
  text: string;
}

export interface CursorConversationResponse {
  id: string;
  messages: CursorConversationMessage[];
}

// Local persistent record for webhook-driven updates and listing
export interface CloudAgentRecord {
  id: string;
  name: string;
  status: CloudAgentStatus;
  source: { repository: string; ref?: string };
  target?: { branchName?: string; url?: string; prUrl?: string; autoCreatePr?: boolean };
  summary?: string;
  createdAt: string;
  updatedAt: string;
  ownerClientId?: string;
}

