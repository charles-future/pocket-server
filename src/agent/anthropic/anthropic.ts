/**
 * Anthropic Service
 * Main service for managing Claude agent sessions and conversations
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadProjectContext } from '../context/loader';
import { generateConversationTitle } from '../core/title';
import { generateSystemPrompt } from './prompt';
import { processStream } from './streaming';
import { bashToolDefinition, executeBash } from './tools/bash';
import { editorToolDefinition, executeEditor } from './tools/editor';
import { executeWebSearch, webSearchToolDefinition } from './tools/web-search';
import { executeWorkPlan, workPlanToolDefinition } from './tools/work-plan';
import type {
  AgentSession,
  ClientMessage,
  ContentBlock,
  Message,
  MessageParam,
  BashToolInput,
  TextEditorCommand,
  ServerMessage,
  ToolResultBlock,
  WebSearchToolInput,
  WorkPlanCommand,
  Turn,
  SessionSnapshot,
} from './types';

type SessionSummary = {
  id: string;
  title: string;
  createdAt: Date;
  lastActivity: Date;
  messageCount: number;
  workingDir: string;
  maxMode: boolean;
  phase: AgentSession['phase'];
};
import { readSessionImageBase64 } from '../store/session-assets';

export class AnthropicService {
  private anthropic: Anthropic | null = null;
  private sessions = new Map<string, AgentSession>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval (every minute)
    this.cleanupInterval = setInterval(() => this.cleanupSessions(), 60000);
  }

  /**
   * Initialize Anthropic client with API key
   */
  private initClient(apiKey: string): Anthropic {
    if (!this.anthropic || this.anthropic.apiKey !== apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
    return this.anthropic;
  }

  /**
   * Create or get session
   */
  private getOrCreateSession(sessionId: string, workingDir: string): AgentSession {
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      const now = new Date();
      session = {
        id: sessionId,
        conversation: {
          id: sessionId,
          title: 'New Chat',
          createdAt: now,
          updatedAt: now,
          messages: [],
          metadata: {
            model: 'claude-sonnet-4-5',
            totalTokens: 0
          },
          settings: {
            maxTokens: 4096,
            tools: [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition]
          }
        },
        streamingState: {
          currentMessage: null,
          contentBlocks: [],
          activeBlockIndex: null,
          activeBlockContent: '',
          isStreaming: false,
          error: null
        },
        workingDir,
        maxMode: false, // Default to chat mode (require approval)
        createdAt: now,
        lastActivity: now,
        phase: 'created',
        pendingTools: []
      };
      this.sessions.set(sessionId, session);
    }
    
    session.lastActivity = new Date();
    return session;
  }

  /**
   * Process a user message
   */
  async processMessage(
    message: ClientMessage,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    const { sessionId, content, workingDir = process.cwd(), maxMode = false, chatMode = !maxMode } = message;
    const reqStart = Date.now();
    try {
      console.log(
        JSON.stringify({
          at: 'anthropic_process_message_start',
          sessionId,
          provider: 'anthropic',
          workingDir,
          maxMode,
          chatMode,
          hasContent: typeof content === 'string' ? content.length : Array.isArray(content),
        })
      );
    } catch {}
    
    if (!content) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'No message content provided'
      });
      return;
    }

    const session = this.getOrCreateSession(sessionId, workingDir);
    // Reflect latest request settings on the session
    session.maxMode = maxMode;
    session.workingDir = workingDir;
    session.phase = 'starting';
    const startingStatus: ServerMessage = {
      type: 'agent:status',
      sessionId,
      phase: 'starting',
    };
    onMessage(startingStatus);
    
    // Generate title for first message and persist
    if (session.conversation.messages.length === 0) {
      const titleSource = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((block) => (block && block.type === 'text' ? block.text : ''))
              .filter(Boolean)
              .join('\n')
          : '';
      const title = await generateConversationTitle(titleSource, apiKey);
      session.conversation.title = title;
      try { await (await import('../store/session-store-fs.js')).sessionStoreFs.updateTitle(sessionId, title); } catch {}
      onMessage({ type: 'agent:title', sessionId, title });
    }

    // Add user message to conversation (keep anchor index for the turn)
    const anchorIndex = session.conversation.messages.length;
    const userMessage: MessageParam = {
      role: 'user',
      content,
    };
    session.conversation.messages.push(userMessage);
    session.conversation.updatedAt = new Date();
    try {
      const ss = await import('../store/session-store-fs.js');
      if (Array.isArray(content)) {
        // Rewrite base64 images to persisted URLs for snapshot
        const { saveSessionImage, buildSessionAssetPath } = await import('../store/session-assets.js');
        const rewritten: ContentBlock[] = [];
        for (const block of content) {
          if (block?.type === 'image' && block.source?.type === 'base64') {
            const mediaType = block.source.media_type;
            const data = block.source.data;
            if (typeof mediaType === 'string' && typeof data === 'string' && data.length > 0) {
              try {
                const saved = await saveSessionImage(sessionId, mediaType, data);
                const assetUrl = buildSessionAssetPath(sessionId, saved.fileName);
                rewritten.push({ type: 'image', source: { type: 'url', url: assetUrl }, dimension: block.dimension ?? null });
              } catch {
                rewritten.push(block);
              }
            } else {
              rewritten.push(block);
            }
          } else {
            rewritten.push(block);
          }
        }
        const rewrittenMessage: MessageParam = { role: 'user', content: rewritten };
        session.conversation.messages[anchorIndex] = rewrittenMessage;
        await ss.sessionStoreFs.recordUserMessageBlocks(sessionId, rewritten, { workingDir, maxMode });
      } else if (typeof content === 'string') {
        await ss.sessionStoreFs.recordUserMessage(sessionId, content, { workingDir, maxMode });
      }
    } catch {}

    // Create/emit Turn
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = new Date().toISOString();
    session.activeTurn = { id: turnId, sessionId, anchorIndex, phase: 'planning', startedAt: nowIso } as Turn;
    try {
      console.log(
        JSON.stringify({
          at: 'turn_created',
          provider: 'anthropic',
          sessionId,
          turnId,
          anchorIndex,
          msgCount: session.conversation.messages.length
        })
      );
    } catch {}
    const turnCreatedMessage: ServerMessage = {
      type: 'agent:turn',
      sessionId,
      event: 'created',
      turnId,
      turn: session.activeTurn,
    };
    onMessage(turnCreatedMessage);

    session.phase = 'ready';
    const readyStatus: ServerMessage = {
      type: 'agent:status',
      sessionId,
      phase: 'ready',
    };
    onMessage(readyStatus);

    // Resolve project context once on first user message
    if (session.conversation.messages.length === 1 && !session.projectContext) {
      try {
        const ctx = await loadProjectContext(workingDir);
        if (ctx) {
          session.projectContext = { source: ctx.source, path: ctx.path, content: ctx.content };
        }
      } catch {}
    }

    // Create system prompt
    const systemPrompt = generateSystemPrompt({
      workingDirectory: workingDir,
      projectContext: session.projectContext
        ? { sourcePath: session.projectContext.path, content: session.projectContext.content }
        : undefined,
    });

    // Prepare tools
    const tools = [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition];

    try {
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      session.currentStreamController = new AbortController();

      const anthropic = this.initClient(apiKey);
      const streamConfig = {
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: await this.materializeMessagesWithBase64(sessionId, session.conversation.messages),
        tools,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      };
      try {
        console.log(
          JSON.stringify({
            at: 'anthropic_stream_request',
            provider: 'anthropic',
            sessionId,
            turnId,
            model: streamConfig.model,
            max_tokens: streamConfig.max_tokens,
            toolCount: streamConfig.tools?.length ?? 0,
            msgCount: streamConfig.messages?.length ?? 0
          })
        );
      } catch {}

      const streamingState = await processStream(
        sessionId,
        workingDir,
        maxMode,
        !maxMode, // chatMode
        (msg) => {
          // Intercept status transitions to update Turn
          if (msg.type === 'agent:status') {
            if (msg.phase === 'awaiting_tool') {
              if (session.activeTurn) {
                session.activeTurn = { ...session.activeTurn, phase: 'awaiting_tool' } as Turn;
                const awaitingMessage: ServerMessage = {
                  type: 'agent:turn',
                  sessionId,
                  event: 'phase',
                  turnId,
                  turn: session.activeTurn,
                };
                onMessage(awaitingMessage);
              }
            }
            if (msg.phase === 'streaming') {
              // Mark planning complete
              if (session.activeTurn) {
                const endedAt = new Date().toISOString();
                const dur = Math.max(0, new Date(endedAt).getTime() - new Date(session.activeTurn.startedAt).getTime());
                session.activeTurn = { ...session.activeTurn, phase: 'streaming', endedAt, lastDurationMs: dur } as Turn;
                const streamingMessage: ServerMessage = {
                  type: 'agent:turn',
                  sessionId,
                  event: 'phase',
                  turnId,
                  turn: session.activeTurn,
                };
                onMessage(streamingMessage);
              }
            }
          }
          const forwardedMessage: ServerMessage = { ...msg, turnId };
          onMessage(forwardedMessage);
        },
        async (request) => {
          const toolRequestMessage: ServerMessage = {
            type: 'agent:tool_request',
            sessionId,
            content: `Tool request: ${request.description}`,
            toolRequest: request,
          };
          onMessage(toolRequestMessage);
          const s = this.sessions.get(sessionId);
          if (s) {
            s.pendingTools = [...(s.pendingTools || []), request];
            s.phase = 'awaiting_tool';
          }
        },
        async (toolId, output, isError) => {
          await this.addToolResultToConversation(session, toolId, output, isError, apiKey, onMessage);
        },
        (state) => {
          const s = this.sessions.get(sessionId);
          if (s) {
            s.streamingState = state;
            s.lastActivity = new Date();
            s.phase = state.isStreaming ? 'streaming' : (state.error ? 'error' : 'ready');
          }
        },
        anthropic,
        streamConfig,
        undefined,
        session.currentStreamController.signal
      );

      session.streamingState = streamingState;

      try {
        console.log(
          JSON.stringify({
            at: 'anthropic_stream_return',
            provider: 'anthropic',
            sessionId,
            turnId,
            aborted: !!streamingState.aborted,
            contentBlocks: streamingState.contentBlocks?.length ?? 0,
            activeBlockIndex: streamingState.activeBlockIndex,
            autoToolCount: streamingState.autoToolRequests?.length ?? 0,
            ms: Date.now() - reqStart
          })
        );
      } catch {}

      if (!streamingState.aborted && streamingState.contentBlocks.length > 0) {
        const assistantMessage: MessageParam = { role: 'assistant', content: streamingState.contentBlocks };
        session.conversation.messages.push(assistantMessage);
        session.conversation.updatedAt = new Date();
      }

      await this.executeAutoTools(session, apiKey, onMessage);

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        const abortMessage: ServerMessage = {
          type: 'agent:assistant',
          sessionId,
          content: session.streamingState.activeBlockContent || '',
          isComplete: true,
        };
        onMessage(abortMessage);
      } else {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const errorMessage: ServerMessage = {
          type: 'agent:error',
          sessionId,
          error: message,
        };
        onMessage(errorMessage);
      }
    } finally {
      session.currentStreamController = undefined;
      // Finalize Turn if still present
      if (session.activeTurn && !session.activeTurn.endedAt) {
        const endedAt = new Date().toISOString();
        const dur = Math.max(0, new Date(endedAt).getTime() - new Date(session.activeTurn.startedAt).getTime());
        session.activeTurn = { ...session.activeTurn, phase: 'completed', endedAt, lastDurationMs: dur } as Turn;
        const turnDoneMessage: ServerMessage = {
          type: 'agent:turn',
          sessionId,
          event: 'done',
          turnId,
          turn: session.activeTurn,
        };
        onMessage(turnDoneMessage);
      }
      try {
        console.log(
          JSON.stringify({
            at: 'anthropic_process_message_end',
            provider: 'anthropic',
            sessionId,
            turnId,
            ms: Date.now() - reqStart
          })
        );
      } catch {}
    }
    // Auto tool execution handled in executeAutoTools
  }

  /**
   * Process tool response from client
   */
  async processToolResponse(
    message: ClientMessage,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    const { sessionId, toolResponse } = message;
    
    if (!toolResponse) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'No tool response provided'
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'Session not found'
      });
      return;
    }

    const { id: toolId, approved } = toolResponse;
    try {
      console.log(
        JSON.stringify({
          at: 'tool_response_received',
          provider: 'anthropic',
          sessionId,
          toolId,
          approved
        })
      );
    } catch {}

    // Record approval decision on the pending tool immediately
    const pendingList = session.pendingTools || [];
    const idx = pendingList.findIndex((t) => t.id === toolId);
    if (idx >= 0) {
      pendingList[idx] = { ...pendingList[idx], approved };
      session.pendingTools = pendingList;
    } else {
      onMessage({
        type: 'agent:error',
        sessionId,
        error: 'Pending tool not found'
      });
      return;
    }

    // Defer execution if the assistant tool_use message has not yet been committed
    const lastMessage = session.conversation.messages[session.conversation.messages.length - 1];
    const assistantCommitted = !!lastMessage &&
      lastMessage.role === 'assistant' &&
      Array.isArray(lastMessage.content) &&
      lastMessage.content.some(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use' && block.id === toolId,
      );

    // If not all decisions are in yet, or the assistant turn hasn't been committed, wait
    const allDecided = (session.pendingTools || []).length > 0
      ? (session.pendingTools || []).every((t) => typeof t.approved === 'boolean')
      : true;

    if (!assistantCommitted || !allDecided) {
      const awaitingStatus: ServerMessage = {
        type: 'agent:status',
        sessionId,
        phase: 'awaiting_tool',
      };
      onMessage(awaitingStatus);
      try {
        console.log(
          JSON.stringify({
            at: 'tool_response_waiting',
            provider: 'anthropic',
            sessionId,
            assistantCommitted,
            allDecided,
            pendingCount: (session.pendingTools || []).length
          })
        );
      } catch {}
      return;
    }

    // All decisions are in and assistant message is committed: execute approved tools now
    {
      const toolResultBlocks: ToolResultBlock[] = [];
      for (const req of session.pendingTools || []) {
        let output = '';
        let isError = false;
        const approvedFlag = !!req.approved;
        if (!approvedFlag) {
          output = 'Tool use rejected by user';
          isError = true;
        } else {
          try {
            const tStart = Date.now();
            console.log(
              JSON.stringify({
                at: 'tool_execute_start',
                provider: 'anthropic',
                sessionId,
                toolId: req.id,
                name: req.name
              })
            );
            switch (req.name) {
              case 'bash':
                output = await executeBash(req.input as BashToolInput, session.workingDir);
                isError = output.includes('Error:');
                break;
              case 'str_replace_based_edit_tool':
                output = await executeEditor(req.input as TextEditorCommand, session.workingDir);
                isError = output.startsWith('Error:');
                break;
              case 'web_search':
                output = await executeWebSearch(req.input as WebSearchToolInput, session.workingDir);
                isError = false;
                break;
              case 'work_plan':
                output = await executeWorkPlan(session.id, req.input as WorkPlanCommand);
                isError = false;
                break;
              default:
                output = `Unknown tool: ${req.name}`;
                isError = true;
            }
            console.log(
              JSON.stringify({
                at: 'tool_execute_done',
                provider: 'anthropic',
                sessionId,
                toolId: req.id,
                name: req.name,
                isError,
                chars: output?.length ?? 0,
                ms: Date.now() - tStart
              })
            );
          } catch (error: unknown) {
            const errMessage = error instanceof Error ? error.message : 'Unknown tool execution failure';
            output = `Error executing tool: ${errMessage}`;
            isError = true;
            console.error(
              JSON.stringify({
                at: 'tool_execute_error',
                provider: 'anthropic',
                sessionId,
                toolId: req.id,
                name: req.name,
                message: errMessage,
              })
            );
          }
        }

        // Build tool_result and notify UI (per-tool)
        const toolResult: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: req.id,
          content: output,
          is_error: isError
        };
        toolResultBlocks.push(toolResult);
        const syntheticMessage: Message = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'message',
          role: 'user',
          content: [toolResult],
          model: '',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
        const toolOutputMessage: ServerMessage = {
          type: 'agent:tool_output',
          sessionId: session.id,
          content: output,
          message: syntheticMessage,
          toolOutput: {
            id: req.id,
            tool_use_id: req.id,
            name: req.name,
            output,
            isError,
            input: req.input,
          },
        };
        onMessage(toolOutputMessage);
      }

      // Push a single user message with ALL tool_result blocks per Anthropic spec
      const toolResultMessage: MessageParam = { role: 'user', content: toolResultBlocks };
      session.conversation.messages.push(toolResultMessage);
      // Clear pending for this assistant turn
      session.pendingTools = [];

      // Continue conversation exactly once
      await this.continueConversation(session, apiKey, onMessage);
    }
  }

  /**
   * Add tool result to conversation and continue (for auto-executed tools)
   */
  private async addToolResultToConversation(
    session: AgentSession,
    toolId: string,
    output: string,
    isError: boolean,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    console.log(`[AnthropicService] Adding tool result to conversation: ${toolId}`);
    
    // Add tool result to conversation
    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolId,
      content: output,
      is_error: isError
    };

    const toolMessage: MessageParam = { role: 'user', content: [toolResult] };
    session.conversation.messages.push(toolMessage);
    session.conversation.updatedAt = new Date();
    // Remove from pending tools if present
    session.pendingTools = (session.pendingTools || []).filter(t => t.id !== toolId);

    // Continue conversation with the tool result
    await this.continueConversation(session, apiKey, onMessage);
  }

  /**
   * Continue conversation after tool result
   */
  private async continueConversation(
    session: AgentSession,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    await this.runContinuation(session, apiKey, onMessage);
    await this.executeAutoTools(session, apiKey, onMessage);
  }

  private async runContinuation(
    session: AgentSession,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void,
    context: 'manual' | 'auto' = 'manual'
  ): Promise<void> {
    const contStart = Date.now();
    const systemPrompt = generateSystemPrompt({
      workingDirectory: session.workingDir,
      projectContext: session.projectContext
        ? { sourcePath: session.projectContext.path, content: session.projectContext.content }
        : undefined,
    });
    const tools = [bashToolDefinition, editorToolDefinition, webSearchToolDefinition, workPlanToolDefinition];

    try {
      // Store reference to current stream for potential cancellation  
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      session.currentStreamController = new AbortController();

      const streamConfig = {
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: await this.materializeMessagesWithBase64(session.id, session.conversation.messages),
        tools,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      };

      const anthropic = this.initClient(apiKey);
      try {
        console.log(
          JSON.stringify({
            at: 'anthropic_continuation_start',
            provider: 'anthropic',
            sessionId: session.id,
            context,
            model: streamConfig.model,
            max_tokens: streamConfig.max_tokens,
            toolCount: streamConfig.tools?.length ?? 0,
            msgCount: streamConfig.messages?.length ?? 0
          })
        );
      } catch {}
      const streamingState = await processStream(
        session.id,
        session.workingDir,
        session.maxMode,
        !session.maxMode,
        onMessage,
        async (request) => {
          onMessage({
            type: 'agent:tool_request',
            sessionId: session.id,
            content: `Tool request: ${request.description}`,
            toolRequest: request
          });
          const s = this.sessions.get(session.id);
          if (s) {
            s.pendingTools = [...(s.pendingTools || []), request];
            s.phase = 'awaiting_tool';
          }
        },
        async (toolId, output, isError) => {
          await this.addToolResultToConversation(session, toolId, output, isError, apiKey, onMessage);
        },
        (state) => {
          const s = this.sessions.get(session.id);
          if (s) {
            s.streamingState = state;
            s.lastActivity = new Date();
            s.phase = state.isStreaming ? 'streaming' : (state.error ? 'error' : 'ready');
          }
        },
        anthropic,
        streamConfig,
        undefined,
        session.currentStreamController.signal
      );

      // Update session streaming state
      session.streamingState = streamingState;
      session.lastActivity = new Date();
      session.phase = streamingState.error ? 'error' : 'ready';
      if (!streamingState.aborted && streamingState.contentBlocks && streamingState.contentBlocks.length > 0) {
        const assistantContinuation: MessageParam = { role: 'assistant', content: streamingState.contentBlocks };
        session.conversation.messages.push(assistantContinuation);
        session.conversation.updatedAt = new Date();
      }

      const continuationStatus: ServerMessage = {
        type: 'agent:status',
        sessionId: session.id,
        phase: session.phase,
      };
      onMessage(continuationStatus);
      try {
        console.log(
          JSON.stringify({
            at: 'anthropic_continuation_end',
            provider: 'anthropic',
            sessionId: session.id,
            context,
            phase: session.phase,
            ms: Date.now() - contStart
          })
        );
      } catch {}

    } catch (error: unknown) {
      console.error('[AnthropicService] Continue conversation error:', error);
      const message = error instanceof Error ? error.message : 'Anthropic continuation error';
      const errorMessage: ServerMessage = { type: 'agent:error', sessionId: session.id, error: message };
      onMessage(errorMessage);
    }
  }

  private async executeAutoTools(
    session: AgentSession,
    apiKey: string,
    onMessage: (msg: ServerMessage) => void
  ): Promise<void> {
    if (!session.maxMode) {
      return;
    }

    let iteration = 0;
    try {
      while (session.maxMode) {
        const state = session.streamingState;
        const autoRequests = state && !state.aborted && Array.isArray(state.autoToolRequests)
          ? [...state.autoToolRequests]
          : [];
        if (session.streamingState && Array.isArray(session.streamingState.autoToolRequests)) {
          session.streamingState.autoToolRequests = [];
        }

        if (!autoRequests.length) {
          break;
        }

        iteration += 1;
        console.log(
          JSON.stringify({
            at: 'anthropic_autoexec_start',
            provider: 'anthropic',
            sessionId: session.id,
            iteration,
            count: autoRequests.length,
            tools: autoRequests.map((t) => ({ id: t.id, name: t.name }))
          })
        );

        const toolResultBlocks: ToolResultBlock[] = [];
        for (const req of autoRequests) {
          let output = '';
          let isError = false;
          const toolStartedAt = Date.now();
          try {
            console.log(
              JSON.stringify({
                at: 'auto_tool_execute_start',
                provider: 'anthropic',
                sessionId: session.id,
                toolId: req.id,
                name: req.name
              })
            );
            switch (req.name) {
              case 'bash':
                output = await executeBash(req.input as BashToolInput, session.workingDir);
                isError = output.includes('Error:');
                break;
              case 'str_replace_based_edit_tool':
                output = await executeEditor(req.input as TextEditorCommand, session.workingDir);
                isError = output.startsWith('Error:');
                break;
              case 'web_search':
                output = await executeWebSearch(req.input as WebSearchToolInput, session.workingDir);
                isError = false;
                break;
              case 'work_plan':
                output = await executeWorkPlan(session.id, req.input as WorkPlanCommand);
                isError = false;
                break;
              default:
                output = `Unknown tool: ${req.name}`;
                isError = true;
            }
            console.log(
              JSON.stringify({
                at: 'auto_tool_execute_done',
                provider: 'anthropic',
                sessionId: session.id,
                toolId: req.id,
                name: req.name,
                isError,
                chars: output?.length ?? 0,
                ms: Date.now() - toolStartedAt
              })
            );
          } catch (error: unknown) {
            const errMessage = error instanceof Error ? error.message : 'unknown error';
            output = `Error executing tool: ${errMessage}`;
            isError = true;
            console.error(
              JSON.stringify({
                at: 'auto_tool_execute_error',
                provider: 'anthropic',
                sessionId: session.id,
                toolId: req.id,
                name: req.name,
                message: errMessage,
              })
            );
          }

          const toolResult: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: req.id,
            content: output,
            is_error: isError
          };
          toolResultBlocks.push(toolResult);

          const autoSyntheticMessage: Message = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'message',
            role: 'user',
            content: [toolResult],
            model: '',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
          const autoToolMessage: ServerMessage = {
            type: 'agent:tool_output',
            sessionId: session.id,
            content: output,
            message: autoSyntheticMessage,
            toolOutput: {
              id: req.id,
              tool_use_id: req.id,
              name: req.name,
              output,
              isError,
              input: req.input,
            },
          };
          onMessage(autoToolMessage);
        }

        const aggregatedToolMessage: MessageParam = { role: 'user', content: toolResultBlocks };
        session.conversation.messages.push(aggregatedToolMessage);
        session.conversation.updatedAt = new Date();

        await this.runContinuation(session, apiKey, onMessage, 'auto');
      }
    } catch (error: unknown) {
      console.error('[AnthropicService] Auto tool execution failed:', error);
      const message = error instanceof Error ? error.message : 'Auto tool execution failed';
      const errorMessage: ServerMessage = {
        type: 'agent:error',
        sessionId: session.id,
        error: message,
      };
      onMessage(errorMessage);
    }
  }

  /**
   * Generate title for a message
   */
  async generateTitle(
    message: string,
    apiKey: string
  ): Promise<string> {
    return generateConversationTitle(message, apiKey);
  }

  /**
   * Stop streaming for a session
   */
  stopStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    try {
      console.log(
        JSON.stringify({
          at: 'anthropic_stop_stream',
          provider: 'anthropic',
          sessionId,
          hasController: !!session?.currentStreamController
        })
      );
    } catch {}
    if (session?.currentStreamController) {
      session.currentStreamController.abort();
      session.currentStreamController = undefined;
      // Clear any pending tools from the aborted assistant turn and emit stopped status
      session.pendingTools = [];
      session.phase = 'stopped';
    }
  }

  /**
   * Get session
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List sessions (lightweight meta)
   */
  listSessions(): SessionSummary[] {
    const result: SessionSummary[] = [];
    for (const s of this.sessions.values()) {
      result.push({
        id: s.id,
        title: s.conversation.title,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        messageCount: s.conversation.messages.length,
        workingDir: s.workingDir,
        maxMode: s.maxMode,
        phase: s.phase || 'ready'
      });
    }
    return result;
  }

  /**
   * Get snapshot for a session
   */
  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return {
      id: s.id,
      title: s.conversation.title,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      messageCount: s.conversation.messages.length,
      workingDir: s.workingDir,
      maxMode: s.maxMode,
      phase: s.phase || 'ready',
      pendingTools: s.pendingTools || [],
      conversation: { messages: s.conversation.messages },
      streamingState: s.streamingState,
      activeTurn: s.activeTurn,
    };
  }

  /**
   * Clear session
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.currentStreamController) {
        session.currentStreamController.abort();
      }
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Cleanup old sessions (runs every minute)
   */
  private cleanupSessions(): void {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = session.lastActivity.getTime();
      if (now - lastActivity > oneHour) {
        console.log(`[AnthropicService] Cleaning up inactive session: ${sessionId}`);
        this.clearSession(sessionId);
      }
    }
  }

  /**
   * Dispose service
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear all sessions
    for (const sessionId of this.sessions.keys()) {
      this.clearSession(sessionId);
    }
  }

  /**
   * Build a messages array for Anthropic by converting any persisted URL image sources
   * (e.g., /agent/session/asset?id=...&file=...) back into base64 image sources.
   */
  private async materializeMessagesWithBase64(sessionId: string, messages: MessageParam[]): Promise<MessageParam[]> {
    const out: MessageParam[] = [];
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) {
        out.push(m);
        continue;
      }
      const newBlocks: ContentBlock[] = [];
      for (const b of m.content) {
        if (b?.type === 'image' && b.source && typeof b.source === 'object') {
          const src = b.source;
          if (src.type === 'url' && typeof src.url === 'string') {
            try {
              const u = new URL(src.url, 'http://dummy');
              const sid = u.searchParams.get('id') || sessionId;
              const file = u.searchParams.get('file');
              if (file) {
                const loaded = await readSessionImageBase64(sid, file);
                if (loaded) {
                  newBlocks.push({ type: 'image', source: { type: 'base64', media_type: loaded.mediaType, data: loaded.base64 }, dimension: b.dimension ?? null });
                  continue;
                }
              }
            } catch {}
          }
        }
        newBlocks.push(b);
      }
      out.push({ ...m, content: newBlocks });
    }
    return out;
  }
}

// Export singleton instance
export const anthropicService = new AnthropicService();
