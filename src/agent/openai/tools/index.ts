import * as appendToFile from './files/append-to-file';
import * as editInFile from './files/edit-in-file';
import * as listFiles from './files/list-files';
import * as readFile from './files/read-file';
import * as searchFiles from './files/search-files';
import * as searchRepo from './files/search-repo';
import * as writeFile from './files/write-file';
import * as workPlan from './planning/work-plan';
import * as executeCommand from './terminal/execute-command';
import * as getGitWorkingState from './terminal/get-git-working-state';

export const modules = [
  listFiles,
  readFile,
  writeFile,
  searchFiles,
  searchRepo,
  editInFile,
  appendToFile,
  getGitWorkingState,
  executeCommand,
  workPlan,
];

export const openaiTools = Object.fromEntries(
  modules.map((m: any) => [m.name, (input: any, ctx: { workingDir: string; sessionId?: string }) => m.run(input, ctx)])
) as Record<string, (input: any, ctx: { workingDir: string; sessionId?: string }) => Promise<any>>;

export const openaiToolDefinitions = modules.map((m: any) => m.definition);
