import { verifyAuthFromRequest } from '../auth/middleware';
import type { Router } from '../server/router';
import type { TerminalRegistry } from './registry';
import type { TerminalManager } from './terminal-manager';

export function registerTerminalRoutes(router: Router, manager: TerminalManager, registry: TerminalRegistry): void {
  // Protect all terminal routes
  router.usePre(async (req) => {
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });

  router.get('/sessions', (_req) => {
    const items = registry.list().map((t) => {
      const s = manager.get(t.id);
      // Trust registry.active but recompute if PTY still exists
      const active = !!s && t.active !== false;
      return {
        id: t.id,
        title: t.title,
        cwd: t.cwd,
        createdAt: t.createdAt,
        cols: s?.cols ?? t.cols,
        rows: s?.rows ?? t.rows,
        active,
        ownerClientId: t.ownerClientId,
        ownerDeviceId: t.ownerDeviceId,
        lastAttachedAt: t.lastAttachedAt,
      };
    });
    return new Response(JSON.stringify({ sessions: items }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
