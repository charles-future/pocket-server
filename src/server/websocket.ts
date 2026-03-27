/**
 * WebSocket connection handler
 * Manages WebSocket lifecycle and message routing
 */

import type { WebSocket as WSWebSocket } from 'ws';
import { logger } from '../shared/logger';
import type { WebSocketClient, WebSocketMessage } from '../shared/types/api';

// Export type alias for compatibility
export type ServerWebSocket = WSWebSocket;

class WebSocketManager {
  private clients: Map<string, WebSocketClient> = new Map();
  
  /**
   * Register a new WebSocket client
   */
  addClient(ws: WebSocket | WSWebSocket, clientId?: string, metadata?: Record<string, unknown>): string {
    const id = clientId || crypto.randomUUID();
    this.clients.set(id, { id, socket: ws as any, metadata });
    logger.websocket('client_connected', id, { clientCount: this.clients.size });
    return id;
  }
  
  /**
   * Remove a client from the registry
   */
  removeClient(id: string): void {
    if (this.clients.delete(id)) {
      logger.websocket('client_disconnected', id, { clientCount: this.clients.size });
    }
  }
  
  /**
   * Send message to a specific client
   */
  send(clientId: string, message: WebSocketMessage): void {
    const client = this.clients.get(clientId);
    if (client?.socket.readyState === 1) { // WebSocket.OPEN
      client.socket.send(JSON.stringify(message));
      logger.websocket('message_sent', clientId, { type: message.type });
    }
  }

  /**
   * Send binary data to a specific client (e.g., terminal frames)
   */
  sendBinary(clientId: string, data: Buffer | Uint8Array): void {
    const client = this.clients.get(clientId);
    if (client?.socket.readyState === 1) { // WebSocket.OPEN
      try {
        (client.socket as any).send(data, { binary: true });
        logger.websocket('binary_sent', clientId, { bytes: (data as any).byteLength ?? (data as any).length });
      } catch (e) {
        logger.websocket('binary_send_error', clientId, { error: (e as Error)?.message });
      }
    }
  }
  
  /**
   * Send raw data to a client (for compatibility)
   */
  sendRaw(data: any): void {
    // For compatibility with code that sends to all clients
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    for (const client of this.clients.values()) {
      if (client.socket.readyState === 1) {
        client.socket.send(message);
      }
    }
  }
  
  /**
   * Broadcast message to all connected clients
   */
  broadcast(message: WebSocketMessage): void {
    const payload = JSON.stringify(message);
    let sentCount = 0;
    for (const client of this.clients.values()) {
      if (client.socket.readyState === 1) { // WebSocket.OPEN
        client.socket.send(payload);
        sentCount++;
      }
    }
    logger.websocket('broadcast', 'all', { 
      type: message.type, 
      sentCount, 
      totalClients: this.clients.size 
    });
  }
  
  /**
   * Get client by ID
   */
  getClient(id: string): WebSocketClient | undefined {
    return this.clients.get(id);
  }
  
  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }
  
  /**
   * Get total number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }
  
  /**
   * Check if a client is connected
   */
  isConnected(id: string): boolean {
    const client = this.clients.get(id);
    return client?.socket.readyState === 1;
  }
}

export const wsManager = new WebSocketManager();