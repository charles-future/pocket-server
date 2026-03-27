import { terminalService } from '../../../../file-system/terminal.js';
import type { ToolHandler } from '../types';
import { safeWorkingDir } from '../util';

export const name = 'execute_command' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Execute a shell command within project boundaries with timeout.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: ['string', 'null'], description: 'Optional working directory' },
      timeout_ms: { type: ['number', 'null'], description: 'Timeout in milliseconds (1000-120000)' },
    },
    required: ['command', 'cwd', 'timeout_ms'],
  },
} as const;

export const run: ToolHandler<{ command: string; cwd?: string; timeout_ms?: number }, any> = async (input, { workingDir }) => {
  const cwd = safeWorkingDir(workingDir);
  const timeout = Math.min(Math.max(input.timeout_ms ?? 30000, 1000), 120000);
  const result = await terminalService.execute({ command: input.command, cwd, timeout } as any);
  if (!result.ok) throw result.error;
  return result.value;
};


