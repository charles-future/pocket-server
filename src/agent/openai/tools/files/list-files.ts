import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'list_files' as const;

export const definition = {
  type: 'function',
  name,
  description: 'List files and directories at a given path within the workspace.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative path to list' },
    },
    required: ['path'],
  },
} as const;

export const run: ToolHandler<{ path: string }, any> = async (input, { workingDir }) => {
  const res = await fileSystemService.list(resolvePath(workingDir, input.path));
  if (!res.ok) throw res.error;
  return res.value;
};


