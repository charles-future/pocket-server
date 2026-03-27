/**
 * OpenAI Responses API Streaming Normalizer
 * Maps GPT-5 events to our `agent:stream_event` / `agent:stream_complete`.
 *
 * High-confidence, docs-aligned behavior:
 * - Stream reasoning summary deltas in real time when available (Responses API SSE):
 *   - response.reasoning_summary_text.delta → thinking_delta
 *   - response.reasoning_summary_text.done  → close thinking block
 *   - response.reasoning_summary_part.added → optional section boundary (ignored by default)
 * - Preserve function call streaming and output_text streaming per docs.
 */

import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import { logger } from '../../shared/logger';
import type { ServerMessage } from '../anthropic/types';
import { generateSystemPromptOpenAI } from './prompt';
import { openaiToolDefinitions } from './tools/index.js';

interface ProcessArgs {
  client: OpenAI;
  sessionId: string;
  content: string | any[];
  workingDir: string;
  maxMode: boolean;
  previousResponseId?: string | null;
  onMessage: (m: ServerMessage) => void;
  abortSignal?: AbortSignal;
  shouldAbort?: () => boolean;
  // tools no longer needed here; defined via openaiToolDefinitions
  projectContext?: { sourcePath: string; content: string };
}

export async function processOpenAIStream(args: ProcessArgs): Promise<{ responseId?: string } | undefined> {
  const { client, sessionId, content, previousResponseId, onMessage, workingDir, abortSignal, shouldAbort, projectContext } = args;

  // Helpers for bounded, structured diagnostics (avoid log floods and secrets)
  const clip = (s: string, max: number = 160): string => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}…` : (s as string));
  const safeJson = (obj: unknown, max: number = 240): string => {
    try {
      const str = JSON.stringify(obj);
      return clip(str || '', max);
    } catch {
      return '[unserializable]';
    }
  };

  // Placeholder streaming implementation: call Responses API non-streaming for scaffolding,
  // then emit a minimal set of events. Detailed streaming can replace this once wired end-to-end.
  try {
    const instructions = generateSystemPromptOpenAI({
      workingDirectory: workingDir,
      projectContext: projectContext,
    });
    logger.agent('openai:request', sessionId, { previousResponseId: previousResponseId ?? null });
    const params: any = {
      model: 'gpt-5',
      instructions,
      input: typeof content === 'string' ? content : (content as any),
      tools: openaiToolDefinitions as any,
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'auto' } as any,
      text: { verbosity: 'medium' },
      include: ['reasoning.encrypted_content'] as any,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      store: true,
      stream: true,
    };
    const options: any = abortSignal ? { signal: abortSignal } : undefined;
    const stream = options ? await client.responses.create(params, options) : await client.responses.create(params);
    let messageStartAt: number | null = null;
    let thinkingStartAt: number | null = null;

    logger.agent('openai:stream_started', sessionId, {
      inputShape: Array.isArray(content) ? 'array' : typeof content,
      toolCount: Array.isArray(openaiToolDefinitions) ? openaiToolDefinitions.length : 0,
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      verbosity: 'medium',
    });

    let emittedStart = false;
    let messageId: string | undefined; // UI message id
    let openaiResponseId: string | undefined; // OpenAI response id for previous_response_id
    let blockIdx = 0;
    // Track live blocks and aggregates
    let thinkingBlockStarted = false;
    let thinkingBlockIndex = -1;
    let textBlockStarted = false;
    let textBlockIndex = -1;
    let aggregatedThinking = '';
    let reasoningBlockOpen = false;
    let aggregatedText = '';
    const toolAgg: Record<number, { callId: string; name: string; args: string; itemId?: string }> = {};
    let sawToolCall = false; // if true, do not finalize this turn; await tool outputs
    let completedResponse: any | undefined; // capture final response payload from 'response.completed'

    // Stream events
    for await (const event of stream as any) {
      if (shouldAbort && shouldAbort()) {
        try { (stream as any).controller?.abort?.(); } catch {}
        try { (stream as any).abort?.(); } catch {}
        break;
      }
      const type = (event && typeof event === 'object') ? (event.type || 'unknown') : 'unknown';
      // capture final response payload for output extraction
      if (type === 'response.completed' && (event as any).response) {
        completedResponse = (event as any).response;
      }
      // Ensure a message_start is always emitted once
      if (!emittedStart) {
        // Prefer the real response id if present; otherwise synthesize a UI id
        const eid: string | undefined = (event as any).response_id
          || (event as any).response?.id
          || (event as any).id;
        if (eid && typeof eid === 'string' && eid.length > 0) {
          openaiResponseId = eid;
          logger.agent('openai:response_id_captured', sessionId, { responseId: openaiResponseId });
        }
        messageId = (eid && eid.length > 0) ? eid : randomUUID();
        onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'message_start', message: { id: messageId } } } as any);
        onMessage({ type: 'agent:status', sessionId, phase: 'streaming' } as any);
        emittedStart = true;
        messageStartAt = Date.now();
        // if we later detect reasoning, we will set thinkingStartAt; otherwise treat message start as the start
        if (thinkingStartAt === null) thinkingStartAt = messageStartAt;
        logger.agent('openai:response_start', sessionId, { responseId: openaiResponseId || messageId });
      }
      // Capture OpenAI response id if seen later in the stream
      const rid: string | undefined = (event as any).response_id
        || (event as any).response?.id
        || (event as any).id;
      if (!openaiResponseId && rid && typeof rid === 'string' && rid.length > 0) {
        openaiResponseId = rid;
        logger.agent('openai:response_id_captured', sessionId, { responseId: openaiResponseId });
      }
      // Signal reasoning phase when a reasoning output item is added
      if ((event as any).type === 'response.output_item.added' && (event as any).item?.type === 'reasoning') {
        onMessage({ type: 'agent:status', sessionId, phase: 'reasoning' } as any);
        if (thinkingStartAt === null) thinkingStartAt = Date.now();
      }
      // Stream reasoning summary deltas as thinking
      if ((event as any).type === 'response.reasoning_summary_text.delta') {
        const delta: string = (event as any).delta || '';
        if (delta && delta.length > 0) {
          if (!reasoningBlockOpen) {
            reasoningBlockOpen = true;
            thinkingBlockStarted = true;
            thinkingBlockIndex = blockIdx;
            onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_start', index: thinkingBlockIndex, content_block: { type: 'thinking', thinking: '' } } } as any);
            blockIdx++;
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            onMessage({ type: 'agent:status', sessionId, phase: 'reasoning' } as any);
          }
          aggregatedThinking += delta;
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_delta', index: thinkingBlockIndex, delta: { type: 'thinking_delta', thinking: delta } } } as any);
        }
        continue;
      }
      if ((event as any).type === 'response.reasoning_summary_text.done') {
        if (reasoningBlockOpen && thinkingBlockIndex >= 0) {
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: thinkingBlockIndex } } as any);
          reasoningBlockOpen = false;
        }
        continue;
      }
      if ((event as any).type === 'response.reasoning_summary_part.added') {
        // Optional: could close/open sections; we keep a single block for simplicity
        continue;
      }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const idx = event.output_index as number;
        toolAgg[idx] = { callId: event.item.call_id, name: event.item.name, args: '', itemId: event.item.id };
        logger.agent('openai:function_call_added', sessionId, { index: idx, name: event.item.name, callId: event.item.call_id });
      } else if (event.type === 'response.function_call_arguments.delta') {
        const idx = event.output_index as number;
        if (toolAgg[idx]) toolAgg[idx].args += event.delta || '';
      } else if (event.type === 'response.function_call_arguments.done') {
        const idx = event.output_index as number;
        const agg = toolAgg[idx];
        if (agg) {
          let argsObj: Record<string, any> = {};
          try { argsObj = agg.args ? JSON.parse(agg.args) : {}; } catch {}
          // Require a valid call_id from the model; do not synthesize IDs
          if (!agg.callId) {
            logger.error('OpenAI', 'Missing call_id for function call', { sessionId, index: idx, name: agg.name });
            // Skip emitting a tool request for this item to avoid breaking the stream
            continue;
          }
          const id = agg.callId;
          // UI normalization: map OpenAI tool names to canonical UI names for rendering
          const mapUiName = (n: string): string => {
            switch (n) {
              case 'execute_command': return 'bash';
              case 'edit_in_file':
              case 'write_file':
              case 'read_file':
              case 'list_files':
              case 'search_files':
              case 'append_to_file':
                return 'str_replace_based_edit_tool';
              case 'search_repo':
                return 'repo_search';
              default:
                return n;
            }
          };
          const uiName = mapUiName(agg.name);
          // Include original provider tool name for server execution
          const enrichedInput = { ...argsObj };
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_start', index: blockIdx, content_block: { type: 'server_tool_use', id, name: agg.name, input: argsObj } } } as any);
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: blockIdx } } as any);
          // Emit tool request with id equal to the model-provided call_id
          onMessage({ type: 'agent:tool_request', sessionId, toolRequest: { id, name: uiName, providerName: agg.name, input: enrichedInput, description: `Run ${agg.name}`, responseId: openaiResponseId } as any } as any);
          logger.agent('openai:tool_request', sessionId, { id, name: agg.name });
          blockIdx++;
          sawToolCall = true;
        }
      } else if (event.type === 'response.output_text.delta') {
        // Stream assistant text tokens
        const t: string | undefined = event.delta || '';
        if (t && t.length > 0) {
          // First visible assistant activity
          onMessage({ type: 'agent:status', sessionId, phase: 'assistant_activity' } as any);
          if (!textBlockStarted) {
            textBlockStarted = true;
            textBlockIndex = blockIdx;
            onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } } } as any);
            blockIdx++;
          }
          aggregatedText += t;
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: t } } } as any);
        }
      } else if (event.type === 'response.output_text.done') {
        if (textBlockStarted && textBlockIndex >= 0) {
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: textBlockIndex } } as any);
        }
      }
    }

    // Early abort handling: if we broke out before completion
    if (shouldAbort && shouldAbort()) {
      try {
        if (textBlockStarted && textBlockIndex >= 0) {
          onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: textBlockIndex } } as any);
        }
      } catch {}
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'message_stop' } } as any);
      const finalBlocks: any[] = [];
      if (aggregatedThinking && aggregatedThinking.length > 0) finalBlocks.push({ type: 'thinking', thinking: aggregatedThinking });
      if (aggregatedText && aggregatedText.length > 0) finalBlocks.push({ type: 'text', text: aggregatedText });
      const uiFinalId = messageId || openaiResponseId || randomUUID();
      onMessage({ type: 'agent:stream_complete', sessionId, finalMessage: { id: uiFinalId, type: 'message', role: 'assistant', content: finalBlocks.length ? finalBlocks : [{ type: 'text', text: aggregatedText }] , model: 'gpt-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as any } as any);
      onMessage({ type: 'agent:status', sessionId, phase: 'stopped' } as any);
      // Important: do NOT return a responseId on abort. The Responses API requires
      // a stored, completed response for continuation. Returning a transient id here
      // leads to 400 "Previous response ... not found" on the next turn.
      return undefined;
    }

    // If any tool calls occurred, end the turn here and await tool outputs.
    if (sawToolCall) {
      logger.agent('openai:awaiting_tool_partial', sessionId, {
        aggregatedTextLen: aggregatedText.length,
        aggregatedTextPreview: clip(aggregatedText, 200),
      });
      // Synthesize a partial final message for the preamble so the UI doesn't lose streamed content
      const partialBlocks: any[] = [];
      if (aggregatedText && aggregatedText.length > 0) {
        partialBlocks.push({ type: 'text', text: aggregatedText });
      }
      if (aggregatedThinking && aggregatedThinking.length > 0) {
        partialBlocks.unshift({ type: 'thinking', thinking: aggregatedThinking });
      }
      if (partialBlocks.length > 0) {
        const uiFinalId = messageId || randomUUID();
        onMessage({ type: 'agent:stream_complete', sessionId, finalMessage: { id: uiFinalId, type: 'message', role: 'assistant', content: partialBlocks, model: 'gpt-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as any } as any);
      }
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'message_stop' } } as any);
      onMessage({ type: 'agent:status', sessionId, phase: 'awaiting_tool' } as any);
      logger.agent('openai:awaiting_tool', sessionId, { responseId: openaiResponseId });
      return { responseId: openaiResponseId };
    }

    // Final response with text and (optional) reasoning
    const finalRes = await (stream as any).finalResponse?.() ?? undefined;
    const out = finalRes ?? completedResponse ?? {};
    const outputArr: any[] = Array.isArray((out as any).output) ? (out as any).output : [];
    try {
      const counts: Record<string, number> = {};
      for (const it of outputArr) {
        const k = typeof it?.type === 'string' ? it.type : 'unknown';
        counts[k] = (counts[k] || 0) + 1;
      }
      logger.agent('openai:final_response', sessionId, {
        id: (out as any).id || null,
        outputCount: outputArr.length,
        outputTypeCounts: counts,
      });
      const usage = (out as any).usage;
      if (usage) {
        logger.agent('openai:usage', sessionId, {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
          textTokens: usage.output_tokens_details?.text_tokens,
        });
      }
    } catch {}

    // Derive thinking from final reasoning items (docs-aligned)
    const reasoningItems = outputArr.filter((it) => it.type === 'reasoning');
    // Capture final OpenAI response id from the aggregated response, if available
    const outId: string | undefined = (out as any).id
      || (stream as any)?.id
      || (stream as any)?.response?.id;
    if (!openaiResponseId && outId && typeof outId === 'string' && outId.length > 0) {
      openaiResponseId = outId;
      logger.agent('openai:response_id_captured', sessionId, { responseId: openaiResponseId });
    }
    // Try documented 'summary' first; then fall back to visible content text if present
    const joinTexts = (arr: any[]): string => arr.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).filter(Boolean).join('\n');
    let thinkingText = '';
    try {
      const bySummary = reasoningItems
        .flatMap((r: any) => Array.isArray(r.summary) ? r.summary : [])
        .map((s: any) => (typeof s?.text === 'string' ? s.text : ''))
        .filter(Boolean)
        .join('\n');
      if (bySummary && bySummary.length > 0) thinkingText = bySummary;
    } catch {}
    if (!thinkingText && reasoningItems.length > 0) {
      try {
        // Some SDKs may surface a content array of parts with { text }
        const partsText = reasoningItems.map((r: any) => {
          if (Array.isArray(r.content)) return joinTexts(r.content);
          if (typeof r.text === 'string') return r.text;
          return '';
        }).filter(Boolean).join('\n');
        if (partsText && partsText.length > 0) thinkingText = partsText;
      } catch {}
    }
    if (!thinkingText && reasoningItems.length > 0) {
      // Log structure to refine mapping next run
      try {
        const first = reasoningItems[0];
        logger.agent('openai:reasoning_item_shape', sessionId, {
          keys: Object.keys(first || {}).slice(0, 20),
          preview: safeJson({ ...first, content: Array.isArray(first?.content) ? `[${first.content.length} parts]` : typeof first?.content }),
        });
      } catch {}
    }
    if (thinkingText && thinkingText.length > 0) {
      logger.agent('openai:reasoning_extracted', sessionId, {
        length: thinkingText.length,
      });
      thinkingBlockStarted = true;
      thinkingBlockIndex = blockIdx;
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_start', index: thinkingBlockIndex, content_block: { type: 'thinking', thinking: '' } } } as any);
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_delta', index: thinkingBlockIndex, delta: { type: 'thinking_delta', thinking: thinkingText } } } as any);
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: thinkingBlockIndex } } as any);
      aggregatedThinking += thinkingText;
      blockIdx++;
    }

    // Synthesize text if not streamed
    if (!textBlockStarted) {
      const outputText: string = (out as any).output_text || '';
      textBlockStarted = true;
      textBlockIndex = blockIdx;
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } } } as any);
      if (outputText) {
        aggregatedText += outputText;
        onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: outputText } } } as any);
      }
      onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'content_block_stop', index: textBlockIndex } } as any);
      blockIdx++;
    }

    // Finalize
    onMessage({ type: 'agent:stream_event', sessionId, streamEvent: { type: 'message_stop' } } as any);

    // Build final message preserving thinking and text
    const finalBlocks: any[] = [];
    if (aggregatedThinking && aggregatedThinking.length > 0) {
      const durationMs = (typeof thinkingStartAt === 'number') ? Math.max(0, Date.now() - thinkingStartAt) : undefined;
      finalBlocks.push(durationMs !== undefined ? { type: 'thinking', thinking: aggregatedThinking, duration_ms: durationMs } as any : { type: 'thinking', thinking: aggregatedThinking } as any);
    }
    finalBlocks.push({ type: 'text', text: aggregatedText });

    logger.agent('openai:final_blocks_built', sessionId, {
      hasThinking: aggregatedThinking.length > 0,
      thinkingLen: aggregatedThinking.length,
      textLen: aggregatedText.length,
    });

    const uiFinalId = messageId || outId || randomUUID();
    const finalUsage = (out as any).usage || { input_tokens: 0, output_tokens: 0 };
    onMessage({ type: 'agent:stream_complete', sessionId, finalMessage: { id: uiFinalId, type: 'message', role: 'assistant', content: finalBlocks, model: 'gpt-5', stop_reason: null, stop_sequence: null, usage: finalUsage } as any } as any);
    onMessage({ type: 'agent:status', sessionId, phase: 'completed' } as any);
    logger.agent('openai:response_complete', sessionId, { responseId: openaiResponseId || uiFinalId });

    return { responseId: openaiResponseId };
  } catch (error) {
    onMessage({ type: 'agent:error', sessionId, error: (error as any)?.message || 'OpenAI stream error' } as any);
    logger.error('OpenAI', 'Stream error', { sessionId, error: (error as any)?.message });
    return undefined;
  }
}
