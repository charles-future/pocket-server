import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'edit_in_file' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Replace text in a file. By default replaces the first occurrence unless replace_all is true.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path of the file to edit' },
      old: { type: 'string', description: 'Exact text to find' },
      new: { type: 'string', description: 'Replacement text' },
      replace_all: { type: ['boolean', 'null'], description: 'If true, replace all occurrences' },
    },
    required: ['path', 'old', 'new', 'replace_all'],
  },
} as const;

export const run: ToolHandler<{ path: string; old: string; new: string; replace_all?: boolean }, any> = async (input, { workingDir }) => {
  const readRes = await fileSystemService.read(resolvePath(workingDir, input.path));
  if (!readRes.ok) throw readRes.error;
  const original = readRes.value.content;
  if (!input.replace_all) {
    const idx = original.indexOf(input.old);
    if (idx < 0) throw new Error('Old string not found');
    const next = original.substring(0, idx) + input.new + original.substring(idx + input.old.length);
    const writeRes = await fileSystemService.write(resolvePath(workingDir, input.path), next);
    if (!writeRes.ok) throw writeRes.error;
    return { path: input.path, replaced: 1 };
  }
  const replacedAll = original.split(input.old).join(input.new);
  const writeRes = await fileSystemService.write(resolvePath(workingDir, input.path), replacedAll);
  if (!writeRes.ok) throw writeRes.error;
  return { path: input.path, replaced: 'all' };
};


