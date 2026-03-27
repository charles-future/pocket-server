import { fileSystemService } from '../../../../file-system/service.js';
import type { ToolHandler } from '../types';
import { resolvePath } from '../util';

export const name = 'append_to_file' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Append text to the end of a file. Creates the file if it does not exist.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Path of the file to append to' },
      text: { type: 'string', description: 'Text to append (may include newlines)' },
      ensure_newline: { type: ['boolean', 'null'], description: 'If true, ensure one newline before appending' },
    },
    required: ['path', 'text', 'ensure_newline'],
  },
} as const;

export const run: ToolHandler<{ path: string; text: string; ensure_newline?: boolean }, any> = async (input, { workingDir }) => {
  const full = resolvePath(workingDir, input.path);
  const ensureNewline = !!input.ensure_newline;

  // Try read; if not found, create new file with text
  const read = await fileSystemService.read(full);
  if (!read.ok) {
    const created = await fileSystemService.write(full, input.text);
    if (!created.ok) throw created.error;
    return `Successfully created ${input.path} and appended ${input.text.length} characters`;
  }

  const content = read.value.content || '';
  const needsNl = ensureNewline && content.length > 0 && !content.endsWith('\n');
  const next = (needsNl ? content + '\n' : content) + input.text;
  const writeRes = await fileSystemService.write(full, next);
  if (!writeRes.ok) throw writeRes.error;
  return `Successfully appended ${input.text.length} characters to ${input.path}`;
};

