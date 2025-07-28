/**
 * Git-Aware Code Indexer
 * Advanced algorithms for indexing Git commits with temporal and diff awareness
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { BranchConfigManager, BranchIndexingPolicy } from './branch-config';
import { CodeChunk, Project } from '../types';

// Git-specific types
export interface GitCommit {
  hash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  date: Date;
  message: string;
  branchNames: string[];
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export interface GitFileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
  isBinary: boolean;
  diffHunks?: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'added' | 'removed' | 'context';
  content: string;
  lineNumber: number;
}

export interface GitAwareCodeChunk extends CodeChunk {
  gitContext: {
    commitHash: string;
    branchName: string;
    authorInfo: {
      name: string;
      email: string;
    };
    commitDate: Date;
    parentCommits: string[];
    diffContext?: {
      changeType: 'added' | 'modified' | 'unchanged';
      linesAdded: number;
      linesRemoved: number;
      contextLines: number;
    };
  };
  temporalId: string; // Unique identifier for time+branch combination
}

export interface IndexingStrategy {
  name: string;
  description: string;
  execute(
    commits: GitCommit[],
    policy: BranchIndexingPolicy,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]>;
}

export interface IndexingContext {
  repositoryPath: string;
  projectId: string;
  branchName: string;
  existingChunks?: Map<string, GitAwareCodeChunk>;
  progressCallback?: (progress: IndexingProgress) => void;
}

export interface IndexingProgress {
  stage: 'discovering' | 'analyzing' | 'chunking' | 'embedding' | 'storing';
  currentCommit: number;
  totalCommits: number;
  currentFile?: string;
  filesProcessed: number;
  totalFiles: number;
  message: string;
}

/**
 * Main Git Indexer Class
 */
export class GitAwareIndexer {
  private branchConfig: BranchConfigManager;
  private strategies: Map<string, IndexingStrategy>;

  constructor(branchConfig: BranchConfigManager) {
    this.branchConfig = branchConfig;
    this.strategies = new Map();
    
    // Register built-in strategies
    this.registerStrategy(new FullHistoryStrategy());
    this.registerStrategy(new IncrementalDiffStrategy());
    this.registerStrategy(new SnapshotStrategy());
    this.registerStrategy(new HotspotStrategy());
  }

  /**
   * Index a Git repository branch with configurable strategy
   */
  async indexBranch(
    repositoryPath: string,
    projectId: string,
    branchName: string,
    options?: {
      strategy?: string;
      maxCommits?: number;
      since?: Date;
      progressCallback?: (progress: IndexingProgress) => void;
    }
  ): Promise<GitAwareCodeChunk[]> {
    const policy = this.branchConfig.getBranchPolicy(projectId, branchName);
    
    if (!policy.enabled) {
      throw new Error(`Branch ${branchName} is not enabled for indexing`);
    }

    // Discover commits to process
    const commits = await this.discoverCommits(
      repositoryPath,
      branchName,
      policy,
      options
    );

    const context: IndexingContext = {
      repositoryPath,
      projectId,
      branchName,
      progressCallback: options?.progressCallback
    };

    // Select indexing strategy
    const strategyName = this.selectStrategy(policy, commits.length);
    const strategy = this.strategies.get(strategyName);
    
    if (!strategy) {
      throw new Error(`Unknown indexing strategy: ${strategyName}`);
    }

    // Execute indexing strategy
    const chunks = await strategy.execute(commits, policy, context);

    // Post-process chunks (deduplication, validation, etc.)
    return this.postProcessChunks(chunks, policy);
  }

  /**
   * Incremental update - only process new commits
   */
  async incrementalUpdate(
    repositoryPath: string,
    projectId: string,
    branchName: string,
    lastIndexedCommit?: string
  ): Promise<GitAwareCodeChunk[]> {
    const newCommits = await this.getCommitsSince(
      repositoryPath,
      branchName,
      lastIndexedCommit
    );

    if (newCommits.length === 0) {
      return [];
    }

    // Use incremental diff strategy for updates
    const strategy = this.strategies.get('incremental-diff')!;
    const policy = this.branchConfig.getBranchPolicy(projectId, branchName);
    
    const context: IndexingContext = {
      repositoryPath,
      projectId,
      branchName
    };

    return strategy.execute(newCommits, policy, context);
  }

  // Private methods

  private async discoverCommits(
    repositoryPath: string,
    branchName: string,
    policy: BranchIndexingPolicy,
    options?: { maxCommits?: number; since?: Date }
  ): Promise<GitCommit[]> {
    let gitCommand = `git log ${branchName} --pretty=format:"%H|%P|%an|%ae|%cn|%ce|%ai|%s" --stat=1000,1000 --numstat`;
    
    // Apply policy constraints
    if (policy.indexDepth && policy.indexDepth > 0) {
      gitCommand += ` -n ${policy.indexDepth}`;
    }
    
    if (options?.maxCommits) {
      gitCommand += ` -n ${options.maxCommits}`;
    }
    
    if (options?.since) {
      gitCommand += ` --since="${options.since.toISOString()}"`;
    }
    
    if (policy.maxAge) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.maxAge);
      gitCommand += ` --since="${cutoffDate.toISOString()}"`;
    }

    const output = await this.executeGitCommand(gitCommand, repositoryPath);
    return this.parseGitLog(output);
  }

  private async getCommitsSince(
    repositoryPath: string,
    branchName: string,
    sinceCommit?: string
  ): Promise<GitCommit[]> {
    let gitCommand = `git log ${branchName} --pretty=format:"%H|%P|%an|%ae|%cn|%ce|%ai|%s" --stat=1000,1000 --numstat`;
    
    if (sinceCommit) {
      gitCommand += ` ${sinceCommit}..HEAD`;
    } else {
      gitCommand += ` -n 10`; // Default to last 10 commits if no since point
    }

    const output = await this.executeGitCommand(gitCommand, repositoryPath);
    return this.parseGitLog(output);
  }

  private selectStrategy(policy: BranchIndexingPolicy, commitCount: number): string {
    if (policy.diffOnly) {
      return 'incremental-diff';
    }
    
    if (commitCount > 1000) {
      return 'snapshot';
    }
    
    if (commitCount > 100) {
      return 'hotspot';
    }
    
    return 'full-history';
  }

  private registerStrategy(strategy: IndexingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  private async executeGitCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn('sh', ['-c', command], { cwd });
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed: ${stderr}`));
        }
      });
    });
  }

  private parseGitLog(output: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const commitBlocks = output.split('\n\n').filter(block => block.trim());

    for (const block of commitBlocks) {
      const lines = block.split('\n');
      const [hash, parents, authorName, authorEmail, committerName, committerEmail, date, message] = 
        lines[0].split('|');

      const stats = this.parseCommitStats(lines.slice(1));

      commits.push({
        hash,
        parentHashes: parents ? parents.split(' ') : [],
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        date: new Date(date),
        message,
        branchNames: [], // To be filled by branch detection
        stats
      });
    }

    return commits;
  }

  private parseCommitStats(statLines: string[]): GitCommit['stats'] {
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    for (const line of statLines) {
      if (line.includes('file') && line.includes('changed')) {
        const match = line.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?)?(?:,\s+(\d+)\s+deletions?)?/);
        if (match) {
          filesChanged = parseInt(match[1]);
          insertions = match[2] ? parseInt(match[2]) : 0;
          deletions = match[3] ? parseInt(match[3]) : 0;
        }
      }
    }

    return { filesChanged, insertions, deletions };
  }

  private async postProcessChunks(
    chunks: GitAwareCodeChunk[],
    policy: BranchIndexingPolicy
  ): Promise<GitAwareCodeChunk[]> {
    // Deduplication
    const uniqueChunks = this.deduplicateChunks(chunks);
    
    // Apply limits
    if (policy.maxChunksPerCommit) {
      return uniqueChunks.slice(0, policy.maxChunksPerCommit);
    }
    
    return uniqueChunks;
  }

  private deduplicateChunks(chunks: GitAwareCodeChunk[]): GitAwareCodeChunk[] {
    const seen = new Set<string>();
    return chunks.filter(chunk => {
      const key = `${chunk.relativePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content.slice(0, 100)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

/**
 * Full History Strategy - Index all code from all commits
 */
class FullHistoryStrategy implements IndexingStrategy {
  name = 'full-history';
  description = 'Index all code chunks from all commits in the branch';

  async execute(
    commits: GitCommit[],
    policy: BranchIndexingPolicy,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    const chunks: GitAwareCodeChunk[] = [];
    
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      
      context.progressCallback?.({
        stage: 'analyzing',
        currentCommit: i + 1,
        totalCommits: commits.length,
        filesProcessed: 0,
        totalFiles: 0,
        message: `Processing commit ${commit.hash.substring(0, 8)}`
      });

      // Get file tree at this commit
      const fileTree = await this.getCommitFileTree(context.repositoryPath, commit.hash);
      
      for (const filePath of fileTree) {
        if (this.shouldProcessFile(filePath, policy)) {
          const fileContent = await this.getFileAtCommit(
            context.repositoryPath,
            commit.hash,
            filePath
          );
          
          const fileChunks = await this.chunkFileContent(
            fileContent,
            filePath,
            commit,
            context
          );
          
          chunks.push(...fileChunks);
        }
      }
    }

    return chunks;
  }

  private async getCommitFileTree(repositoryPath: string, commitHash: string): Promise<string[]> {
    const command = `git ls-tree -r --name-only ${commitHash}`;
    const output = await this.executeGitCommand(command, repositoryPath);
    return output.split('\n').filter(line => line.trim());
  }

  private async getFileAtCommit(
    repositoryPath: string,
    commitHash: string,
    filePath: string
  ): Promise<string> {
    const command = `git show ${commitHash}:${filePath}`;
    return this.executeGitCommand(command, repositoryPath);
  }

  private shouldProcessFile(filePath: string, policy: BranchIndexingPolicy): boolean {
    // Apply include/exclude patterns
    if (policy.includePatterns) {
      const included = policy.includePatterns.some(pattern => 
        new RegExp(pattern).test(filePath)
      );
      if (!included) return false;
    }

    if (policy.excludePatterns) {
      const excluded = policy.excludePatterns.some(pattern => 
        new RegExp(pattern).test(filePath)
      );
      if (excluded) return false;
    }

    return true;
  }

  private async chunkFileContent(
    content: string,
    filePath: string,
    commit: GitCommit,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    // Basic chunking implementation - can be enhanced
    const lines = content.split('\n');
    const chunks: GitAwareCodeChunk[] = [];
    
    const chunkSize = 50; // lines per chunk
    const overlap = 10; // overlapping lines

    for (let i = 0; i < lines.length; i += chunkSize - overlap) {
      const endLine = Math.min(i + chunkSize, lines.length);
      const chunkContent = lines.slice(i, endLine).join('\n');
      
      chunks.push({
        id: `${context.projectId}:${commit.hash}:${filePath}:${i + 1}-${endLine}`,
        projectId: context.projectId,
        filePath: join(context.repositoryPath, filePath),
        relativePath: filePath,
        content: chunkContent,
        startLine: i + 1,
        endLine,
        language: this.detectLanguage(filePath),
        gitContext: {
          commitHash: commit.hash,
          branchName: context.branchName,
          authorInfo: {
            name: commit.authorName,
            email: commit.authorEmail
          },
          commitDate: commit.date,
          parentCommits: commit.parentHashes,
          diffContext: {
            changeType: 'unchanged',
            linesAdded: 0,
            linesRemoved: 0,
            contextLines: chunkSize
          }
        },
        temporalId: `${context.branchName}:${commit.hash}:${filePath}:${i + 1}-${endLine}`
      });
    }

    return chunks;
  }

  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'go': 'go',
      'rs': 'rust',
      'php': 'php',
      'rb': 'ruby'
    };
    return langMap[ext || ''] || 'text';
  }

  private async executeGitCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn('sh', ['-c', command], { cwd });
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed: ${stderr}`));
        }
      });
    });
  }
}

/**
 * Incremental Diff Strategy - Only index changed code
 */
class IncrementalDiffStrategy implements IndexingStrategy {
  name = 'incremental-diff';
  description = 'Only index code chunks that have been modified in commits';

  async execute(
    commits: GitCommit[],
    policy: BranchIndexingPolicy,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    const chunks: GitAwareCodeChunk[] = [];

    for (const commit of commits) {
      // Get diff for this commit
      const changes = await this.getCommitChanges(context.repositoryPath, commit.hash);
      
      for (const change of changes) {
        if (change.changeType !== 'deleted' && !change.isBinary) {
          const diffChunks = await this.chunkChangedLines(
            context.repositoryPath,
            commit,
            change,
            context
          );
          chunks.push(...diffChunks);
        }
      }
    }

    return chunks;
  }

  private async getCommitChanges(repositoryPath: string, commitHash: string): Promise<GitFileChange[]> {
    const command = `git show --numstat --format="" ${commitHash}`;
    const output = await this.executeGitCommand(command, repositoryPath);
    
    const changes: GitFileChange[] = [];
    const lines = output.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        changes.push({
          filePath: parts[2],
          changeType: 'modified', // Simplified - would need more analysis
          linesAdded: parseInt(parts[0]) || 0,
          linesRemoved: parseInt(parts[1]) || 0,
          isBinary: parts[0] === '-' && parts[1] === '-'
        });
      }
    }

    return changes;
  }

  private async chunkChangedLines(
    repositoryPath: string,
    commit: GitCommit,
    change: GitFileChange,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    // Get the actual diff content
    const diffCommand = `git show ${commit.hash} -- ${change.filePath}`;
    const diffOutput = await this.executeGitCommand(diffCommand, repositoryPath);
    
    // Parse diff and create chunks for changed sections
    const diffHunks = this.parseDiffHunks(diffOutput);
    const chunks: GitAwareCodeChunk[] = [];

    for (const hunk of diffHunks) {
      // Create chunk from the new content
      const addedLines = hunk.lines
        .filter(line => line.type === 'added' || line.type === 'context')
        .map(line => line.content);

      if (addedLines.length > 0) {
        chunks.push({
          id: `${context.projectId}:${commit.hash}:${change.filePath}:${hunk.newStart}-${hunk.newStart + hunk.newLength}`,
          projectId: context.projectId,
          filePath: join(repositoryPath, change.filePath),
          relativePath: change.filePath,
          content: addedLines.join('\n'),
          startLine: hunk.newStart,
          endLine: hunk.newStart + hunk.newLength,
          language: this.detectLanguage(change.filePath),
          gitContext: {
            commitHash: commit.hash,
            branchName: context.branchName,
            authorInfo: {
              name: commit.authorName,
              email: commit.authorEmail
            },
            commitDate: commit.date,
            parentCommits: commit.parentHashes,
            diffContext: {
              changeType: 'modified',
              linesAdded: change.linesAdded,
              linesRemoved: change.linesRemoved,
              contextLines: hunk.lines.filter(l => l.type === 'context').length
            }
          },
          temporalId: `${context.branchName}:${commit.hash}:${change.filePath}:${hunk.newStart}-${hunk.newStart + hunk.newLength}`
        });
      }
    }

    return chunks;
  }

  private parseDiffHunks(diffOutput: string): DiffHunk[] {
    // Simplified diff parsing - would need more robust implementation
    const hunks: DiffHunk[] = [];
    const lines = diffOutput.split('\n');
    let currentHunk: DiffHunk | null = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // New hunk header: @@ -oldStart,oldLength +newStart,newLength @@
        const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1]),
            oldLength: parseInt(match[2]) || 1,
            newStart: parseInt(match[3]),
            newLength: parseInt(match[4]) || 1,
            lines: []
          };
          hunks.push(currentHunk);
        }
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        const type = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
        currentHunk.lines.push({
          type,
          content: line.substring(1),
          lineNumber: currentHunk.lines.length + 1
        });
      }
    }

    return hunks;
  }

  private detectLanguage(filePath: string): string {
    // Same as FullHistoryStrategy
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java'
    };
    return langMap[ext || ''] || 'text';
  }

  private async executeGitCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn('sh', ['-c', command], { cwd });
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed: ${stderr}`));
        }
      });
    });
  }
}

/**
 * Snapshot Strategy - Index only specific commits (e.g., releases, major milestones)
 */
class SnapshotStrategy implements IndexingStrategy {
  name = 'snapshot';
  description = 'Index complete snapshots at specific commits only';

  async execute(
    commits: GitCommit[],
    policy: BranchIndexingPolicy,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    // Select important commits (merge commits, tagged commits, etc.)
    const importantCommits = this.selectImportantCommits(commits, policy);
    
    // Use full history strategy for selected commits
    const fullStrategy = new FullHistoryStrategy();
    return fullStrategy.execute(importantCommits, policy, context);
  }

  private selectImportantCommits(commits: GitCommit[], policy: BranchIndexingPolicy): GitCommit[] {
    if (policy.mergeCommitsOnly) {
      return commits.filter(commit => commit.parentHashes.length > 1);
    }

    // Select every Nth commit for large histories
    const step = Math.max(1, Math.floor(commits.length / 20)); // Max 20 snapshots
    return commits.filter((_, index) => index % step === 0);
  }
}

/**
 * Hotspot Strategy - Focus on frequently changed files
 */
class HotspotStrategy implements IndexingStrategy {
  name = 'hotspot';
  description = 'Focus indexing on frequently modified files and hot code paths';

  async execute(
    commits: GitCommit[],
    policy: BranchIndexingPolicy,
    context: IndexingContext
  ): Promise<GitAwareCodeChunk[]> {
    // Analyze file change frequency
    const fileHotspots = await this.analyzeFileHotspots(context.repositoryPath, commits);
    
    // Focus on top 20% of most changed files
    const hotFiles = fileHotspots
      .sort((a, b) => b.changeCount - a.changeCount)
      .slice(0, Math.ceil(fileHotspots.length * 0.2))
      .map(h => h.filePath);

    // Use incremental diff strategy but only for hot files
    const diffStrategy = new IncrementalDiffStrategy();
    const allChunks = await diffStrategy.execute(commits, policy, context);
    
    return allChunks.filter(chunk => 
      hotFiles.some(hotFile => chunk.relativePath === hotFile)
    );
  }

  private async analyzeFileHotspots(
    repositoryPath: string,
    commits: GitCommit[]
  ): Promise<Array<{ filePath: string; changeCount: number }>> {
    const fileCounts = new Map<string, number>();

    for (const commit of commits) {
      const command = `git show --name-only --format="" ${commit.hash}`;
      const output = await this.executeGitCommand(command, repositoryPath);
      const files = output.split('\n').filter(f => f.trim());

      for (const file of files) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
    }

    return Array.from(fileCounts.entries()).map(([filePath, changeCount]) => ({
      filePath,
      changeCount
    }));
  }

  private async executeGitCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn('sh', ['-c', command], { cwd });
      let stdout = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed`));
        }
      });
    });
  }
}