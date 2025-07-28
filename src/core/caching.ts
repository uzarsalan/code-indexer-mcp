/**
 * Redis-based Caching Layer
 * Provides efficient caching for embeddings, search results, and frequently accessed data
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { StructuredLogger, logger } from './observability.js';
import { StructuredError, ErrorCode, wrapAsyncOperation } from './error-handling.js';
import { CodeChunk, SearchResult } from '../types.js';

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================

export interface CacheConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    keyPrefix: string;
    retryDelayOnFailover: number;
    maxRetriesPerRequest: number;
    lazyConnect: boolean;
  };
  ttl: {
    embeddings: number;      // 24 hours
    searchResults: number;   // 1 hour  
    projectData: number;     // 6 hours
    fileHashes: number;      // 12 hours
    gitData: number;         // 2 hours
  };
  compression: {
    enabled: boolean;
    threshold: number; // Compress if data > threshold bytes
  };
  performance: {
    maxMemoryMB: number;
    evictionPolicy: string;
    pipeline: {
      enabled: boolean;
      batchSize: number;
      flushInterval: number;
    };
  };
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
    keyPrefix: 'code-indexer:',
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true
  },
  ttl: {
    embeddings: 24 * 60 * 60,      // 24 hours
    searchResults: 60 * 60,        // 1 hour
    projectData: 6 * 60 * 60,      // 6 hours
    fileHashes: 12 * 60 * 60,      // 12 hours
    gitData: 2 * 60 * 60           // 2 hours
  },
  compression: {
    enabled: true,
    threshold: 1024 // 1KB
  },
  performance: {
    maxMemoryMB: 512,
    evictionPolicy: 'allkeys-lru',
    pipeline: {
      enabled: true,
      batchSize: 100,
      flushInterval: 10 // ms
    }
  }
};

// =============================================================================
// CACHE MANAGER
// =============================================================================

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  memoryUsage: number;
  connectedClients: number;
  operations: {
    get: number;
    set: number;
    del: number;
    expire: number;
  };
}

export class CacheManager extends EventEmitter {
  private redis: Redis;
  private config: CacheConfig;
  private logger: StructuredLogger;
  private stats: CacheStats;
  private compressionEnabled: boolean;
  private pipeline?: any;
  private pipelineTimer?: NodeJS.Timeout;

  constructor(config: Partial<CacheConfig> = {}) {
    super();
    this.config = this.mergeConfig(config);
    this.logger = logger.child({ operation: 'cache', metadata: { component: 'CacheManager' } });
    this.compressionEnabled = this.config.compression.enabled;
    this.stats = this.initializeStats();
    
    this.redis = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      db: this.config.redis.db,
      keyPrefix: this.config.redis.keyPrefix,
      retryDelayOnFailover: this.config.redis.retryDelayOnFailover,
      maxRetriesPerRequest: this.config.redis.maxRetriesPerRequest,
      lazyConnect: this.config.redis.lazyConnect
    } as any);

    this.setupEventHandlers();
  }

  private mergeConfig(userConfig: Partial<CacheConfig>): CacheConfig {
    return {
      redis: { ...DEFAULT_CACHE_CONFIG.redis, ...userConfig.redis },
      ttl: { ...DEFAULT_CACHE_CONFIG.ttl, ...userConfig.ttl },
      compression: { ...DEFAULT_CACHE_CONFIG.compression, ...userConfig.compression },
      performance: { ...DEFAULT_CACHE_CONFIG.performance, ...userConfig.performance }
    };
  }

  private initializeStats(): CacheStats {
    return {
      hits: 0,
      misses: 0,
      hitRate: 0,
      memoryUsage: 0,
      connectedClients: 0,
      operations: {
        get: 0,
        set: 0,
        del: 0,
        expire: 0
      }
    };
  }

  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      this.logger.info('Redis connected', {
        operation: 'redis_connect',
        metadata: {
          host: this.config.redis.host,
          port: this.config.redis.port,
          db: this.config.redis.db
        }
      });
      this.emit('connected');
    });

    this.redis.on('error', (error) => {
      this.logger.error('Redis error', { operation: 'redis_error', metadata: { error: error.message } }, error);
      this.emit('error', error);
    });

    this.redis.on('close', () => {
      this.logger.warn('Redis connection closed');
      this.emit('disconnected');
    });

    this.redis.on('reconnecting', () => {
      this.logger.info('Redis reconnecting');
      this.emit('reconnecting');
    });
  }

  async connect(): Promise<void> {
    const result = await wrapAsyncOperation(
      async () => {
        await this.redis.connect();
        await this.configureRedis();
      },
      { operation: 'redis_connect' }
    );

    if (result.isFailure) {
      throw result.error;
    }

    this.logger.info('Cache manager initialized');
  }

  private async configureRedis(): Promise<void> {
    // Set memory policy
    await this.redis.config('SET', 'maxmemory-policy', this.config.performance.evictionPolicy);
    
    // Set max memory (convert MB to bytes)
    const maxMemoryBytes = this.config.performance.maxMemoryMB * 1024 * 1024;
    await this.redis.config('SET', 'maxmemory', maxMemoryBytes.toString());
  }

  // =============================================================================
  // CORE CACHE OPERATIONS
  // =============================================================================

  async get<T>(key: string, type?: 'json' | 'string' | 'buffer'): Promise<T | null> {
    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.get++;
        
        const value = await this.redis.get(key);
        
        if (value === null) {
          this.stats.misses++;
          return null;
        }

        this.stats.hits++;
        return await this.deserializeValue<T>(value, type);
      },
      { operation: 'cache_get', resource: key }
    );

    if (result.isFailure) {
      this.logger.warn('Cache get failed', { operation: 'cache_get', metadata: { key, error: result.error.message } });
      return null; // Graceful degradation
    }

    this.updateHitRate();
    return result.value;
  }

  async set(
    key: string, 
    value: any, 
    ttlSeconds?: number,
    options: { nx?: boolean; xx?: boolean } = {}
  ): Promise<boolean> {
    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.set++;
        
        const serializedValue = await this.serializeValue(value);
        const args: any[] = [key, serializedValue];
        
        if (ttlSeconds) {
          args.push('EX', ttlSeconds);
        }
        
        if (options.nx) {
          args.push('NX');
        } else if (options.xx) {
          args.push('XX');
        }

        const response = await this.redis.set(...(args as [string, any, ...any[]]));
        return response === 'OK';
      },
      { operation: 'cache_set', resource: key }
    );

    if (result.isFailure) {
      this.logger.warn('Cache set failed', { operation: 'cache_set', metadata: { key, error: result.error.message } });
      return false;
    }

    return result.value;
  }

  async del(key: string): Promise<boolean> {
    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.del++;
        const deleted = await this.redis.del(key);
        return deleted > 0;
      },
      { operation: 'cache_del', resource: key }
    );

    if (result.isFailure) {
      this.logger.warn('Cache delete failed', { operation: 'cache_del', metadata: { key, error: result.error.message } });
      return false;
    }

    return result.value;
  }

  async exists(key: string): Promise<boolean> {
    const result = await wrapAsyncOperation(
      async () => {
        const exists = await this.redis.exists(key);
        return exists > 0;
      },
      { operation: 'cache_exists', resource: key }
    );

    if (result.isFailure) {
      return false;
    }

    return result.value;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.expire++;
        const success = await this.redis.expire(key, ttlSeconds);
        return success === 1;
      },
      { operation: 'cache_expire', resource: key }
    );

    if (result.isFailure) {
      return false;
    }

    return result.value;
  }

  // =============================================================================
  // SPECIALIZED CACHE METHODS
  // =============================================================================

  // Embedding cache
  async cacheEmbedding(contentHash: string, embedding: number[]): Promise<void> {
    const key = `embedding:${contentHash}`;
    await this.set(key, embedding, this.config.ttl.embeddings);
  }

  async getEmbedding(contentHash: string): Promise<number[] | null> {
    const key = `embedding:${contentHash}`;
    return this.get<number[]>(key, 'json');
  }

  // Search results cache
  async cacheSearchResults(queryHash: string, results: SearchResult[]): Promise<void> {
    const key = `search:${queryHash}`;
    await this.set(key, results, this.config.ttl.searchResults);
  }

  async getSearchResults(queryHash: string): Promise<SearchResult[] | null> {
    const key = `search:${queryHash}`;
    return this.get<SearchResult[]>(key, 'json');
  }

  // Project data cache
  async cacheProjectData(projectId: string, data: any): Promise<void> {
    const key = `project:${projectId}`;
    await this.set(key, data, this.config.ttl.projectData);
  }

  async getProjectData(projectId: string): Promise<any | null> {
    const key = `project:${projectId}`;
    return this.get(key, 'json');
  }

  // File hash cache
  async cacheFileHash(filePath: string, hash: string, metadata?: any): Promise<void> {
    const key = `hash:${filePath}`;
    const data = { hash, metadata, timestamp: Date.now() };
    await this.set(key, data, this.config.ttl.fileHashes);
  }

  async getFileHash(filePath: string): Promise<{ hash: string; metadata?: any; timestamp: number } | null> {
    const key = `hash:${filePath}`;
    return this.get(key, 'json');
  }

  // Git data cache
  async cacheGitData(repoId: string, type: string, data: any): Promise<void> {
    const key = `git:${repoId}:${type}`;
    await this.set(key, data, this.config.ttl.gitData);
  }

  async getGitData(repoId: string, type: string): Promise<any | null> {
    const key = `git:${repoId}:${type}`;
    return this.get(key, 'json');
  }

  // =============================================================================
  // BATCH OPERATIONS
  // =============================================================================

  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (keys.length === 0) return [];

    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.get += keys.length;
        const values = await this.redis.mget(...keys);
        
        const results: (T | null)[] = [];
        for (const value of values) {
          if (value === null) {
            this.stats.misses++;
            results.push(null);
          } else {
            this.stats.hits++;
            results.push(await this.deserializeValue<T>(value, 'json'));
          }
        }
        return results;
      },
      { operation: 'cache_mget', resource: `keys:${keys.length}` }
    );

    if (result.isFailure) {
      this.logger.warn('Cache mget failed', { 
        operation: 'cache_mget',
        metadata: {
          keyCount: keys.length, 
          error: result.error.message
        }
      });
      return keys.map(() => null);
    }

    this.updateHitRate();
    return result.value;
  }

  async mset(pairs: Array<[string, any]>, ttlSeconds?: number): Promise<boolean> {
    if (pairs.length === 0) return true;

    const result = await wrapAsyncOperation(
      async () => {
        this.stats.operations.set += pairs.length;
        
        if (this.config.performance.pipeline.enabled) {
          return this.msetWithPipeline(pairs, ttlSeconds);
        } else {
          return this.msetSequential(pairs, ttlSeconds);
        }
      },
      { operation: 'cache_mset', resource: `pairs:${pairs.length}` }
    );

    if (result.isFailure) {
      this.logger.warn('Cache mset failed', { 
        operation: 'cache_mset',
        metadata: {
          pairCount: pairs.length, 
          error: result.error.message
        } 
      });
      return false;
    }

    return result.value;
  }

  private async msetWithPipeline(pairs: Array<[string, any]>, ttlSeconds?: number): Promise<boolean> {
    const pipeline = this.redis.pipeline();
    
    for (const [key, value] of pairs) {
      const serializedValue = await this.serializeValue(value);
      
      if (ttlSeconds) {
        pipeline.setex(key, ttlSeconds, serializedValue);
      } else {
        pipeline.set(key, serializedValue);
      }
    }

    const results = await pipeline.exec();
    return results ? results.every(([err, result]) => !err && result === 'OK') : false;
  }

  private async msetSequential(pairs: Array<[string, any]>, ttlSeconds?: number): Promise<boolean> {
    const promises = pairs.map(([key, value]) => this.set(key, value, ttlSeconds));
    const results = await Promise.all(promises);
    return results.every(result => result);
  }

  // =============================================================================
  // PATTERN OPERATIONS
  // =============================================================================

  async deletePattern(pattern: string): Promise<number> {
    const result = await wrapAsyncOperation(
      async () => {
        const keys = await this.redis.keys(pattern);
        if (keys.length === 0) return 0;
        
        const deleted = await this.redis.del(...keys);
        return deleted;
      },
      { operation: 'cache_delete_pattern', resource: pattern }
    );

    if (result.isFailure) {
      this.logger.warn('Pattern deletion failed', { operation: 'cache_delete_pattern', metadata: { pattern, error: result.error.message } });
      return 0;
    }

    return result.value;
  }

  async getKeysByPattern(pattern: string, limit: number = 1000): Promise<string[]> {
    const result = await wrapAsyncOperation(
      async () => {
        // Use SCAN for better performance with large datasets
        const keys: string[] = [];
        let cursor = '0';
        
        do {
          const [nextCursor, foundKeys] = await this.redis.scan(
            cursor, 
            'MATCH', 
            pattern, 
            'COUNT', 
            Math.min(limit, 100)
          );
          
          keys.push(...foundKeys);
          cursor = nextCursor;
        } while (cursor !== '0' && keys.length < limit);

        return keys.slice(0, limit);
      },
      { operation: 'cache_scan_pattern', resource: pattern }
    );

    if (result.isFailure) {
      this.logger.warn('Pattern scan failed', { operation: 'cache_scan_pattern', metadata: { pattern, error: result.error.message } });
      return [];
    }

    return result.value;
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  private async serializeValue(value: any): Promise<string> {
    try {
      const jsonString = JSON.stringify(value);
      
      if (this.compressionEnabled && jsonString.length > this.config.compression.threshold) {
        const zlib = await import('zlib');
        const { promisify } = await import('util');
        const gzipAsync = promisify(zlib.gzip);
        
        const compressed = await gzipAsync(Buffer.from(jsonString));
        return `gzip:${compressed.toString('base64')}`;
      }
      
      return `json:${jsonString}`;
    } catch (error) {
      throw new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        'Failed to serialize cache value',
        { operation: 'serialize_cache_value' },
        { cause: error as Error }
      );
    }
  }

  private async deserializeValue<T>(value: string, type?: 'json' | 'string' | 'buffer'): Promise<T> {
    try {
      if (value.startsWith('gzip:')) {
        const zlib = await import('zlib');
        const { promisify } = await import('util');
        const gunzipAsync = promisify(zlib.gunzip);
        
        const compressed = Buffer.from(value.slice(5), 'base64');
        const decompressed = await gunzipAsync(compressed);
        return JSON.parse(decompressed.toString());
      }
      
      if (value.startsWith('json:')) {
        return JSON.parse(value.slice(5));
      }
      
      // Legacy support for non-prefixed values
      if (type === 'json') {
        return JSON.parse(value);
      }
      
      return value as any;
    } catch (error) {
      throw new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        'Failed to deserialize cache value',
        { operation: 'deserialize_cache_value' },
        { cause: error as Error }
      );
    }
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  // =============================================================================
  // MONITORING & STATS
  // =============================================================================

  async getStats(): Promise<CacheStats> {
    try {
      const info = await this.redis.info('memory');
      const memoryMatch = info.match(/used_memory:(\d+)/);
      
      if (memoryMatch) {
        this.stats.memoryUsage = parseInt(memoryMatch[1]);
      }

      const clientsInfo = await this.redis.info('clients');
      const clientsMatch = clientsInfo.match(/connected_clients:(\d+)/);
      
      if (clientsMatch) {
        this.stats.connectedClients = parseInt(clientsMatch[1]);
      }
    } catch (error) {
      this.logger.warn('Failed to get Redis stats', { operation: 'get_stats', metadata: { error } });
    }

    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = this.initializeStats();
  }

  // Health check
  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    try {
      const start = Date.now();
      await this.redis.ping();
      const latency = Date.now() - start;
      
      return { healthy: true, latency };
    } catch (error) {
      return { 
        healthy: false, 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }

  // =============================================================================
  // CLEANUP & SHUTDOWN
  // =============================================================================

  async flush(pattern?: string): Promise<void> {
    if (pattern) {
      await this.deletePattern(pattern);
    } else {
      await this.redis.flushdb();
    }
    
    this.logger.info('Cache flushed', { operation: 'flush', metadata: { pattern: pattern || 'all' } });
  }

  async disconnect(): Promise<void> {
    if (this.pipelineTimer) {
      clearTimeout(this.pipelineTimer);
    }
    
    await this.redis.quit();
    this.logger.info('Cache manager disconnected');
  }
}

// =============================================================================
// CACHE UTILITIES
// =============================================================================

export class CacheKeyBuilder {
  private static readonly SEPARATOR = ':';

  static embedding(contentHash: string): string {
    return `embedding${this.SEPARATOR}${contentHash}`;
  }

  static searchResults(queryHash: string, filters?: Record<string, string>): string {
    const filterString = filters ? 
      Object.entries(filters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&') 
      : '';
    
    return `search${this.SEPARATOR}${queryHash}${filterString ? `${this.SEPARATOR}${filterString}` : ''}`;
  }

  static project(projectId: string, type?: string): string {
    return `project${this.SEPARATOR}${projectId}${type ? `${this.SEPARATOR}${type}` : ''}`;
  }

  static fileHash(projectId: string, filePath: string): string {
    const encodedPath = Buffer.from(filePath).toString('base64');
    return `hash${this.SEPARATOR}${projectId}${this.SEPARATOR}${encodedPath}`;
  }

  static gitData(repoId: string, type: string, identifier?: string): string {
    return `git${this.SEPARATOR}${repoId}${this.SEPARATOR}${type}${identifier ? `${this.SEPARATOR}${identifier}` : ''}`;
  }
}

export function createContentHash(content: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function createQueryHash(query: string, filters: Record<string, any> = {}): string {
  const crypto = require('crypto');
  const queryData = { query, filters };
  const jsonString = JSON.stringify(queryData, Object.keys(queryData).sort());
  return crypto.createHash('sha256').update(jsonString).digest('hex');
}

// =============================================================================
// EXPORT SINGLETON INSTANCE
// =============================================================================

export const cacheManager = new CacheManager();

// Auto-connect in production
if (process.env.NODE_ENV === 'production' && process.env.REDIS_HOST) {
  cacheManager.connect().catch(error => {
    logger.error('Failed to connect to Redis', { operation: 'redis_connect', metadata: { error } });
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  await cacheManager.disconnect();
});

process.on('SIGINT', async () => {
  await cacheManager.disconnect();
});