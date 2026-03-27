import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'read_file' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Read a text file from the workspace and return its content.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path of the file to read' },
    },
    required: ['path'],
  },
} as const;

export const run: ToolHandler<{ path: string }, any> = async (input, { workingDir }) => {
  const res = await fileSystemService.read(resolvePath(workingDir, input.path));
  if (!res.ok) throw res.error;
  return res.value;
};


