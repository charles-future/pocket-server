/**
 * Shared API types for WebSocket and HTTP communication
 */

export interface WebSocketMessage<T = any> {
  v: number;
  id: string;
  correlationId?: string;
  sessionId: string;
  ts: string;
  type: string;
  payload: T;
  timestamp: number;
}

export interface WebSocketClient {
  id: string;
  socket: any; // Support both browser WebSocket and ws library WebSocket
  metadata?: Record<string, unknown>;
}

export type Result<T> = 
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: Error;
    };

export interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  lastModified?: Date;
  permissions?: string;
}

export interface DirectoryListing {
  path: string;
  entries: FileInfo[];
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  match: string;
  preview: string;
}

export interface ServerStats {
  uptime: number;
  memory: {
    used: number;
    total: number;
  };
  connections: number;
  requests: {
    total: number;
    perMinute: number;
  };
}

/**
 * Terminal streaming payload (server → client)
 * Aggregated frame carrying raw UTF-8 text for a PTY session
 */
export interface TerminalFramePayload {
  id: string;
  seq: number;
  ts: number; // server-side timestamp (ms)
  data: string;
}

// Terminal control payloads (client -> server)
export interface TermOpenOrAttachPayload {
  id: string;
  cwd?: string;
  rows?: number;
  cols?: number;
  title?: string; // optional human-friendly name from mobile
}

export interface TermAttachPayload { id: string }

// Terminal listing (HTTP /terminal/sessions)
export interface TerminalListItem {
  id: string;
  title?: string;
  cwd: string;
  createdAt: number;
  cols?: number;
  rows?: number;
  active: boolean;
  ownerClientId?: string;
  ownerDeviceId?: string;
  lastAttachedAt?: number;
}

export interface TerminalListResponse {
  sessions: TerminalListItem[];
}

// Notifications API types
export interface PushDevice {
  deviceId: string;
  expoPushToken: string;
  platform: 'ios' | 'android';
  subscriptions?: string[];
  lastSeen: string; // ISO string
}

export interface PushRegisterRequest {
  deviceId: string;
  expoPushToken: string;
  platform: 'ios' | 'android';
  subscriptions?: string[];
}

export interface PushRegisterResponse {
  success: boolean;
  data?: PushDevice;
  error?: string;
}
