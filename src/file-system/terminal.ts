/**
 * Terminal Service
 * Execute commands with full access to your machine
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Result } from '../shared/types/api';
import type { TerminalCommand, TerminalOutput, TerminalService } from './types';

const HOME_DIR = homedir();
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT_SIZE = 100000; // ~100KB for better output

/**
 * Terminal Service Implementation
 * Full access to your machine's terminal
 */
class TerminalServiceImpl implements TerminalService {
  /**
   * Check if command is safe (always true for personal use)
   */
  isCommandSafe(command: string): boolean {
    return command.trim().length > 0;
  }
  
  /**
   * Execute any terminal command
   */
  async execute(cmd: TerminalCommand): Promise<Result<TerminalOutput>> {
    const { command, cwd = HOME_DIR, timeout = DEFAULT_TIMEOUT } = cmd;
    
    // Validate command not empty
    if (!command.trim()) {
      return { 
        ok: false, 
        error: new Error('Command cannot be empty') 
      };
    }
    
    // Resolve working directory
    const resolvedCwd = resolve(cwd);
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let outputSize = 0;
      
      // Spawn the process
      const proc = spawn('bash', ['-c', command], {
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      
      // Handle stdout
      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        outputSize += chunk.length;
        
        // Truncate if exceeding max size
        if (outputSize <= MAX_OUTPUT_SIZE) {
          stdout += chunk;
        } else if (stdout.length < MAX_OUTPUT_SIZE) {
          const remaining = MAX_OUTPUT_SIZE - stdout.length;
          stdout += chunk.substring(0, remaining);
          stdout += '\n\n[Output truncated - exceeded 100KB]';
        }
      });
      
      // Handle stderr
      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        
        // Keep stderr reasonable
        if (stderr.length > 20000) {
          stderr = stderr.substring(0, 20000) + '\n\n[Error output truncated]';
        }
      });
      
      // Set timeout
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 1000);
      }, timeout);
      
      // Handle completion
      proc.on('close', (code) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        
        resolve({
          ok: true,
          value: {
            stdout,
            stderr,
            exitCode: code,
            duration,
          },
        });
      });
      
      // Handle errors
      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      });
    });
  }
}

export const terminalService = new TerminalServiceImpl();