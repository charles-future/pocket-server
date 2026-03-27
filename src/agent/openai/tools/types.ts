export interface ToolContext {
  workingDir: string;
  sessionId?: string;
}

export type ToolHandler<TInput = any, TOutput = any> = (
  input: TInput,
  context: ToolContext
) => Promise<TOutput>;


