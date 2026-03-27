import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'write_file' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Write full content to a file, replacing prior content.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
} as const;

export const run: ToolHandler<{ path: string; content: string }, any> = async (input, { workingDir }) => {
  const res = await fileSystemService.write(resolvePath(workingDir, input.path), input.content);
  if (!res.ok) throw res.error;
  return { path: res.value.path, name: res.value.name };
};


