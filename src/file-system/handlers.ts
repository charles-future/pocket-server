/**
 * File System Route Handlers
 * HTTP endpoints for file and terminal operations
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileSystemService } from './service';
import { telescopeSearch } from './telescope-search';
import { terminalService } from './terminal';
import type { SearchOptions, TerminalCommand } from './types';

/**
 * List directory contents
 * GET /fs/list?path=/some/path
 */
export async function handleList(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || homedir();
  
  const result = await fileSystemService.list(path);
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify(result.value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Read file contents
 * GET /fs/read?path=/some/file.txt
 */
export async function handleRead(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  
  if (!path) {
    return new Response(JSON.stringify({ error: 'Path parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const result = await fileSystemService.read(path);
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify(result.value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Write file contents
 * POST /fs/write
 * Body: { path: string, content: string }
 */
export async function handleWrite(req: Request): Promise<Response> {
  try {
    const { path, content } = await req.json();
    
    if (!path || content === undefined) {
      return new Response(JSON.stringify({ error: 'Path and content required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    const result = await fileSystemService.write(path, content);
    
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    
    
    return new Response(JSON.stringify(result.value), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Delete file or directory
 * DELETE /fs/delete?path=/some/path
 */
export async function handleDelete(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  
  if (!path) {
    return new Response(JSON.stringify({ error: 'Path parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const result = await fileSystemService.delete(path);
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Search for files and directories
 * GET /fs/search?query=term&path=/start/path&limit=50
 */
export async function handleSearch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query');
  
  if (!query) {
    return new Response(JSON.stringify({ error: 'Query parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const options: SearchOptions = {
    query,
    path: url.searchParams.get('path') || undefined,
    maxDepth: parseInt(url.searchParams.get('maxDepth') || '3', 10),
    includeHidden: url.searchParams.get('includeHidden') === 'true',
    limit: parseInt(url.searchParams.get('limit') || '50', 10),
  };
  
  const result = await fileSystemService.search(options);
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify(result.value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle Telescope-like search
 * GET /fs/telescope?query=...&mode=files|content|symbols|all
 */
export async function handleTelescopeSearch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get('query') || '';
  const cwd = url.searchParams.get('cwd') || process.cwd();
  const mode = (url.searchParams.get('mode') || 'files') as any;
  const includeHidden = url.searchParams.get('includeHidden') === 'true';
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const maxDepth = parseInt(url.searchParams.get('maxDepth') || '10', 10);
  
  // Enforce HOME_DIR boundary
  const resolvedCwd = pathResolve(cwd);
  const home = homedir();
  if (!resolvedCwd.startsWith(home)) {
    return new Response(JSON.stringify({ error: 'Access denied: cwd outside home directory' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  // Load .gitignore patterns from cwd if present to respect user repo ignores
  let excludePatterns: string[] | undefined;
  try {
    const gitignorePath = pathJoin(resolvedCwd, '.gitignore');
    const gitignoreContent = await fsReadFile(gitignorePath, 'utf8');
    // Split into non-empty, non-comment lines
    excludePatterns = gitignoreContent
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'));
  } catch {
    // No .gitignore or cannot read; fall back to defaults inside service
    excludePatterns = undefined;
  }
  
  const result = await telescopeSearch.search({
    query,
    cwd: resolvedCwd,
    mode,
    includeHidden,
    limit,
    excludePatterns,
    maxDepth: Number.isFinite(maxDepth) ? Math.min(Math.max(maxDepth, 1), 25) : 10,
  });
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify(result.value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Get file/directory metadata
 * GET /fs/metadata?path=/some/path
 */
export async function handleMetadata(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  
  if (!path) {
    return new Response(JSON.stringify({ error: 'Path parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const result = await fileSystemService.metadata(path);
  
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  return new Response(JSON.stringify(result.value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Execute terminal command
 * POST /fs/terminal
 * Body: { command: string, cwd?: string, timeout?: number }
 */
export async function handleTerminal(req: Request): Promise<Response> {
  try {
    const cmd: TerminalCommand = await req.json();
    
    if (!cmd.command) {
      return new Response(JSON.stringify({ error: 'Command required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    const result = await terminalService.execute(cmd);
    
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response(JSON.stringify(result.value), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Get home directory
 * GET /fs/home
 */
export async function handleHome(): Promise<Response> {
  return new Response(JSON.stringify({ path: homedir() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}