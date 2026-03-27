import { terminalService } from '../../../../file-system/terminal.js';
import type { ToolHandler } from '../types';
import { safeWorkingDir } from '../util';

export const name = 'get_git_working_state' as const;

export const definition = {
  type: 'function',
  name,
  description: 'Show git status -s and diff --stat for the current working directory.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cwd: { type: ['string', 'null'], description: 'Optional cwd (defaults to working directory)' },
    },
    required: ['cwd'],
  },
} as const;

export const run: ToolHandler<{ cwd?: string }, any> = async (_input, { workingDir }) => {
  const cwd = safeWorkingDir(workingDir);
  const cmd = 'git status -s && echo "\n---\n" && git diff --stat';
  const result = await terminalService.execute({ command: cmd, cwd, timeout: 15000 } as any);
  if (!result.ok) throw result.error;
  return { output: result.value.stdout, exitCode: result.value.exitCode };
};


