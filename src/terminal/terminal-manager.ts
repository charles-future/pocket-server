/**
 * Terminal PTY Manager
 * Handles PTY operations without parsing
 */

import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { logger } from '../shared/logger';

export interface TerminalSession {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
}

interface PTYSession extends TerminalSession {
  pty: pty.IPty;
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, PTYSession>();
  
  /**
   * Open a new terminal session
   */
  open(id: string, cwd: string, rows: number = 24, cols: number = 80): TerminalSession {
    if (this.sessions.has(id)) {
      this.close(id);
    }
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      } as any,
    });
    ptyProcess.onData((data: string) => {
      this.emit('data', { id, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      const code = exitCode || (signal ? 128 : 0);
      this.emit('exit', { id, code });
      this.sessions.delete(id);
      logger.terminal('session_closed', id, { code });
    });
    const session: PTYSession = {
      id,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      pty: ptyProcess,
    };
    this.sessions.set(id, session);
    logger.terminal('session_opened', id, { cwd, cols, rows });
    return { id, cwd, cols, rows, createdAt: session.createdAt };
  }
  
  /**
   * Write data to terminal
   */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      logger.terminal('write_failed', id, { error: 'Session not found' });
      return;
    }
    session.pty.write(data);
    logger.terminal('write', id, { length: data.length });
  }
  
  /**
   * Resize terminal
   */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      logger.terminal('resize_failed', id, { error: 'Session not found' });
      return;
    }
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    logger.terminal('resized', id, { cols, rows });
  }
  
  /**
   * Close terminal session
   */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.pty.kill();
    } catch (error) {
      logger.terminal('close_error', id, { error });
    } finally {
      this.sessions.delete(id);
      logger.terminal('session_closed', id);
    }
  }
  
  /**
   * Get a terminal session
   */
  get(id: string): TerminalSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return { id: session.id, cwd: session.cwd, cols: session.cols, rows: session.rows, createdAt: session.createdAt };
  }
  
  /**
   * Get all active sessions
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
  
  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}


