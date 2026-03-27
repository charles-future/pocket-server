/**
 * Web Search Tool Implementation
 * Web search is handled server-side by Anthropic API
 * This file provides the tool definition and helper functions
 */

import type { WebSearchResult, WebSearchTool, WebSearchToolInput } from '../types';

/**
 * Web search tool definition for Anthropic API
 */
export const webSearchToolDefinition: WebSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5 // Default to 5 searches per request
};

/**
 * Create web search tool with custom configuration
 */
export function createWebSearchTool(config?: {
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}): WebSearchTool {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: config?.maxUses ?? 5,
    allowed_domains: config?.allowedDomains,
    blocked_domains: config?.blockedDomains
  };
}

/**
 * Execute web search (placeholder - actual search is done by Anthropic)
 */
export async function executeWebSearch(
  input: WebSearchToolInput,
  workingDir: string
): Promise<string> {
  // Web search is handled by Anthropic API server-side
  // This is just a placeholder for consistency
  return 'Web search in progress...';
}

/**
 * Format web search results for display
 */
export function formatWebSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return 'No search results found';
  }

  const lines = [`Found ${results.length} search results:\n`];
  
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.page_age) {
      lines.push(`   Last updated: ${result.page_age}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Check if web search is safe (always true for max mode)
 */
export function isWebSearchDangerous(input: WebSearchToolInput): boolean {
  // Web search is always considered safe for auto-approval
  return false;
}