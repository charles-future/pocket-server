/**
 * File System Module
 * Public API exports
 */

export * from './handlers';
export { fileSystemService } from './service';
export { terminalService } from './terminal';
export * from './types';

import { verifyAuthFromRequest } from '../auth/middleware';
import type { Router } from '../server/router';
import {
  handleDelete,
  handleHome,
  handleList,
  handleMetadata,
  handleRead,
  handleSearch,
  handleTelescopeSearch,
  handleTerminal,
  handleWrite,
} from './handlers';

/**
 * Register all file system routes
 */
export function registerFileSystemRoutes(router: Router): void {
  // Protect all FS routes
  router.usePre(async (req) => {
    const auth = await verifyAuthFromRequest(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { 'Content-Type': 'application/json' } });
    }
    return null;
  });
  // File operations
  router.get('/list', handleList);
  router.get('/read', handleRead);
  router.post('/write', handleWrite);
  router.delete('/delete', handleDelete);
  router.get('/search', handleSearch);
  router.get('/telescope', handleTelescopeSearch);
  router.get('/metadata', handleMetadata);
  router.get('/home', handleHome);
  
  // Terminal
  router.post('/terminal', handleTerminal);
}