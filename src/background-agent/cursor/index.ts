import { verifyAuthFromRequest } from '../../auth/middleware';
import type { Router } from '../../server/router';
import { registerCursorCloudRoutes } from './routes';

export function registerBackgroundAgentCursor(router: Router) {
  // Protect all cloud routes
  router.usePre(async (req) => {
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });
  registerCursorCloudRoutes(router);
}

export type { StructuredDiff } from './github';
// Export types for external use
export type { CursorAgentMinimal, CursorConversationMessage } from './types';


