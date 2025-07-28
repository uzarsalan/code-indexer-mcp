/**
 * Memory Management and Stream Processing System
 * Prevents OOM errors and provides efficient streaming for large codebases
 */

import { EventEmitter } from 'events';
import { Readable, Transform, Writable, pipeline } from 'stream';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { CodeChunk } from '../types.js';
import { StructuredError, ErrorCode } from './error-handling.js';

const pipelineAsync = promisify(pipeline);

// Memory monitoring and limits
export interface MemoryConfig {
  maxHeapUsedMB: number;
  maxHeapTotalMB: number;
  gcThresholdMB: number;
  memoryCheckIntervalMs: number;
  chunkProcessingBatchSize: number;
  streamHighWaterMark: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxHeapUsedMB: 1500,      // 1.5GB heap used limit
  maxHeapTotalMB: 2048,     // 2GB total heap limit
  gcThresholdMB: 512,       // Force GC when heap grows by 512MB
  memoryCheckIntervalMs: 5000, // Check memory every 5 seconds
  chunkProcessingBatchSize: 50, // Process 50 chunks at a time
  streamHighWaterMark: 16   // 16 items in stream buffer
};

export interface MemoryStats {
  heapUsedMB: number;
  heapTotalMB: number;
  heapLimitMB: number;
  externalMB: number;
  rss: number;
  usage: number; // Percentage of limit used
  isHealthy: boolean;
}

export class MemoryMonitor extends EventEmitter {
  private config: MemoryConfig;
  private intervalId?: NodeJS.Timeout;
  private lastGCTime: number = 0;
  private isMonitoring: boolean = false;

  constructor(config: Partial<MemoryConfig> = {}) {
    super();
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  start(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.intervalId = setInterval(() => {
      this.checkMemory();
    }, this.config.memoryCheckIntervalMs);

    console.log('Memory monitoring started', this.config);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isMonitoring = false;
    console.log('Memory monitoring stopped');
  }

  getCurrentStats(): MemoryStats {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const heapLimitMB = Math.round((memUsage as any).heapLimit / 1024 / 1024);
    const externalMB = Math.round(memUsage.external / 1024 / 1024);
    const rss = Math.round(memUsage.rss / 1024 / 1024);

    const usage = (heapUsedMB / this.config.maxHeapUsedMB) * 100;
    const isHealthy = heapUsedMB < this.config.maxHeapUsedMB && 
                     heapTotalMB < this.config.maxHeapTotalMB;

    return {
      heapUsedMB,
      heapTotalMB,
      heapLimitMB,
      externalMB,
      rss,
      usage,
      isHealthy
    };
  }

  private checkMemory(): void {
    const stats = this.getCurrentStats();
    
    // Emit memory stats
    this.emit('memoryStats', stats);

    // Check if we need to trigger GC
    if (stats.heapUsedMB > this.config.gcThresholdMB && 
        Date.now() - this.lastGCTime > 30000) { // Don't GC more than once per 30s
      this.forceGarbageCollection();
    }

    // Check if memory usage is critical
    if (!stats.isHealthy) {
      this.emit('memoryPressure', stats);
      
      if (stats.heapUsedMB > this.config.maxHeapUsedMB * 0.9) {
        this.emit('criticalMemory', stats);
      }
    }

    // Log memory stats periodically
    if (Date.now() % 60000 < this.config.memoryCheckIntervalMs) { // Every minute
      console.log('Memory Stats:', {
        heapUsed: `${stats.heapUsedMB}MB`,
        heapTotal: `${stats.heapTotalMB}MB`,
        usage: `${stats.usage.toFixed(1)}%`,
        healthy: stats.isHealthy
      });
    }
  }

  private forceGarbageCollection(): void {
    if (global.gc) {
      console.log('Forcing garbage collection...');
      global.gc();
      this.lastGCTime = Date.now();
      
      const statsAfterGC = this.getCurrentStats();
      console.log(`GC completed. Heap usage: ${statsAfterGC.heapUsedMB}MB`);
    }
  }

  async waitForMemoryAvailable(requiredMB: number = 100): Promise<void> {
    const maxWaitTime = 30000; // 30 seconds max wait
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const stats = this.getCurrentStats();
      const availableMB = this.config.maxHeapUsedMB - stats.heapUsedMB;
      
      if (availableMB >= requiredMB) {
        return;
      }

      // Force GC if we haven't done it recently
      if (Date.now() - this.lastGCTime > 10000) {
        this.forceGarbageCollection();
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new StructuredError(
      ErrorCode.INTERNAL_ERROR,
      `Memory not available after ${maxWaitTime}ms. Required: ${requiredMB}MB`,
      { operation: 'memory_wait' },
      { retryable: false, severity: 'critical' }
    );
  }
}

// Stream-based file processing
export interface FileProcessingOptions {
  batchSize: number;
  maxConcurrent: number;
  memoryLimitMB: number;
  skipBinaryFiles: boolean;
  maxFileSizeMB: number;
}

export class StreamingFileProcessor extends EventEmitter {
  private memoryMonitor: MemoryMonitor;
  private options: FileProcessingOptions;
  private processingCount: number = 0;

  constructor(
    memoryMonitor: MemoryMonitor,
    options: Partial<FileProcessingOptions> = {}
  ) {
    super();
    this.memoryMonitor = memoryMonitor;
    this.options = {
      batchSize: 10,
      maxConcurrent: 3,
      memoryLimitMB: 200,
      skipBinaryFiles: true,
      maxFileSizeMB: 50,
      ...options
    };
  }

  async *processFilesStream(filePaths: string[]): AsyncGenerator<CodeChunk[], void, unknown> {
    const batches = this.createBatches(filePaths, this.options.batchSize);
    
    for (const batch of batches) {
      // Wait for memory to be available
      await this.memoryMonitor.waitForMemoryAvailable(this.options.memoryLimitMB);
      
      // Process batch with concurrency control
      const results = await this.processBatchWithConcurrency(batch);
      
      if (results.length > 0) {
        yield results;
      }

      // Emit progress
      this.emit('progress', {
        processed: batches.indexOf(batch) + 1,
        total: batches.length,
        currentBatch: batch.length
      });
    }
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private async processBatchWithConcurrency(filePaths: string[]): Promise<CodeChunk[]> {
    const semaphore = new Semaphore(this.options.maxConcurrent);
    const results: CodeChunk[] = [];

    const promises = filePaths.map(async (filePath) => {
      await semaphore.acquire();
      try {
        const chunks = await this.processFile(filePath);
        results.push(...chunks);
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    return results;
  }

  private async processFile(filePath: string): Promise<CodeChunk[]> {
    try {
      // Check file size first
      const stats = await fs.stat(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      if (fileSizeMB > this.options.maxFileSizeMB) {
        console.warn(`Skipping large file: ${filePath} (${fileSizeMB.toFixed(1)}MB)`);
        return [];
      }

      // Skip binary files if configured
      if (this.options.skipBinaryFiles && await this.isBinaryFile(filePath)) {
        return [];
      }

      this.processingCount++;
      this.emit('fileStart', { filePath, size: fileSizeMB });

      // Process file in streaming manner for large files
      if (fileSizeMB > 5) { // Files larger than 5MB
        return await this.processLargeFile(filePath);
      } else {
        return await this.processSmallFile(filePath);
      }
    } catch (error) {
      this.emit('fileError', { filePath, error });
      return [];
    } finally {
      this.processingCount--;
      this.emit('fileEnd', { filePath, activeProcessing: this.processingCount });
    }
  }

  private async processSmallFile(filePath: string): Promise<CodeChunk[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.chunkContent(content, filePath);
  }

  private async processLargeFile(filePath: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    let buffer = '';
    let lineNumber = 1;
    const chunkSize = 1000; // Characters per chunk

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      
      readStream.on('data', (data: string) => {
        buffer += data;
        
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (buffer.length + line.length > chunkSize) {
            // Create chunk from current buffer
            if (buffer.trim()) {
              chunks.push(this.createChunk(buffer, filePath, lineNumber - buffer.split('\n').length + 1, lineNumber - 1));
            }
            buffer = line + '\n';
          } else {
            buffer += line + '\n';
          }
          lineNumber++;
        }
      });

      readStream.on('end', () => {
        // Process remaining buffer
        if (buffer.trim()) {
          chunks.push(this.createChunk(buffer, filePath, lineNumber - buffer.split('\n').length + 1, lineNumber));
        }
        resolve(chunks);
      });

      readStream.on('error', reject);
    });
  }

  private chunkContent(content: string, filePath: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    const chunkSize = 50; // Lines per chunk
    const overlap = 5; // Overlapping lines

    for (let i = 0; i < lines.length; i += chunkSize - overlap) {
      const endLine = Math.min(i + chunkSize, lines.length);
      const chunkContent = lines.slice(i, endLine).join('\n');
      
      chunks.push(this.createChunk(chunkContent, filePath, i + 1, endLine));
    }

    return chunks;
  }

  private createChunk(content: string, filePath: string, startLine: number, endLine: number): CodeChunk {
    return {
      id: `${filePath}:${startLine}-${endLine}`,
      projectId: '', // To be filled by caller
      filePath,
      relativePath: filePath, // To be calculated by caller
      content: content.trim(),
      startLine,
      endLine,
      language: this.detectLanguage(filePath)
    };
  }

  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'jsx': 'javascript',
      'tsx': 'typescript',
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

  private async isBinaryFile(filePath: string): Promise<boolean> {
    try {
      const buffer = await fs.readFile(filePath, { encoding: null });
      const sample = buffer.slice(0, 1024); // Check first 1KB
      
      // Simple binary detection - look for null bytes
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
          return true;
        }
      }
      
      return false;
    } catch {
      return true; // Assume binary if we can't read it
    }
  }
}

// Semaphore for concurrency control
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve();
    } else {
      this.permits++;
    }
  }
}

// Memory-aware batch processor for embeddings
export class MemoryAwareBatchProcessor<T, R> {
  private memoryMonitor: MemoryMonitor;
  private batchSize: number;
  private maxMemoryMB: number;

  constructor(
    memoryMonitor: MemoryMonitor,
    batchSize: number = 100,
    maxMemoryMB: number = 300
  ) {
    this.memoryMonitor = memoryMonitor;
    this.batchSize = batchSize;
    this.maxMemoryMB = maxMemoryMB;
  }

  async *processBatches<T, R>(
    items: T[],
    processor: (batch: T[]) => Promise<R[]>,
    options: {
      progressCallback?: (processed: number, total: number) => void;
      memoryCallback?: (stats: MemoryStats) => void;
    } = {}
  ): AsyncGenerator<R[], void, unknown> {
    let processed = 0;
    
    for (let i = 0; i < items.length; i += this.batchSize) {
      // Wait for memory availability
      await this.memoryMonitor.waitForMemoryAvailable(this.maxMemoryMB);
      
      const batch = items.slice(i, i + this.batchSize);
      
      try {
        const results = await processor(batch);
        processed += batch.length;
        
        // Report progress
        options.progressCallback?.(processed, items.length);
        
        // Report memory stats
        const memStats = this.memoryMonitor.getCurrentStats();
        options.memoryCallback?.(memStats);
        
        yield results;
        
        // Force cleanup after each batch
        batch.length = 0; // Clear batch array
        
        // Suggest GC if memory usage is high
        if (memStats.usage > 70) {
          if (global.gc) {
            global.gc();
          }
        }
        
      } catch (error) {
        console.error(`Batch processing error for items ${i}-${i + batch.length}:`, error);
        throw error;
      }
    }
  }
}

// Streaming chunk pipeline
export class ChunkProcessingPipeline {
  private memoryMonitor: MemoryMonitor;

  constructor(memoryMonitor: MemoryMonitor) {
    this.memoryMonitor = memoryMonitor;
  }

  async processChunksStream(
    chunkSource: AsyncIterable<CodeChunk[]>,
    processors: Array<(chunks: CodeChunk[]) => Promise<CodeChunk[]>>
  ): Promise<void> {
    const readable = Readable.from(chunkSource);
    
    // Chain processors as transforms
    const transforms = processors.map((processor, index) => 
      new Transform({
        objectMode: true,
        async transform(chunks: CodeChunk[], encoding, callback) {
          try {
            // Wait for memory before processing
            await this.memoryMonitor.waitForMemoryAvailable(100);
            
            const processed = await processor(chunks);
            callback(null, processed);
          } catch (error) {
            callback(error);
          }
        }
      })
    );

    // Final sink
    const writable = new Writable({
      objectMode: true,
      write(chunks: CodeChunk[], encoding, callback) {
        console.log(`Processed batch of ${chunks.length} chunks`);
        callback();
      }
    });

    // Build pipeline
    const pipelineElements = [readable, ...transforms, writable];
    
    try {
      await pipelineAsync(...pipelineElements);
      console.log('Chunk processing pipeline completed');
    } catch (error) {
      console.error('Pipeline error:', error);
      throw error;
    }
  }
}

// Export singleton memory monitor
export const memoryMonitor = new MemoryMonitor();

// Auto-start memory monitoring in production
if (process.env.NODE_ENV === 'production') {
  memoryMonitor.start();
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    memoryMonitor.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    memoryMonitor.stop();
    process.exit(0);
  });
}