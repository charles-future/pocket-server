/**
 * Bash Tool Implementation
 * Wraps the existing terminal service for Anthropic API compatibility
 */

import { terminalService } from '../../../file-system/terminal';
import type { Result } from '../../../shared/types/api';
import type { BashTool, BashToolInput } from '../types';

/**
 * Bash tool definition for Anthropic API
 */
export const bashToolDefinition: BashTool = {
  type: 'bash_20250124',
  name: 'bash'
};

/**
 * Execute bash command using existing terminal service
 */
export async function executeBash(
  input: BashToolInput,
  workingDir: string
): Promise<string> {
  // Handle restart command
  if (input.restart) {
    return 'Bash session restarted';
  }

  // Validate command
  if (!input.command) {
    return 'Error: No command provided';
  }

  // Execute using terminal service
  const result = await terminalService.execute({
    command: input.command,
    cwd: workingDir,
    timeout: 30000 // 30 second timeout
  });

  if (!result.ok) {
    return `Error: ${result.error.message}`;
  }

  // Format output
  const { stdout, stderr, exitCode } = result.value;
  
  // Combine stdout and stderr
  let output = stdout;
  if (stderr) {
    output += stderr ? `\n${stderr}` : '';
  }

  // If no output, indicate completion
  if (!output.trim()) {
    return `Command completed with exit code ${exitCode}`;
  }

  return truncateOutput(output);
}

/**
 * Truncate output to stay within token limits
 */
function truncateOutput(output: string): string {
  const maxChars = 50000; // ~12.5k tokens
  const maxLines = 1000;
  
  if (output.length <= maxChars) {
    return output;
  }
  
  const lines = output.split('\n');
  
  if (lines.length > maxLines) {
    // Line-based truncation
    const truncatedLines = lines.slice(0, maxLines);
    const truncated = truncatedLines.join('\n');
    
    if (truncated.length > maxChars) {
      // Still too long, do character truncation
      return `${truncated.substring(0, maxChars)}\n\n... Output truncated (${lines.length} total lines) ...`;
    }
    
    return `${truncated}\n\n... Output truncated (${lines.length} total lines) ...`;
  }
  
  // Simple character truncation
  return `${output.substring(0, maxChars)}\n\n... Output truncated (${output.length} total characters) ...`;
}

/**
 * Check if a command is dangerous (for max mode auto-approval)
 */
export function isBashCommandDangerous(command: string): boolean {
  const dangerousPatterns = [
    /\brm\s+-rf\s+\//,           // rm -rf on root paths
    /\bsudo\b/,                  // sudo commands
    /\b(shutdown|reboot|halt)\b/, // system control
    /\bmkfs\b/,                  // filesystem formatting
    /\bdd\s+.*of=\/dev/,         // dd to devices
    /\b:\(\)\s*\{.*:\|:/,       // fork bomb
    /\b(kill|pkill|killall)\s+-9/, // force kill
  ];

  return dangerousPatterns.some(pattern => pattern.test(command));
}