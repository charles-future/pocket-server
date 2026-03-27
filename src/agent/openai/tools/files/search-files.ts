import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'search_files' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Search files by content with an efficient ripgrep backend.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: ['string', 'null'], description: 'Optional base path to limit search' },
      query: { type: 'string', description: 'Search query or regex' },
      maxDepth: { type: ['number', 'null'], description: 'Max directory depth (default 3)' },
      limit: { type: ['number', 'null'], description: 'Max results (default 50)' },
      includeHidden: { type: ['boolean', 'null'], description: 'Include hidden files (default false)' },
    },
    required: ['path', 'query', 'maxDepth', 'limit', 'includeHidden'],
  },
} as const;

export const run: ToolHandler<{ path?: string | null; query: string; maxDepth?: number | null; limit?: number | null; includeHidden?: boolean | null }, any> = async (input, { workingDir }) => {
  const res = await fileSystemService.search({
    query: input.query,
    path: input.path ? resolvePath(workingDir, input.path) : undefined,
    maxDepth: (input.maxDepth ?? undefined) as any,
    limit: (input.limit ?? undefined) as any,
    includeHidden: !!input.includeHidden,
  } as any);
  if (!res.ok) throw res.error;
  return res.value;
};


