/**
 * Text Editor Tool Implementation
 * Wraps the existing file system service for Anthropic API compatibility
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileSystemService } from '../../../file-system/service';
import type { CreateCommand, InsertCommand, StrReplaceCommand, TextEditorCommand, TextEditorTool, ViewCommand } from '../types';

/**
 * Text editor tool definition for Anthropic API
 */
export const editorToolDefinition: TextEditorTool = {
  type: 'text_editor_20250728',
  name: 'str_replace_based_edit_tool'
};

/**
 * Execute text editor commands
 */
export async function executeEditor(
  input: TextEditorCommand,
  workingDir: string
): Promise<string> {
  try {
    switch (input.command) {
      case 'view':
        return await viewFile(input as ViewCommand, workingDir);
      case 'str_replace':
        return await strReplace(input as StrReplaceCommand, workingDir);
      case 'create':
        return await createFile(input as CreateCommand, workingDir);
      case 'insert':
        return await insertText(input as InsertCommand, workingDir);
      case 'undo_edit':
        return 'Error: undo_edit is not supported in this version';
      default:
        return `Error: Unknown command ${(input as any).command}`;
    }
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * View file or directory contents
 */
async function viewFile(input: ViewCommand, workingDir: string): Promise<string> {
  const fullPath = resolve(workingDir, input.path);
  
  try {
    const stats = await stat(fullPath);
    
    if (stats.isDirectory()) {
      // List directory contents
      const result = await fileSystemService.list(fullPath);
      if (!result.ok) {
        return `Error: ${result.error.message}`;
      }
      
      // Format directory listing
      const lines = ['Directory contents:'];
      for (const node of result.value.nodes) {
        const type = node.type === 'directory' ? 'd' : 'f';
        lines.push(`[${type}] ${node.name}`);
      }
      return lines.join('\n');
    } else {
      // Read file contents
      const result = await fileSystemService.read(fullPath);
      if (!result.ok) {
        return `Error: ${result.error.message}`;
      }
      
      // Format with line numbers if view_range is not specified
      if (!input.view_range) {
        const lines = result.value.content.split('\n');
        const numberedLines = lines.map((line, i) => `${i + 1}: ${line}`);
        return numberedLines.join('\n');
      }
      
      // Handle view_range
      const [start, end] = input.view_range;
      const lines = result.value.content.split('\n');
      const startLine = Math.max(1, start);
      const endLine = end === -1 ? lines.length : Math.min(lines.length, end);
      
      const selectedLines = lines.slice(startLine - 1, endLine);
      const numberedLines = selectedLines.map((line, i) => `${startLine + i}: ${line}`);
      return numberedLines.join('\n');
    }
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * Replace text in file
 */
async function strReplace(input: StrReplaceCommand, workingDir: string): Promise<string> {
  const fullPath = resolve(workingDir, input.path);
  
  // Read current content
  const readResult = await fileSystemService.read(fullPath);
  if (!readResult.ok) {
    return `Error: ${readResult.error.message}`;
  }
  
  const content = readResult.value.content;
  const { old_str, new_str } = input;
  
  // Count occurrences
  const occurrences = content.split(old_str).length - 1;
  
  if (occurrences === 0) {
    return 'Error: No match found for replacement text';
  }
  
  if (occurrences > 1) {
    return `Error: Found ${occurrences} matches. Please provide more specific text to match exactly one location`;
  }
  
  // Perform replacement
  const newContent = content.replace(old_str, new_str);
  
  // Write back
  const writeResult = await fileSystemService.write(fullPath, newContent);
  if (!writeResult.ok) {
    return `Error: ${writeResult.error.message}`;
  }
  
  return 'Successfully replaced text at exactly one location';
}

/**
 * Create new file
 */
async function createFile(input: CreateCommand, workingDir: string): Promise<string> {
  const fullPath = resolve(workingDir, input.path);
  
  // Check if file already exists
  try {
    await stat(fullPath);
    return 'Error: File already exists';
  } catch {
    // File doesn't exist, good to create
  }
  
  // Write file
  const writeResult = await fileSystemService.write(fullPath, input.file_text);
  if (!writeResult.ok) {
    return `Error: ${writeResult.error.message}`;
  }
  
  return `Successfully created file: ${input.path}`;
}

/**
 * Insert text at specific line
 */
async function insertText(input: InsertCommand, workingDir: string): Promise<string> {
  const fullPath = resolve(workingDir, input.path);
  
  // Read current content
  const readResult = await fileSystemService.read(fullPath);
  if (!readResult.ok) {
    return `Error: ${readResult.error.message}`;
  }
  
  const lines = readResult.value.content.split('\n');
  const { insert_line, new_str } = input;
  
  // Validate line number
  if (insert_line < 0 || insert_line > lines.length) {
    return `Error: Invalid line number ${insert_line}. File has ${lines.length} lines`;
  }
  
  // Insert at beginning (line 0)
  if (insert_line === 0) {
    lines.unshift(new_str);
  } else {
    // Insert after specified line
    lines.splice(insert_line, 0, new_str);
  }
  
  // Write back
  const newContent = lines.join('\n');
  const writeResult = await fileSystemService.write(fullPath, newContent);
  if (!writeResult.ok) {
    return `Error: ${writeResult.error.message}`;
  }
  
  return `Successfully inserted text at line ${insert_line}`;
}

/**
 * Check if an editor command is dangerous (for max mode auto-approval)
 */
export function isEditorCommandDangerous(input: TextEditorCommand): boolean {
  // Only view commands are considered safe for auto-approval
  if (input.command === 'view') {
    return false;
  }
  
  // All modifications require approval
  return true;
}