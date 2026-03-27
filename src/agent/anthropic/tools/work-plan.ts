/**
 * Work Plan Tool
 * Lets the model declare a multi-step plan and mark steps complete.
 * We persist plan state in the session snapshot and emit targeted push notifications
 * via the existing Expo notifications pipeline.
 */

import { notificationsService } from '../../../notifications/index';
import { getInitiatorDeviceId } from '../../session-initiators';
import { sessionStoreFs } from '../../store/session-store-fs';
import type { WorkPlanCommand, WorkPlanTool } from '../types';

export const workPlanToolDefinition: WorkPlanTool = {
  name: 'work_plan',
  description:
    'Create and manage a multi-step work plan for the current session. Use "create" to declare an ordered list of steps (id, title, order, optional estimated_seconds), "complete" to mark a step done by id, and "revise" to add/remove/reorder/update steps. Keep titles short and mobile-friendly.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['create', 'complete', 'revise'] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            order: { type: 'integer', minimum: 1 },
            estimated_seconds: { type: 'integer', minimum: 1 },
            remove: { type: 'boolean' }
          },
          additionalProperties: false
        }
      },
      id: { type: 'string' }
    },
    required: ['command'],
    additionalProperties: false
  }
};

/**
 * Execute work plan command. This mutates server-side plan state for the session.
 * Returns a short, user-readable summary used in the tool_result block.
 */
export async function executeWorkPlan(
  sessionId: string,
  input: WorkPlanCommand,
): Promise<string> {
  switch (input.command) {
    case 'create': {
      const items = (input.items || []).slice().sort((a, b) => a.order - b.order);
      if (items.length === 0) {
        return 'No work plan items provided';
      }
      await sessionStoreFs.recordWorkPlanCreate(sessionId, items);
      // Notify: show the first current task
      const snap = await sessionStoreFs.getSnapshot(sessionId);
      const title = snap?.title || 'Agent';
      const total = items.length;
      const first = items[0]?.title || 'Step 1';
      const deviceId = snap?.initiatorDeviceId || getInitiatorDeviceId(sessionId);
      if (deviceId) {
        await notificationsService.notifyAgentPlanProgress({
          deviceId,
          sessionId,
          sessionTitle: title,
          kind: 'created',
          stepIndex: 1,
          total,
          taskTitle: first,
        });
      }
      return `Work plan created with ${total} steps.`;
    }

    case 'complete': {
      if (typeof (input as any).id !== 'string' || !(input as any).id.trim()) {
        return 'No id provided for complete command';
      }
      const res = await sessionStoreFs.recordWorkPlanComplete(sessionId, (input as any).id);
      if (!res) {
        return `No matching step found for id ${(input as any).id}`;
      }
      const snap = await sessionStoreFs.getSnapshot(sessionId);
      const title = snap?.title || 'Agent';
      const deviceId = snap?.initiatorDeviceId || getInitiatorDeviceId(sessionId);
      if (deviceId) {
        await notificationsService.notifyAgentPlanProgress({
          deviceId,
          sessionId,
          sessionTitle: title,
          kind: res.next ? 'next' : 'completed',
          stepIndex: res.next ? res.completed + 1 : res.total,
          total: res.total,
          taskTitle: res.next?.title || 'All steps completed',
        });
      }
      if (res.next) {
        return `Completed step "${res.completedItem.title}". Next: (${res.completed + 1}/${res.total}) "${res.next.title}".`;
      }
      return `Completed step "${res.completedItem.title}". Plan finished (${res.total}/${res.total}).`;
    }

    case 'revise': {
      if (!Array.isArray((input as any).items) || (input as any).items.length === 0) {
        return 'No revisions provided';
      }
      const res = await sessionStoreFs.recordWorkPlanRevise(sessionId, (input as any).items || []);
      const count = res?.total ?? 0;
      return `Revised work plan. Now ${count} steps.`;
    }

    default:
      return `Unknown work_plan command`;
  }
}
