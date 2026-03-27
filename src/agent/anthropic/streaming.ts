/**
 * Streaming Handler for Anthropic API
 * Uses async iteration pattern - the only pattern that works with Bun
 */

import type Anthropic from '@anthropic-ai/sdk';
import { executeBash, isBashCommandDangerous } from './tools/bash';
import { executeEditor, isEditorCommandDangerous } from './tools/editor';
import { executeWebSearch } from './tools/web-search';
import type { 
  BashToolInput,
  ContentBlock, 
  ServerMessage, 
  StreamingState, 
  TextEditorCommand,
  ToolOutput,
  ToolRequest,
  WebSearchResult,
  WebSearchToolInput 
} from './types';

export interface StreamHandlerOptions {
  sessionId: string;
  workingDir: string;
  maxMode: boolean;
  chatMode: boolean;
  onMessage: (message: ServerMessage) => void;
  onToolRequest: (request: ToolRequest) => Promise<void>;
  onToolResultProcessed: (toolId: string, output: string, isError: boolean) => Promise<void>;
  onStateUpdated?: (partial: Partial<StreamingState>) => void;
}

/**
 * Process streaming response using async iteration - the only working pattern
 */
export async function processStream(
  sessionId: string,
  workingDir: string,
  maxMode: boolean,
  chatMode: boolean,
  onMessage: (message: ServerMessage) => void,
  onToolRequest: (request: ToolRequest) => Promise<void>,
  onToolResultProcessed: (toolId: string, output: string, isError: boolean) => Promise<void>,
  onStateUpdated: ((state: StreamingState) => void) | undefined,
  anthropic: Anthropic,
  streamConfig: any,
  // Optional abort hooks; when present we will stop the SDK stream and exit early
  shouldAbort?: () => boolean,
  abortSignal?: AbortSignal
): Promise<StreamingState> {
  // Initialize streaming state
  const state: StreamingState = {
    currentMessage: null,
    contentBlocks: [],
    activeBlockIndex: null,
    activeBlockContent: '',
    isStreaming: true,
    error: null,
    autoToolRequests: []
  };

  // Track accumulated content for text blocks
  let allAccumulatedContent = '';
  let currentBlockContent = '';
  let messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Track tool use blocks being built
  let currentToolUse: any = null;
  let toolInputJsonBuffer = '';
  
  // Track current block index
  let currentBlockIndex = -1;
  // Track thinking duration
  let thinkingStartAt: number | null = null;
  let thinkingEndAt: number | null = null;
  const streamStart = Date.now();
  let eventCount = 0;

  try {
    try {
      const msgCount = Array.isArray(streamConfig?.messages) ? streamConfig.messages.length : -1;
      const toolCount = Array.isArray(streamConfig?.tools) ? streamConfig.tools.length : 0;
      const thinkingCfg = streamConfig?.thinking ? { ...streamConfig.thinking } : undefined;
      console.log(
        JSON.stringify({
          at: 'stream_start',
          provider: 'anthropic',
          sessionId,
          workingDir,
          maxMode,
          chatMode,
          model: streamConfig?.model,
          msgCount,
          toolCount,
          thinkingCfg,
          ts: new Date(streamStart).toISOString()
        })
      );
    } catch {}

    // Create the stream
    const stream = anthropic.messages.stream(streamConfig);

    // Process events using async iteration - THE ONLY PATTERN THAT WORKS
    for await (const event of stream) {
      eventCount++;
      // Cooperative abort: if caller requests stop, terminate the provider stream and exit
      if ((shouldAbort && shouldAbort()) || (abortSignal && abortSignal.aborted)) {
        try { (stream as any).controller?.abort?.(); } catch {}
        try { (stream as any).abort?.(); } catch {}
        // Finalize active text block content if any so UI keeps what it saw
        if (state.activeBlockIndex !== null && state.activeBlockIndex < state.contentBlocks.length) {
          const blk = state.contentBlocks[state.activeBlockIndex] as any;
          if (blk && blk.type === 'text') {
            (state.contentBlocks[state.activeBlockIndex] as any) = { type: 'text', text: currentBlockContent } as any;
          }
        }
        state.isStreaming = false;
        state.aborted = true;
        onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'message_stop' } } as any);
        // Synthesize a minimal final message to align with client expectations
        const synthesizedFinal: any = {
          id: state.currentMessage?.id || messageId,
          type: 'message',
          role: 'assistant',
          content: state.contentBlocks as any,
          model: 'claude-sonnet-4-20250514',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
        onMessage({ type: 'agent:stream_complete', sessionId, finalMessage: synthesizedFinal });
        onMessage({ type: 'agent:status', sessionId, phase: 'stopped' } as any);
        return state;
      }
      try {
        console.log(
          JSON.stringify({
            at: 'stream_event',
            provider: 'anthropic',
            sessionId,
            type: (event as any)?.type,
            idx: (event as any)?.index ?? undefined,
            deltaType: (event as any)?.delta?.type ?? undefined
          })
        );
      } catch {}
      
      // Send raw event to client for real-time updates
      onMessage({
        type: 'agent:stream_event',
        sessionId,
        streamEvent: event as any
      });
      
      switch (event.type) {
        case 'message_start':
          try {
            console.log(
              JSON.stringify({
                at: 'message_start',
                provider: 'anthropic',
                sessionId,
                messageId: (event as any)?.message?.id,
                ts: new Date().toISOString()
              })
            );
          } catch {}
          state.currentMessage = event.message as any; // Cast to our Message type
          messageId = event.message.id;
          // Phase: streaming
          onMessage({ type: 'agent:status', sessionId, phase: 'streaming' } as any);
          onStateUpdated?.(state);
          
          // Send thinking indicator
          onMessage({
            type: 'agent:thinking',
            sessionId,
            content: ''
          });
          break;
          
        case 'content_block_start': {
          currentBlockIndex = event.index;
          const block = event.content_block as ContentBlock; // Cast to our ContentBlock type
          state.contentBlocks.push(block);
          state.activeBlockIndex = event.index;
          
          try {
            console.log(
              JSON.stringify({
                at: 'content_block_start',
                provider: 'anthropic',
                sessionId,
                index: event.index,
                blockType: (block as any)?.type
              })
            );
          } catch {}
          
          if (block.type === 'text') {
            currentBlockContent = '';
          } else if (block.type === 'tool_use') {
            currentToolUse = block;
            toolInputJsonBuffer = '';
          }
          onStateUpdated?.(state);
          break;
        }
          
        case 'content_block_delta':
          if (event.index !== currentBlockIndex) {
            console.warn(`[Streaming] Block index mismatch: ${event.index} vs ${currentBlockIndex}`);
          }
          
          if (event.delta.type === 'text_delta') {
            const deltaText = event.delta.text;
            try {
              console.log(
                JSON.stringify({
                  at: 'text_delta',
                  provider: 'anthropic',
                  sessionId,
                  index: event.index,
                  chars: typeof deltaText === 'string' ? deltaText.length : undefined,
                })
              );
            } catch {}
            
            // Accumulate text
            currentBlockContent += deltaText;
            allAccumulatedContent += deltaText;
            state.activeBlockContent = currentBlockContent;
            onStateUpdated?.(state);
            
            // Text delta is already sent via agent:stream_event above
            // No need for duplicate agent:assistant message
            
          } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
            // Accumulate JSON for tool input
            toolInputJsonBuffer += event.delta.partial_json || '';
            try {
              console.log(
                JSON.stringify({
                  at: 'tool_input_delta',
                  provider: 'anthropic',
                  sessionId,
                  index: event.index,
                  chars: (event as any)?.delta?.partial_json?.length ?? undefined
                })
              );
            } catch {}
            onStateUpdated?.(state);
            
          } else if (event.delta.type === 'thinking_delta') {
            // Accumulate thinking text into the active thinking block
            const idx = event.index;
            const blocks = state.contentBlocks;
            const blk = blocks[idx];
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            if (blk && (blk as any).type === 'thinking') {
              (blk as any).thinking = ((blk as any).thinking || '') + (event.delta as any).thinking;
            }
            onStateUpdated?.(state);
          } else if ((event.delta as any).type === 'signature_delta') {
            // Attach encrypted signature to thinking block
            const idx = event.index;
            const blk = state.contentBlocks[idx];
            if (blk && (blk as any).type === 'thinking') {
              (blk as any).signature = (event.delta as any).signature;
            }
            onStateUpdated?.(state);
          }
          break;
          
        case 'content_block_stop':
          try {
            console.log(
              JSON.stringify({
                at: 'content_block_stop',
                provider: 'anthropic',
                sessionId,
                index: event.index
              })
            );
          } catch {}
          
          if (state.activeBlockIndex !== null && state.activeBlockIndex < state.contentBlocks.length) {
            const block = state.contentBlocks[state.activeBlockIndex];
            
            if (block.type === 'text') {
              // Update text block with final content
              (block as any).text = currentBlockContent;
              currentBlockContent = '';
              onStateUpdated?.(state);
              
            } else if (block.type === 'tool_use' && currentToolUse) {
              // Parse and handle tool use
              try {
                if (toolInputJsonBuffer) {
                  currentToolUse.input = JSON.parse(toolInputJsonBuffer);
                }
                
                // Create tool request
                const toolRequest: ToolRequest = {
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: currentToolUse.input || {},
                  description: generateToolDescription(currentToolUse.name, currentToolUse.input)
                };
                
                try {
                  console.log(
                    JSON.stringify({
                      at: 'tool_request_built',
                      provider: 'anthropic',
                      sessionId,
                      tool: toolRequest.name,
                      toolId: toolRequest.id,
                      desc: toolRequest.description
                    })
                  );
                } catch {}
                
                // For Max (chatMode === false) auto-approval: queue tool requests to execute AFTER this stream completes,
                // so we can send them back to the API in the required "user tool_result" message format.
                // Auto-approve safe tools in Max mode, and always auto-approve work_plan
                if (!chatMode && isToolSafe(toolRequest)) {
                  state.autoToolRequests?.push(toolRequest);
                } else {
                  // Chat mode: send to client for manual approval
                  await onToolRequest(toolRequest);
                  onMessage({ type: 'agent:status', sessionId, phase: 'awaiting_tool' } as any);
                }
                
              } catch (error) {
                console.error('[Streaming] Failed to parse tool input:', error);
              }
              
              // Reset tool tracking
              currentToolUse = null;
              toolInputJsonBuffer = '';
            }
          }
          
          state.activeBlockIndex = null;
          break;
          
        case 'message_delta':
          try {
            console.log(
              JSON.stringify({
                at: 'message_delta',
                provider: 'anthropic',
                sessionId,
                stop_reason: (event as any)?.delta?.stop_reason || undefined
              })
            );
          } catch {}
          break;
          
        case 'message_stop':
          try {
            console.log(
              JSON.stringify({
                at: 'message_stop',
                provider: 'anthropic',
                sessionId,
              })
            );
          } catch {}
          state.isStreaming = false;
          if (thinkingStartAt !== null && thinkingEndAt === null) thinkingEndAt = Date.now();
          // Phase transition will finalize after finalMessage fetch, but emit tentative ready
          onMessage({ type: 'agent:status', sessionId, phase: 'ready' } as any);
          onStateUpdated?.(state);
          
          // Message completion is already sent via agent:stream_event
          // Final complete message will be sent via agent:stream_complete after the loop
          break;
        
        default:
          // Handle error events that might not be in the type union
          if ('error' in event && (event as any).type === 'error') {
            try {
              console.error(
                JSON.stringify({
                  at: 'stream_error_event',
                  provider: 'anthropic',
                  sessionId,
                  errorType: (event as any)?.error?.type,
                  errorMessage: (event as any)?.error?.message
                })
              );
            } catch {}
            state.error = {
              type: 'error',
              error: (event as any).error
            };
            state.isStreaming = false;
            onMessage({ type: 'agent:status', sessionId, phase: 'error' } as any);
            onStateUpdated?.(state);
            
            onMessage({
              type: 'agent:error',
              sessionId,
              error: (event as any).error.message
            });
          }
          break;
      }
    }
    
    // Get the final message after stream completes
    const finalMessage = await stream.finalMessage();
    try {
      console.log(
        JSON.stringify({
          at: 'stream_final',
          provider: 'anthropic',
          sessionId,
          contentBlocks: Array.isArray((finalMessage as any)?.content)
            ? (finalMessage as any).content.length
            : undefined,
          stop_reason: (finalMessage as any)?.stop_reason ?? undefined,
          usage: (finalMessage as any)?.usage ?? undefined,
          eventCount,
          ms: Date.now() - streamStart
        })
      );
    } catch {}
    
    // Send the complete final message (keep the same id as the message_start for dedupe on client)
    const normalizedFinal = { ...(finalMessage as any) };
    try {
      // Inject duration_ms into any thinking blocks if we tracked timing
      if (thinkingStartAt !== null) {
        const end = thinkingEndAt ?? Date.now();
        const dur = Math.max(0, end - thinkingStartAt);
        if (Array.isArray(normalizedFinal.content)) {
          normalizedFinal.content = (normalizedFinal.content as any[]).map((b: any) => {
            if (b && b.type === 'thinking' && typeof b.duration_ms !== 'number') {
              return { ...b, duration_ms: dur };
            }
            return b;
          });
        }
      }
    } catch {}
    if (state.currentMessage?.id && normalizedFinal.id !== state.currentMessage.id) {
      normalizedFinal.id = state.currentMessage.id;
    }
    onMessage({
      type: 'agent:stream_complete',
      sessionId,
      finalMessage: normalizedFinal as any
    });
    // Ensure state reflects the complete final message blocks, including thinking + signature
    try {
      state.contentBlocks = (finalMessage as any).content as any;
    } catch {
      // ignore
    }
    // Final stop_reason determines terminal phase
    const stop = (finalMessage as any).stop_reason as string | null;
    if (stop === 'pause_turn') {
      onMessage({ type: 'agent:status', sessionId, phase: 'paused' } as any);
    } else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === null) {
      onMessage({ type: 'agent:status', sessionId, phase: 'completed' } as any);
    }
    onStateUpdated?.(state);
    
    try {
      const autoTools = (state.autoToolRequests || []).map(t => ({ id: t.id, name: t.name }));
      console.log(
        JSON.stringify({
          at: 'stream_complete',
          provider: 'anthropic',
          sessionId,
          autoToolRequests: autoTools,
          autoToolCount: autoTools.length,
          ms: Date.now() - streamStart
        })
      );
    } catch {}
    
  } catch (error: any) {
    try {
      console.error(
        JSON.stringify({
          at: 'stream_exception',
          provider: 'anthropic',
          sessionId,
          name: error?.name,
          message: error?.message,
          code: (error as any)?.code,
          status: (error as any)?.status || (error as any)?.response?.status,
          ms: Date.now() - streamStart
        })
      );
    } catch {}
    state.error = {
      type: 'error',
      error: {
        type: 'stream_processing_error',
        message: error.message
      }
    };
    state.isStreaming = false;
    
    onMessage({
      type: 'agent:error',
      sessionId,
      error: error.message
    });
  }

  return state;
}

/**
 * Execute tool locally (for auto-approved tools)
 */
async function executeToolLocally(request: ToolRequest, workingDir: string): Promise<string> {
  try {
    // Use tool name directly
    if (request.name === 'bash') {
      return await executeBash(request.input as BashToolInput, workingDir);
    }
    if (request.name === 'str_replace_based_edit_tool') {
      return await executeEditor(request.input as TextEditorCommand, workingDir);
    }
    if (request.name === 'web_search') {
      return await executeWebSearch(request.input as WebSearchToolInput, workingDir);
    }
    return `Error: Unknown tool: ${request.name}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * Check if tool is safe for auto-approval
 */
function isToolSafe(request: ToolRequest): boolean {
  // ToolRequest carries the Anthropic tool name in `name`
  switch (request.name) {
    case 'bash':
      return !isBashCommandDangerous(
        typeof (request.input as Partial<BashToolInput>)?.command === 'string'
          ? (request.input as Partial<BashToolInput>).command ?? ''
          : '',
      );
    case 'str_replace_based_edit_tool':
      return !isEditorCommandDangerous(request.input as TextEditorCommand);
    case 'web_search':
      return true; // Web search is always safe
    case 'work_plan':
      return true; // Server-local plan state; safe
    default:
      return false;
  }
}


/**
 * Generate human-readable tool description
 */
function generateToolDescription(toolName: string, input: any): string {
  if (toolName === 'bash' && input?.command) {
    return `Execute: ${input.command}`;
  } else if (toolName === 'str_replace_based_edit_tool') {
    const { command, path } = input || {};
    const filename = path ? path.split('/').pop() : 'file';
    
    switch (command) {
      case 'view':
        return `View ${filename}`;
      case 'str_replace':
        return `Edit ${filename}`;
      case 'create':
        return `Create ${filename}`;
      case 'insert':
        return `Insert text in ${filename}`;
      default:
        return `File operation on ${filename}`;
    }
  } else if (toolName === 'web_search' && input?.query) {
    return `Search: ${input.query}`;
  } else if (toolName === 'work_plan') {
    if (input?.command === 'create' && Array.isArray(input?.items)) {
      return `Create work plan: ${input.items.length} steps`;
    }
    if (input?.command === 'complete') {
      return `Complete step ${input.id}`;
    }
    if (input?.command === 'revise') {
      return `Revise work plan (${(input.items || []).length} changes)`;
    }
  }
  
  return 'Execute tool';
}
