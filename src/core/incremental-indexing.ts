/**
 * Incremental Indexing System
 * Efficiently updates index by tracking changes and processing only modified content
 */

import { promises as fs } from 'fs';
import { join, relative } from 'path';
import crypto from 'crypto';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { CodeChunk, Project } from '../types';
import { StructuredLogger, logger } from './observability';
import { StructuredError, ErrorCode, wrapAsyncOperation } from './error-handling';
import { memoryMonitor, StreamingFileProcessor } from './memory-management';

// =============================================================================
// FILE CHANGE TRACKING
// =============================================================================

export interface FileHash {
  filePath: string;
  relativePath: string;
  hash: string;
  size: number;
  lastModified: Date;
  indexed: boolean;
  chunkCount: number;
}

export interface ChangeDetectionResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  totalFiles: number;
}

export interface IndexingSession {
  id: string;
  projectId: string;
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed';
  stats: {
    filesProcessed: number;
    chunksCreated: number;
    chunksUpdated: number;
    chunksDeleted: number;
    errors: number;
  };
  changeDetection: ChangeDetectionResult;
}

export class FileHashTracker {
  private hashes: Map<string, FileHash> = new Map();
  private projectPath: string;
  private logger: StructuredLogger;

  constructor(projectPath: string, logger: StructuredLogger) {
    this.projectPath = projectPath;
    this.logger = logger.child({ component: 'FileHashTracker', projectPath });
  }

  async loadExistingHashes(projectId: string): Promise<void> {
    const result = await wrapAsyncOperation(
      async () => {
        // In a real implementation, this would load from database
        // For now, we'll scan the file system and build hashes
        return this.buildHashMap();
      },
      { operation: 'load_file_hashes', resource: projectId }
    );

    if (result.isFailure) {
      throw result.error;
    }

    this.logger.info(`Loaded ${this.hashes.size} file hashes`, { projectId });
  }

  async detectChanges(includePatterns: string[] = ['**/*']): Promise<ChangeDetectionResult> {
    const result = await wrapAsyncOperation(
      async () => {
        const processor = new StreamingFileProcessor(memoryMonitor);
        const currentFiles = new Set<string>();
        const currentHashes = new Map<string, string>();

        // Get all files and their current hashes
        const filePaths = await this.getAllFiles(includePatterns);
        
        for (const filePath of filePaths) {
          try {
            const stats = await fs.stat(filePath);
            const relativePath = relative(this.projectPath, filePath);
            currentFiles.add(relativePath);

            // Calculate hash for changed files only
            const existingHash = this.hashes.get(relativePath);
            if (!existingHash || existingHash.lastModified < stats.mtime) {
              const content = await fs.readFile(filePath, 'utf-8');
              const hash = this.calculateHash(content);
              currentHashes.set(relativePath, hash);
            } else {
              currentHashes.set(relativePath, existingHash.hash);
            }
          } catch (error) {
            this.logger.warn(`Failed to process file: ${filePath}`, { error });
          }
        }

        return this.categorizeChanges(currentFiles, currentHashes);
      },
      { operation: 'detect_changes' }
    );

    if (result.isFailure) {
      throw result.error;
    }

    return result.value;
  }

  private async buildHashMap(): Promise<void> {
    const filePaths = await this.getAllFiles();
    
    for (const filePath of filePaths) {
      try {
        const stats = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const hash = this.calculateHash(content);
        const relativePath = relative(this.projectPath, filePath);

        this.hashes.set(relativePath, {
          filePath,
          relativePath,
          hash,
          size: stats.size,
          lastModified: stats.mtime,
          indexed: false,
          chunkCount: 0
        });
      } catch (error) {
        this.logger.warn(`Failed to hash file: ${filePath}`, { error });
      }
    }
  }

  private categorizeChanges(
    currentFiles: Set<string>,
    currentHashes: Map<string, string>
  ): ChangeDetectionResult {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    // Check for added and modified files
    for (const [relativePath, currentHash] of currentHashes) {
      const existingHash = this.hashes.get(relativePath);
      
      if (!existingHash) {
        added.push(relativePath);
      } else if (existingHash.hash !== currentHash) {
        modified.push(relativePath);
      } else {
        unchanged.push(relativePath);
      }
    }

    // Check for deleted files
    for (const [relativePath] of this.hashes) {
      if (!currentFiles.has(relativePath)) {
        deleted.push(relativePath);
      }
    }

    return {
      added,
      modified,
      deleted,
      unchanged,
      totalFiles: currentFiles.size
    };
  }

  async updateHash(relativePath: string, content: string, chunkCount: number): Promise<void> {
    const hash = this.calculateHash(content);
    const filePath = join(this.projectPath, relativePath);
    
    try {
      const stats = await fs.stat(filePath);
      
      this.hashes.set(relativePath, {
        filePath,
        relativePath,
        hash,
        size: stats.size,
        lastModified: stats.mtime,
        indexed: true,
        chunkCount
      });
    } catch (error) {
      this.logger.warn(`Failed to update hash for ${relativePath}`, { error });
    }
  }

  removeHash(relativePath: string): void {
    this.hashes.delete(relativePath);
  }

  getHash(relativePath: string): FileHash | undefined {
    return this.hashes.get(relativePath);
  }

  private calculateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private async getAllFiles(patterns: string[] = ['**/*']): Promise<string[]> {
    const glob = await import('glob');
    const files: string[] = [];
    
    for (const pattern of patterns) {
      const matches = await glob.glob(pattern, {
        cwd: this.projectPath,
        absolute: true,
        nodir: true,
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/*.log'
        ]
      });
      files.push(...matches);
    }

    return [...new Set(files)]; // Deduplicate
  }
}

// =============================================================================
// INCREMENTAL INDEXER
// =============================================================================

export interface IncrementalIndexingOptions {
  enableRealTimeWatch: boolean;
  watchDebounceMs: number;
  batchSize: number;
  maxConcurrentFiles: number;
  includePatterns: string[];
  excludePatterns: string[];
  autoCommitChanges: boolean;
}

export const DEFAULT_INCREMENTAL_OPTIONS: IncrementalIndexingOptions = {
  enableRealTimeWatch: true,
  watchDebounceMs: 1000,
  batchSize: 10,
  maxConcurrentFiles: 3,
  includePatterns: ['**/*.{js,ts,jsx,tsx,py,java,cpp,c,go,rs,php,rb}'],
  excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
  autoCommitChanges: true
};

export class IncrementalIndexer extends EventEmitter {
  private hashTracker: FileHashTracker;
  private watcher?: FSWatcher;
  private options: IncrementalIndexingOptions;
  private logger: StructuredLogger;
  private projectId: string;
  private projectPath: string;
  private isIndexing: boolean = false;
  private currentSession?: IndexingSession;
  private changeTimer?: NodeJS.Timeout;
  private cleanupHandlers: Array<() => void> = [];

  constructor(
    projectId: string,
    projectPath: string,
    options: Partial<IncrementalIndexingOptions> = {}
  ) {
    super();
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.options = { ...DEFAULT_INCREMENTAL_OPTIONS, ...options };
    this.logger = logger.child({ 
      component: 'IncrementalIndexer', 
      projectId, 
      projectPath 
    });
    this.hashTracker = new FileHashTracker(projectPath, this.logger);
  }

  async initialize(): Promise<void> {
    const result = await wrapAsyncOperation(
      async () => {
        await this.hashTracker.loadExistingHashes(this.projectId);
        
        if (this.options.enableRealTimeWatch) {
          await this.startWatching();
        }
      },
      { operation: 'initialize_incremental_indexer', resource: this.projectId }
    );

    if (result.isFailure) {
      throw result.error;
    }

    this.logger.info('Incremental indexer initialized', { 
      realTimeWatch: this.options.enableRealTimeWatch 
    });
  }

  async performIncrementalIndex(): Promise<IndexingSession> {
    if (this.isIndexing) {
      throw new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        'Indexing already in progress',
        { operation: 'incremental_index', projectId: this.projectId },
        { retryable: false }
      );
    }

    this.isIndexing = true;
    const session = this.createSession();
    this.currentSession = session;

    try {
      this.logger.info('Starting incremental indexing', { sessionId: session.id });
      this.emit('indexingStarted', session);

      // Detect changes
      const changes = await this.hashTracker.detectChanges(this.options.includePatterns);
      session.changeDetection = changes;

      this.logger.info('Change detection completed', {
        sessionId: session.id,
        added: changes.added.length,
        modified: changes.modified.length,
        deleted: changes.deleted.length,
        unchanged: changes.unchanged.length
      });

      this.emit('changesDetected', { session, changes });

      // Process changes
      await this.processChanges(session, changes);

      // Complete session
      session.status = 'completed';
      session.endTime = new Date();

      this.logger.info('Incremental indexing completed', {
        sessionId: session.id,
        duration: session.endTime.getTime() - session.startTime.getTime(),
        stats: session.stats
      });

      this.emit('indexingCompleted', session);
      return session;

    } catch (error) {
      session.status = 'failed';
      session.endTime = new Date();
      session.stats.errors++;

      this.logger.error('Incremental indexing failed', {
        sessionId: session.id,
        error: error.message
      }, error as Error);

      this.emit('indexingFailed', { session, error });
      throw error;

    } finally {
      this.isIndexing = false;
      this.currentSession = undefined;
    }
  }

  private async processChanges(session: IndexingSession, changes: ChangeDetectionResult): Promise<void> {
    // Process deleted files first
    await this.processDeletedFiles(session, changes.deleted);

    // Process added and modified files
    const filesToProcess = [...changes.added, ...changes.modified];
    await this.processModifiedFiles(session, filesToProcess);
  }

  private async processDeletedFiles(session: IndexingSession, deletedFiles: string[]): Promise<void> {
    for (const relativePath of deletedFiles) {
      try {
        // Remove chunks from database
        await this.deleteChunksForFile(relativePath);
        
        // Remove from hash tracker
        this.hashTracker.removeHash(relativePath);
        
        session.stats.chunksDeleted++;
        this.emit('fileDeleted', { sessionId: session.id, filePath: relativePath });
        
      } catch (error) {
        session.stats.errors++;
        this.logger.error(`Failed to process deleted file: ${relativePath}`, {
          sessionId: session.id,
          error: error.message
        }, error as Error);
      }
    }
  }

  private async processModifiedFiles(session: IndexingSession, filePaths: string[]): Promise<void> {
    const processor = new StreamingFileProcessor(memoryMonitor, {
      batchSize: this.options.batchSize,
      maxConcurrent: this.options.maxConcurrentFiles,
      memoryLimitMB: 200,
      skipBinaryFiles: true,
      maxFileSizeMB: 50
    });

    processor.on('fileStart', ({ filePath }) => {
      this.emit('fileProcessingStarted', { sessionId: session.id, filePath });
    });

    processor.on('fileEnd', ({ filePath }) => {
      session.stats.filesProcessed++;
      this.emit('fileProcessingCompleted', { sessionId: session.id, filePath });
    });

    processor.on('fileError', ({ filePath, error }) => {
      session.stats.errors++;
      this.logger.error(`File processing error: ${filePath}`, {
        sessionId: session.id,
        error: error.message
      }, error);
    });

    // Process files in batches
    const fullPaths = filePaths.map(rp => join(this.projectPath, rp));
    
    for await (const chunks of processor.processFilesStream(fullPaths)) {
      // Update chunks in database
      await this.updateChunksInDatabase(chunks);
      
      // Update hash tracker
      for (const chunk of chunks) {
        const relativePath = relative(this.projectPath, chunk.filePath);
        const fileChunks = chunks.filter(c => c.relativePath === relativePath);
        
        if (fileChunks.length > 0) {
          await this.hashTracker.updateHash(
            relativePath,
            fileChunks.map(c => c.content).join('\n'),
            fileChunks.length
          );
        }
      }
      
      session.stats.chunksCreated += chunks.filter(c => this.isNewChunk(c)).length;
      session.stats.chunksUpdated += chunks.filter(c => !this.isNewChunk(c)).length;
      
      this.emit('batchProcessed', {
        sessionId: session.id,
        chunksInBatch: chunks.length,
        totalProcessed: session.stats.chunksCreated + session.stats.chunksUpdated
      });
    }
  }

  private async startWatching(): Promise<void> {
    if (this.watcher) {
      await this.stopWatching();
    }

    try {
      this.watcher = watch(this.projectPath, {
        ignored: this.options.excludePatterns,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.options.watchDebounceMs,
          pollInterval: 100
        }
      });

      const pendingChanges = new Set<string>();

      const handleFileChange = (path: string) => {
        try {
          const relativePath = relative(this.projectPath, path);
          pendingChanges.add(relativePath);

          // Debounce changes
          if (this.changeTimer) {
            clearTimeout(this.changeTimer);
          }

          this.changeTimer = setTimeout(async () => {
            if (pendingChanges.size > 0 && !this.isIndexing) {
              this.logger.info(`File changes detected: ${pendingChanges.size} files`);
              this.emit('changesDetected', { 
                files: Array.from(pendingChanges),
                auto: true 
              });

              // Auto-trigger indexing if enabled
              if (this.options.autoCommitChanges) {
                try {
                  await this.performIncrementalIndex();
                } catch (error) {
                  this.logger.error('Auto-indexing failed', { error });
                }
              }
            }
            pendingChanges.clear();
            this.changeTimer = undefined;
          }, this.options.watchDebounceMs);
        } catch (error) {
          this.logger.error('Error handling file change', { path, error });
        }
      };

      const errorHandler = (error: Error) => {
        this.logger.error('File watcher error', { error: error.message }, error);
        this.emit('watchError', error);
        
        // Attempt to restart watcher after a delay
        setTimeout(() => {
          if (!this.watcher || this.watcher.closed) {
            this.logger.info('Attempting to restart file watcher');
            this.startWatching().catch(restartError => {
              this.logger.error('Failed to restart file watcher', { error: restartError });
            });
          }
        }, 5000);
      };

      // Set up event handlers with proper cleanup tracking
      this.watcher
        .on('add', handleFileChange)
        .on('change', handleFileChange)
        .on('unlink', handleFileChange)
        .on('error', errorHandler);

      // Track cleanup handlers
      this.cleanupHandlers.push(() => {
        if (this.changeTimer) {
          clearTimeout(this.changeTimer);
          this.changeTimer = undefined;
        }
        pendingChanges.clear();
      });

      this.logger.info('File watching started', {
        patterns: this.options.includePatterns,
        ignored: this.options.excludePatterns
      });
    } catch (error) {
      this.logger.error('Failed to start file watching', { error });
      throw error;
    }
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      try {
        // Clean up timers first
        if (this.changeTimer) {
          clearTimeout(this.changeTimer);
          this.changeTimer = undefined;
        }

        // Run all cleanup handlers
        for (const cleanup of this.cleanupHandlers) {
          try {
            cleanup();
          } catch (error) {
            this.logger.warn('Error during cleanup', { error });
          }
        }
        this.cleanupHandlers = [];

        // Remove all listeners before closing
        this.watcher.removeAllListeners();
        
        // Close the watcher with timeout
        const closePromise = this.watcher.close();
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Watcher close timeout')), 5000);
        });

        await Promise.race([closePromise, timeoutPromise]);
        this.watcher = undefined;
        
        this.logger.info('File watching stopped');
      } catch (error) {
        this.logger.error('Error stopping file watcher', { error });
        this.watcher = undefined; // Force cleanup even on error
      }
    }
  }

  async shutdown(): Promise<void> {
    try {
      // Stop watching first
      await this.stopWatching();
      
      // Clean up any remaining timers
      if (this.changeTimer) {
        clearTimeout(this.changeTimer);
        this.changeTimer = undefined;
      }
      
      // Run any remaining cleanup handlers
      for (const cleanup of this.cleanupHandlers) {
        try {
          cleanup();
        } catch (error) {
          this.logger.warn('Error during shutdown cleanup', { error });
        }
      }
      this.cleanupHandlers = [];
      
      // Remove all event listeners
      this.removeAllListeners();
      
      this.logger.info('Incremental indexer shutdown');
    } catch (error) {
      this.logger.error('Error during shutdown', { error });
      throw error;
    }
  }

  getCurrentSession(): IndexingSession | undefined {
    return this.currentSession;
  }

  isCurrentlyIndexing(): boolean {
    return this.isIndexing;
  }

  private createSession(): IndexingSession {
    return {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      projectId: this.projectId,
      startTime: new Date(),
      status: 'running',
      stats: {
        filesProcessed: 0,
        chunksCreated: 0,
        chunksUpdated: 0,
        chunksDeleted: 0,
        errors: 0
      },
      changeDetection: {
        added: [],
        modified: [],
        deleted: [],
        unchanged: [],
        totalFiles: 0
      }
    };
  }

  private async deleteChunksForFile(relativePath: string): Promise<void> {
    // In a real implementation, this would delete from vector database
    // For now, we'll just log the operation
    this.logger.debug('Deleting chunks for file', { relativePath });
  }

  private async updateChunksInDatabase(chunks: CodeChunk[]): Promise<void> {
    // In a real implementation, this would update the vector database
    // For now, we'll just log the operation
    this.logger.debug('Updating chunks in database', { count: chunks.length });
  }

  private isNewChunk(chunk: CodeChunk): boolean {
    // In a real implementation, this would check if chunk exists in database
    // For now, assume all chunks are new
    return true;
  }
}

// =============================================================================
// INCREMENTAL INDEXING MANAGER
// =============================================================================

export class IncrementalIndexingManager {
  private indexers: Map<string, IncrementalIndexer> = new Map();
  private logger: StructuredLogger;

  constructor() {
    this.logger = logger.child({ component: 'IncrementalIndexingManager' });
  }

  async createIndexer(
    projectId: string,
    projectPath: string,
    options?: Partial<IncrementalIndexingOptions>
  ): Promise<IncrementalIndexer> {
    if (this.indexers.has(projectId)) {
      throw new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        `Indexer already exists for project: ${projectId}`,
        { operation: 'create_indexer', projectId },
        { retryable: false }
      );
    }

    const indexer = new IncrementalIndexer(projectId, projectPath, options);
    await indexer.initialize();

    this.indexers.set(projectId, indexer);
    
    this.logger.info('Created incremental indexer', { projectId, projectPath });
    return indexer;
  }

  getIndexer(projectId: string): IncrementalIndexer | undefined {
    return this.indexers.get(projectId);
  }

  async removeIndexer(projectId: string): Promise<void> {
    const indexer = this.indexers.get(projectId);
    if (indexer) {
      await indexer.shutdown();
      this.indexers.delete(projectId);
      this.logger.info('Removed incremental indexer', { projectId });
    }
  }

  async triggerIndexing(projectId: string): Promise<IndexingSession> {
    const indexer = this.indexers.get(projectId);
    if (!indexer) {
      throw new StructuredError(
        ErrorCode.RESOURCE_NOT_FOUND,
        `No indexer found for project: ${projectId}`,
        { operation: 'trigger_indexing', projectId },
        { retryable: false }
      );
    }

    return indexer.performIncrementalIndex();
  }

  async shutdownAll(): Promise<void> {
    const shutdownPromises = Array.from(this.indexers.values()).map(indexer => 
      indexer.shutdown()
    );

    await Promise.all(shutdownPromises);
    this.indexers.clear();
    
    this.logger.info('All incremental indexers shutdown');
  }

  getStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [projectId, indexer] of this.indexers) {
      const session = indexer.getCurrentSession();
      stats[projectId] = {
        isIndexing: indexer.isCurrentlyIndexing(),
        currentSession: session ? {
          id: session.id,
          status: session.status,
          startTime: session.startTime,
          stats: session.stats
        } : null
      };
    }
    
    return stats;
  }
}

// Export singleton instance
export const incrementalIndexingManager = new IncrementalIndexingManager();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await incrementalIndexingManager.shutdownAll();
});

process.on('SIGINT', async () => {
  await incrementalIndexingManager.shutdownAll();
});