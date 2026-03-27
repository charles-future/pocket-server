/**
 * Router adapter for Hono
 * Provides compatibility layer for modules expecting Router interface
 *
 * Why this exists: elsewhere in the codebase we register routes against a
 * simple Router API (get/post/put/delete + optional pre-handler). Hono is our
 * HTTP framework, but its Handler signature differs slightly. This adapter
 * keeps route registration decoupled from Hono so we can test handlers in
 * isolation and potentially swap frameworks without touching feature modules.
 *
 * Limitations: paths are exact-match only; no `:param` patterns yet. Add a
 * thin pattern-matching layer here if/when needed so feature modules stay
 * unchanged.
 */

import { Hono } from 'hono';
import { logger } from '../shared/logger';

// Route handlers always receive the raw Request so modules do not depend on
// framework-specific Context objects.
type RouteHandler = (req: Request) => Promise<Response> | Response;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export class Router {
  private app: Hono;
  private prefix: string;
  private preHandler: ((req: Request) => Promise<Response | null> | Response | null) | null = null;
  
  constructor(prefix: string = '') {
    this.app = new Hono();
    this.prefix = prefix;
  }
  
  /**
   * Register a route
   *
   * Why: centralize error handling so feature handlers can be small and focus
   * on business logic. The preHandler runs before the route for common checks
   * (e.g., auth). Returning a Response from preHandler short-circuits the
   * request.
   */
  add(method: string, path: string, handler: RouteHandler): void {
    const fullPath = this.prefix + path;
    
    switch (method.toUpperCase()) {
      case 'GET':
        this.app.get(fullPath, async (c) => {
          try {
            if (this.preHandler) {
              const maybe = await this.preHandler(c.req.raw);
              if (maybe) return maybe;
            }
            const response = await handler(c.req.raw);
            return response;
          } catch (error) {
            logger.error('Router', `Request failed: ${method} ${fullPath}`, error);
            return c.json({ error: 'Internal server error' }, 500);
          }
        });
        break;
      case 'POST':
        this.app.post(fullPath, async (c) => {
          try {
            if (this.preHandler) {
              const maybe = await this.preHandler(c.req.raw);
              if (maybe) return maybe;
            }
            const response = await handler(c.req.raw);
            return response;
          } catch (error) {
            logger.error('Router', `Request failed: ${method} ${fullPath}`, error);
            return c.json({ error: 'Internal server error' }, 500);
          }
        });
        break;
      case 'PUT':
        this.app.put(fullPath, async (c) => {
          try {
            if (this.preHandler) {
              const maybe = await this.preHandler(c.req.raw);
              if (maybe) return maybe;
            }
            const response = await handler(c.req.raw);
            return response;
          } catch (error) {
            logger.error('Router', `Request failed: ${method} ${fullPath}`, error);
            return c.json({ error: 'Internal server error' }, 500);
          }
        });
        break;
      case 'DELETE':
        this.app.delete(fullPath, async (c) => {
          try {
            if (this.preHandler) {
              const maybe = await this.preHandler(c.req.raw);
              if (maybe) return maybe;
            }
            const response = await handler(c.req.raw);
            return response;
          } catch (error) {
            logger.error('Router', `Request failed: ${method} ${fullPath}`, error);
            return c.json({ error: 'Internal server error' }, 500);
          }
        });
        break;
    }
  }
  
  /**
   * Convenience methods
   */
  get = (path: string, handler: RouteHandler) => this.add('GET', path, handler);
  post = (path: string, handler: RouteHandler) => this.add('POST', path, handler);
  put = (path: string, handler: RouteHandler) => this.add('PUT', path, handler);
  delete = (path: string, handler: RouteHandler) => this.add('DELETE', path, handler);
  
  /**
   * Get the Hono app instance for mounting
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Set a pre-handler to run before each route handler; return a Response to short-circuit.
   */
  usePre(fn: (req: Request) => Promise<Response | null> | Response | null): void {
    this.preHandler = fn;
  }
}

// Export a function to create routers with prefixes
export function createRouter(prefix: string = ''): Router {
  return new Router(prefix);
}