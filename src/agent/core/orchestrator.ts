/**
 * Core Orchestrator (v1)
 * Minimal unification layer that delegates to provider adapters.
 * Future iterations can move full approval aggregation/state here.
 */

import type { ProviderAdapter } from './adapters';

export class Orchestrator {
  private adapter: ProviderAdapter;
  private apiKey: string;

  constructor(adapter: ProviderAdapter, apiKey: string) {
    this.adapter = adapter;
    this.apiKey = apiKey;
  }

  async handle(message: any, onMessage: (m: any) => void): Promise<void> {
    await this.adapter.send(message, this.apiKey, onMessage);
  }
}

