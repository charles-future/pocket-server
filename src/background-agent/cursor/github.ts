import { logger } from '../../shared/logger';

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string; // For renamed files
  hunks: DiffHunk[];
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'add' | 'delete' | 'normal';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface StructuredDiff {
  files: DiffFile[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  prInfo?: {
    number: number;
    title: string;
    state: string;
    baseRef: string;
    headRef: string;
  };
  compareInfo?: {
    baseRef: string;
    headRef: string;
  };
}

/**
 * Extracts GitHub repository info from a PR URL
 */
export function extractGitHubInfo(prUrl: string): { owner: string; repo: string; prNumber: number } | null {
  try {
    // Match GitHub PR URL pattern: https://github.com/owner/repo/pull/123
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) {
      logger.warn('GitHub', 'Invalid PR URL format', { prUrl });
      return null;
    }
    
    return {
      owner: match[1],
      repo: match[2],
      prNumber: parseInt(match[3], 10),
    };
  } catch (error) {
    logger.error('GitHub', 'Failed to extract info from PR URL', { prUrl, error });
    return null;
  }
}

/**
 * Parse a GitHub repository URL like github.com/owner/repo into owner/repo
 */
export function parseRepositoryUrl(repoUrl: string): { owner: string; repo: string } | null {
  try {
    // Accept with or without https:// prefix
    const clean = repoUrl.replace(/^https?:\/\//, '');
    const match = clean.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

/**
 * Fetches PR information from GitHub API
 */
export async function fetchPRInfo(token: string, owner: string, repo: string, prNumber: number) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      baseRef: data.base.ref,
      headRef: data.head.ref,
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
    };
  } catch (error) {
    logger.error('GitHub', 'Failed to fetch PR info', { owner, repo, prNumber, error });
    throw error;
  }
}

/**
 * Fetches the raw diff from GitHub API
 */
export async function fetchPRDiff(token: string, owner: string, repo: string, prNumber: number): Promise<string> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3.diff',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Pull request not found');
      } else if (response.status === 401) {
        throw new Error('Invalid GitHub token or insufficient permissions');
      } else if (response.status === 403) {
        throw new Error('Access forbidden - check repository permissions');
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const diff = await response.text();
    return diff;
  } catch (error) {
    logger.error('GitHub', 'Failed to fetch PR diff', { owner, repo, prNumber, error });
    throw error;
  }
}

/**
 * Fetches the list of changed files in a PR
 */
export async function fetchPRFiles(token: string, owner: string, repo: string, prNumber: number) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const files = await response.json();
    
    return files.map((file: any) => ({
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
    }));
  } catch (error) {
    logger.error('GitHub', 'Failed to fetch PR files', { owner, repo, prNumber, error });
    throw error;
  }
}

/**
 * Parses a unified diff string into a structured format
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;
  let remainingOldLines = 0;
  let remainingNewLines = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      // Save previous file if exists
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }
      
      // Extract file path
      const pathMatch = line.match(/diff --git a\/(.+) b\/(.+)/);
      if (pathMatch) {
        currentFile = {
          path: pathMatch[2],
          additions: 0,
          deletions: 0,
          status: 'modified',
          hunks: [],
        };
      }
      continue;
    }
    
    // File rename: rename from/to
    if (line.startsWith('rename from ')) {
      if (currentFile) {
        currentFile.previousPath = line.substring('rename from '.length);
        currentFile.status = 'renamed';
      }
      continue;
    }
    
    // New file
    if (line.startsWith('new file mode')) {
      if (currentFile) {
        currentFile.status = 'added';
      }
      continue;
    }
    
    // Deleted file
    if (line.startsWith('deleted file mode')) {
      if (currentFile) {
        currentFile.status = 'deleted';
      }
      continue;
    }
    
    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@ context
    if (line.startsWith('@@')) {
      // Save previous hunk if exists
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      
      const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        oldLineNum = parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
        newLineNum = parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
        
        remainingOldLines = oldLines;
        remainingNewLines = newLines;
        
        currentHunk = {
          oldStart: oldLineNum,
          oldLines: oldLines,
          newStart: newLineNum,
          newLines: newLines,
          lines: [],
        };
      }
      continue;
    }
    
    // Diff lines
    if (currentFile && currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'add',
          content: line.substring(1),
          newLine: newLineNum++,
        });
        currentFile.additions++;
        remainingNewLines--;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLine: oldLineNum++,
        });
        currentFile.deletions++;
        remainingOldLines--;
      } else if (line.startsWith(' ') || (remainingOldLines > 0 || remainingNewLines > 0)) {
        // Context line or continuation
        currentHunk.lines.push({
          type: 'normal',
          content: line.startsWith(' ') ? line.substring(1) : line,
          oldLine: oldLineNum++,
          newLine: newLineNum++,
        });
        remainingOldLines--;
        remainingNewLines--;
      }
    }
  }
  
  // Save last file and hunk
  if (currentFile && currentHunk) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }
  
  return files;
}

/**
 * Formats the diff for mobile display
 */
export function formatDiffForMobile(files: DiffFile[], prInfo?: any): StructuredDiff {
  // Calculate total stats
  const stats = files.reduce(
    (acc, file) => ({
      filesChanged: acc.filesChanged + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { filesChanged: 0, additions: 0, deletions: 0 }
  );
  
  return {
    files,
    stats,
    prInfo: prInfo ? {
      number: prInfo.number,
      title: prInfo.title,
      state: prInfo.state,
      baseRef: prInfo.baseRef,
      headRef: prInfo.headRef,
    } : undefined,
  };
}

/**
 * Main function to get structured diff from a PR URL
 */
export async function getStructuredDiff(token: string, prUrl: string): Promise<StructuredDiff | null> {
  try {
    // Extract GitHub info from URL
    const githubInfo = extractGitHubInfo(prUrl);
    if (!githubInfo) {
      throw new Error('Invalid GitHub PR URL');
    }
    
    const { owner, repo, prNumber } = githubInfo;
    
    // Fetch PR info and diff in parallel
    const [prInfo, diffText] = await Promise.all([
      fetchPRInfo(token, owner, repo, prNumber),
      fetchPRDiff(token, owner, repo, prNumber),
    ]);
    
    // Parse the diff
    const files = parseDiff(diffText);
    
    // Format for mobile
    const structuredDiff = formatDiffForMobile(files, prInfo);
    
    logger.info('GitHub', 'Successfully fetched and parsed diff', {
      prUrl,
      filesChanged: structuredDiff.stats.filesChanged,
      additions: structuredDiff.stats.additions,
      deletions: structuredDiff.stats.deletions,
    });
    
    return structuredDiff;
  } catch (error) {
    logger.error('GitHub', 'Failed to get structured diff', { prUrl, error });
    return null;
  }
}

/**
 * Find a PR by head branch
 */
export async function findPullRequestByBranch(token: string, owner: string, repo: string, headBranch: string) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(headBranch)}&state=all&per_page=1`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return null;
  const items = await res.json();
  return Array.isArray(items) && items.length > 0 ? items[0] : null;
}

/**
 * Get the default branch of a repository
 */
export async function getDefaultBranch(token: string, owner: string, repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}` , {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.default_branch || null;
}

/**
 * Build a structured diff from the GitHub compare API between base...head
 */
export async function getStructuredDiffFromCompare(token: string, owner: string, repo: string, baseRef: string, headRef: string): Promise<StructuredDiff | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.diff',
      },
    });
    if (!res.ok) {
      logger.error('GitHub', 'compare_failed', { owner, repo, baseRef, headRef, status: res.status });
      return null;
    }
    const diffText = await res.text();
    const files = parseDiff(diffText);
    return {
      files,
      stats: files.reduce(
        (acc, f) => ({ filesChanged: acc.filesChanged + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
        { filesChanged: 0, additions: 0, deletions: 0 }
      ),
      compareInfo: { baseRef, headRef },
    };
  } catch (error) {
    logger.error('GitHub', 'compare_exception', { owner, repo, baseRef, headRef, error });
    return null;
  }
}