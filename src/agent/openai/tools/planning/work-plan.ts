import { sessionStoreFs } from '../../../store/session-store-fs';
import type { ToolHandler } from '../types';

export const name = 'work_plan' as const;

export const definition = {
  type: 'function',
  name,
  description:
    'Create and manage a multi-step work plan for the current session. Use "create" to declare an ordered list of steps (id, title, order, optional estimated_seconds), "complete" to mark a step done by id, and "revise" to add/remove/reorder/update steps.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: { type: 'string', enum: ['create', 'complete', 'revise'] },
      id: { type: ['string', 'null'], description: 'Step id for complete' },
      items: {
        type: ['array', 'null'],
        description: 'List of steps for create or revise',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: ['string', 'null'] },
            order: { type: ['number', 'null'] },
            estimated_seconds: { type: ['number', 'null'] },
            remove: { type: ['boolean', 'null'] },
          },
          required: ['id', 'title', 'order', 'estimated_seconds', 'remove'],
        },
      },
    },
    required: ['command', 'id', 'items'],
  },
} as const;

type WorkPlanInput = {
  command: 'create' | 'complete' | 'revise';
  id?: string | null;
  items?: Array<{ id: string; title?: string | null; order?: number | null; estimated_seconds?: number | null; remove?: boolean | null }> | null;
};

export const run: ToolHandler<WorkPlanInput, any> = async (input, { sessionId }) => {
  if (!sessionId) throw new Error('work_plan requires sessionId context');
  const cmd = input.command;
  if (cmd === 'create') {
    const items = (input.items || [])
      .filter(Boolean)
      .map((it: any, idx: number) => ({ id: String(it.id), title: String(it.title || it.id), order: typeof it.order === 'number' ? it.order : idx + 1, estimated_seconds: typeof it.estimated_seconds === 'number' ? it.estimated_seconds : undefined }));
    await sessionStoreFs.recordWorkPlanCreate(sessionId, items);
    return `Created work plan with ${items.length} steps`;
  }
  if (cmd === 'complete') {
    const stepId = input.id ? String(input.id) : '';
    const res = await sessionStoreFs.recordWorkPlanComplete(sessionId, stepId);
    if (!res) return `Completed step: ${stepId}`;
    const nextText = res.next ? ` Next: ${res.next.title}` : '';
    return `Completed "${res.completedItem.title}" (${res.completed}/${res.total}).${nextText}`;
  }
  if (cmd === 'revise') {
    const items = (input.items || [])
      .filter(Boolean)
      .map((it: any) => ({
        id: String(it.id),
        title: typeof it.title === 'string' ? it.title : undefined,
        order: typeof it.order === 'number' ? it.order : undefined,
        estimated_seconds: typeof it.estimated_seconds === 'number' ? it.estimated_seconds : undefined,
        remove: !!it.remove,
      }));
    const out = await sessionStoreFs.recordWorkPlanRevise(sessionId, items);
    return `Revised work plan. Total steps: ${out?.total ?? 'unknown'}`;
  }
  return 'Unknown work_plan command';
};


