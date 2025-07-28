/**
 * Input Validation and Security System
 * Provides comprehensive input validation, sanitization, and basic security measures
 */

import { z } from 'zod';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { StructuredError, ErrorCode, createValidationError } from './error-handling';

// =============================================================================
// INPUT VALIDATION SCHEMAS
// =============================================================================

// Base schemas
const ProjectNameSchema = z.string()
  .min(1, 'Project name is required')
  .max(100, 'Project name must be less than 100 characters')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Project name can only contain letters, numbers, hyphens, and underscores');

const FilePathSchema = z.string()
  .min(1, 'File path is required')
  .max(1000, 'File path too long')
  .refine(path => !path.includes('..'), 'Path traversal not allowed')
  .refine(path => !path.startsWith('/etc'), 'System paths not allowed')
  .refine(path => !path.startsWith('/proc'), 'System paths not allowed');

const BranchNameSchema = z.string()
  .min(1, 'Branch name is required')
  .max(200, 'Branch name too long')
  .regex(/^[a-zA-Z0-9/_.-]+$/, 'Invalid branch name format');

const QuerySchema = z.string()
  .min(1, 'Query is required')
  .max(1000, 'Query too long')
  .refine(query => query.trim().length > 0, 'Query cannot be empty');

// MCP Tool Input Schemas
export const ValidationSchemas = {
  // Project operations
  createProject: z.object({
    name: ProjectNameSchema,
    path: FilePathSchema,
    description: z.string().max(500).optional()
  }),

  indexProject: z.object({
    projectName: ProjectNameSchema
  }),

  searchCode: z.object({
    query: QuerySchema,
    projectName: ProjectNameSchema.optional(),
    limit: z.number().min(1).max(100).default(10),
    threshold: z.number().min(0).max(1).default(0.7),
    language: z.string().max(50).optional()
  }),

  getCodeContext: z.object({
    filePath: FilePathSchema,
    line: z.number().min(1).max(1000000),
    projectName: ProjectNameSchema.optional(),
    contextLines: z.number().min(1).max(100).default(10)
  }),

  findSimilarCode: z.object({
    filePath: FilePathSchema,
    startLine: z.number().min(1),
    endLine: z.number().min(1),
    projectName: ProjectNameSchema.optional(),
    limit: z.number().min(1).max(50).default(5)
  }).refine(data => data.endLine >= data.startLine, 'End line must be greater than or equal to start line'),

  // Git operations
  configureGitRepository: z.object({
    projectName: ProjectNameSchema,
    repositoryPath: FilePathSchema,
    remoteUrl: z.string().url().optional(),
    branchTemplate: z.enum(['monorepo', 'gitflow', 'github-flow', 'minimal']).optional()
  }),

  indexGitBranch: z.object({
    projectName: ProjectNameSchema,
    branchName: BranchNameSchema,
    strategy: z.enum(['full-history', 'incremental-diff', 'snapshot', 'hotspot']).optional(),
    maxCommits: z.number().min(1).max(10000).optional(),
    since: z.string().datetime().optional()
  }),

  searchGitCode: z.object({
    query: QuerySchema,
    projectName: ProjectNameSchema.optional(),
    branchName: BranchNameSchema.optional(),
    authorEmail: z.string().email().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.number().min(1).max(100).default(10),
    threshold: z.number().min(0).max(1).default(0.7)
  }),

  getCodeHistory: z.object({
    projectName: ProjectNameSchema,
    filePath: FilePathSchema,
    branchName: BranchNameSchema.optional(),
    maxCommits: z.number().min(1).max(1000).default(20)
  }),

  compareBranches: z.object({
    projectName: ProjectNameSchema,
    sourceBranch: BranchNameSchema,
    targetBranch: BranchNameSchema,
    filePattern: z.string().max(200).optional()
  })
};

// =============================================================================
// VALIDATION MIDDLEWARE
// =============================================================================

export class InputValidator {
  static validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
    try {
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessage = error.errors
          .map(err => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        
        throw createValidationError(
          `Validation failed: ${errorMessage}`,
          error.errors[0]?.path.join('.'),
          error.errors[0]?.received
        );
      }
      throw error;
    }
  }

  static validateMCPToolInput(toolName: string, input: unknown): any {
    const schema = (ValidationSchemas as any)[toolName];
    if (!schema) {
      throw createValidationError(
        `Unknown tool: ${toolName}`,
        'toolName',
        toolName
      );
    }

    return this.validate(schema, input);
  }

  // Sanitize file paths to prevent directory traversal
  static sanitizeFilePath(filePath: string): string {
    // Remove null bytes
    const cleaned = filePath.replace(/\0/g, '');
    
    // Normalize path separators
    const normalized = cleaned.replace(/\\/g, '/');
    
    // Remove dangerous patterns
    const safe = normalized
      .replace(/\.\.+/g, '.') // Remove path traversal attempts
      .replace(/\/+/g, '/') // Collapse multiple slashes
      .replace(/^\/+/, '') // Remove leading slashes
      .trim();

    if (!safe) {
      throw createValidationError('Invalid file path after sanitization', 'filePath', filePath);
    }

    return safe;
  }

  // Sanitize search queries
  static sanitizeQuery(query: string): string {
    // Remove control characters and excessive whitespace
    const cleaned = query
      .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
      .replace(/\s+/g, ' ') // Collapse whitespace
      .trim();

    if (!cleaned) {
      throw createValidationError('Query is empty after sanitization', 'query', query);
    }

    return cleaned.substring(0, 1000); // Truncate to max length
  }
}

// =============================================================================
// SECURITY MEASURES
// =============================================================================

export interface SecurityConfig {
  enableRateLimit: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  enableApiKeyAuth: boolean;
  apiKeyHeader: string;
  trustedApiKeys: Set<string>;
  maxRequestSizeBytes: number;
  enableCors: boolean;
  allowedOrigins: string[];
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enableRateLimit: true,
  rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
  rateLimitMaxRequests: 100, // 100 requests per window
  enableApiKeyAuth: true,
  apiKeyHeader: 'x-api-key',
  trustedApiKeys: new Set(),
  maxRequestSizeBytes: 10 * 1024 * 1024, // 10MB
  enableCors: true,
  allowedOrigins: ['http://localhost:3000', 'https://*.claude.ai']
};

export class SecurityManager {
  private config: SecurityConfig;
  private rateLimiter?: any;
  private rateLimiterStore?: Map<string, any>;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: Partial<SecurityConfig> = {}) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };
    this.initializeRateLimit();
  }

  private initializeRateLimit(): void {
    if (this.config.enableRateLimit) {
      // Create a memory store with automatic cleanup
      this.rateLimiterStore = new Map();
      
      this.rateLimiter = rateLimit({
        windowMs: this.config.rateLimitWindowMs,
        max: this.config.rateLimitMaxRequests,
        message: {
          error: 'Too many requests',
          code: 'RATE_LIMITED',
          retryAfter: Math.ceil(this.config.rateLimitWindowMs / 1000)
        },
        standardHeaders: true,
        legacyHeaders: false,
        store: {
          // Custom store implementation with memory management
          incr: (key: string, cb: (err?: Error, total?: number) => void) => {
            const now = Date.now();
            const entry = this.rateLimiterStore!.get(key) || { count: 0, resetTime: now + this.config.rateLimitWindowMs };
            
            // Reset if window has expired
            if (now >= entry.resetTime) {
              entry.count = 0;
              entry.resetTime = now + this.config.rateLimitWindowMs;
            }
            
            entry.count++;
            this.rateLimiterStore!.set(key, entry);
            
            cb(undefined, entry.count);
          },
          decrement: (key: string) => {
            const entry = this.rateLimiterStore!.get(key);
            if (entry && entry.count > 0) {
              entry.count--;
              this.rateLimiterStore!.set(key, entry);
            }
          },
          resetKey: (key: string) => {
            this.rateLimiterStore!.delete(key);
          }
        },
        handler: (req: Request, res: Response) => {
          throw new StructuredError(
            ErrorCode.RATE_LIMITED,
            'Too many requests from this IP',
            { 
              operation: 'rate_limit',
              metadata: { 
                ip: req.ip,
                userAgent: req.get('User-Agent')
              }
            },
            { retryable: true, severity: 'medium' }
          );
        }
      });
      
      // Set up periodic cleanup of expired entries
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredEntries();
      }, this.config.rateLimitWindowMs); // Cleanup every window period
    }
  }

  // API Key Authentication Middleware
  authenticateApiKey = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.config.enableApiKeyAuth) {
      return next();
    }

    const apiKey = req.header(this.config.apiKeyHeader);
    
    if (!apiKey) {
      throw new StructuredError(
        ErrorCode.PERMISSION_DENIED,
        'API key required',
        { operation: 'authentication' },
        { retryable: false, severity: 'medium' }
      );
    }

    if (!this.isValidApiKey(apiKey)) {
      throw new StructuredError(
        ErrorCode.PERMISSION_DENIED,
        'Invalid API key',
        { 
          operation: 'authentication',
          metadata: { keyPrefix: apiKey.substring(0, 8) + '...' }
        },
        { retryable: false, severity: 'high' }
      );
    }

    next();
  };

  // Rate Limiting Middleware
  rateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (this.rateLimiter) {
      this.rateLimiter(req, res, next);
    } else {
      next();
    }
  };

  // Request Size Validation
  validateRequestSize = (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = parseInt(req.get('content-length') || '0');
    
    if (contentLength > this.config.maxRequestSizeBytes) {
      throw new StructuredError(
        ErrorCode.VALIDATION_ERROR,
        `Request too large: ${contentLength} bytes (max: ${this.config.maxRequestSizeBytes})`,
        { 
          operation: 'request_size_validation',
          metadata: { size: contentLength, maxSize: this.config.maxRequestSizeBytes }
        },
        { retryable: false, severity: 'low' }
      );
    }

    next();
  };

  // CORS Configuration
  getCorsOptions() {
    if (!this.config.enableCors) {
      return null;
    }

    return {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        const isAllowed = this.config.allowedOrigins.some(allowedOrigin => {
          if (allowedOrigin.includes('*')) {
            const pattern = allowedOrigin.replace(/\*/g, '.*');
            return new RegExp(`^${pattern}$`).test(origin);
          }
          return allowedOrigin === origin;
        });

        if (isAllowed) {
          callback(null, true);
        } else {
          callback(new StructuredError(
            ErrorCode.PERMISSION_DENIED,
            `Origin not allowed: ${origin}`,
            { 
              operation: 'cors_validation',
              metadata: { origin, allowedOrigins: this.config.allowedOrigins }
            },
            { retryable: false, severity: 'medium' }
          ));
        }
      },
      credentials: true,
      optionsSuccessStatus: 200
    };
  }

  // API Key Management
  addApiKey(key: string): void {
    if (!this.isValidApiKeyFormat(key)) {
      throw createValidationError('Invalid API key format', 'apiKey', key);
    }
    this.config.trustedApiKeys.add(key);
  }

  removeApiKey(key: string): void {
    this.config.trustedApiKeys.delete(key);
  }
  
  private cleanupExpiredEntries(): void {
    if (!this.rateLimiterStore) return;
    
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    // Find expired entries
    for (const [key, entry] of this.rateLimiterStore) {
      if (now >= entry.resetTime) {
        keysToDelete.push(key);
      }
    }
    
    // Remove expired entries
    for (const key of keysToDelete) {
      this.rateLimiterStore.delete(key);
    }
    
    // Prevent unbounded growth by removing oldest entries if too many
    const maxEntries = 10000;
    if (this.rateLimiterStore.size > maxEntries) {
      const entries = Array.from(this.rateLimiterStore.entries());
      entries.sort((a, b) => a[1].resetTime - b[1].resetTime);
      
      const toDelete = entries.slice(0, entries.length - maxEntries + 1000).map(([key]) => key);
      for (const key of toDelete) {
        this.rateLimiterStore.delete(key);
      }
    }
  }
  
  // Cleanup method for graceful shutdown
  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    
    if (this.rateLimiterStore) {
      this.rateLimiterStore.clear();
      this.rateLimiterStore = undefined;
    }
  }

  generateApiKey(): string {
    const randomBytes = crypto.randomBytes(32);
    return `mk_${randomBytes.toString('hex')}`;
  }

  private isValidApiKey(key: string): boolean {
    // Use constant-time comparison to prevent timing attacks
    const storedKeys = Array.from(this.config.trustedApiKeys);
    
    // Ensure we always check at least one key to maintain constant time
    if (storedKeys.length === 0) {
      // Perform a dummy comparison to prevent timing differences
      crypto.timingSafeEqual(
        Buffer.from(key.padEnd(67, '0')), 
        Buffer.from('mk_'.padEnd(67, '0'))
      );
      return false;
    }
    
    let isValid = false;
    for (const validKey of storedKeys) {
      if (key.length === validKey.length) {
        try {
          const keyBuffer = Buffer.from(key);
          const validKeyBuffer = Buffer.from(validKey);
          if (crypto.timingSafeEqual(keyBuffer, validKeyBuffer)) {
            isValid = true;
          }
        } catch (error) {
          // Continue checking other keys even if one fails
          continue;
        }
      }
    }
    
    return isValid;
  }

  private isValidApiKeyFormat(key: string): boolean {
    // API keys should be at least 32 characters and start with 'mk_'
    return /^mk_[a-f0-9]{64}$/.test(key);
  }

  // Security Headers
  addSecurityHeaders = (req: Request, res: Response, next: NextFunction): void => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Strict Transport Security (if HTTPS)
    if (req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    // Content Security Policy
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';");
    
    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    next();
  };
}

// =============================================================================
// SECRET MANAGEMENT
// =============================================================================

export class SecretManager {
  private secrets: Map<string, string> = new Map();

  constructor() {
    this.loadSecretsFromEnv();
  }

  private loadSecretsFromEnv(): void {
    const secretKeys = [
      'OPENAI_API_KEY',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_KEY',
      'REDIS_URL',
      'DATABASE_URL'
    ];

    for (const key of secretKeys) {
      const value = process.env[key];
      if (value) {
        this.secrets.set(key, value);
      }
    }
  }

  getSecret(key: string): string {
    const secret = this.secrets.get(key);
    if (!secret) {
      throw new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        `Secret not found: ${key}`,
        { operation: 'secret_retrieval', metadata: { key } },
        { retryable: false, severity: 'critical' }
      );
    }
    return secret;
  }

  hasSecret(key: string): boolean {
    return this.secrets.has(key);
  }

  // Mask secret for logging (show only first and last 4 characters)
  maskSecret(secret: string): string {
    if (secret.length <= 8) {
      return '*'.repeat(secret.length);
    }
    const start = secret.substring(0, 4);
    const end = secret.substring(secret.length - 4);
    const middle = '*'.repeat(secret.length - 8);
    return `${start}${middle}${end}`;
  }
}

// =============================================================================
// AUDIT LOGGING
// =============================================================================

export interface AuditEvent {
  timestamp: Date;
  operation: string;
  userId?: string;
  resource?: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
  ip?: string;
  userAgent?: string;
}

export class AuditLogger {
  private events: AuditEvent[] = [];
  private maxEvents: number = 10000;

  logEvent(event: Omit<AuditEvent, 'timestamp'>): void {
    const auditEvent: AuditEvent = {
      timestamp: new Date(),
      ...event
    };

    // Prevent unbounded growth by removing oldest events first
    if (this.events.length >= this.maxEvents) {
      // Remove oldest half when we hit the limit
      const removeCount = Math.floor(this.maxEvents / 2);
      this.events.splice(0, removeCount);
    }

    this.events.push(auditEvent);

    // In production, this would be sent to a logging service
    console.log('AUDIT:', JSON.stringify(auditEvent));
  }

  getRecentEvents(limit: number = 100): AuditEvent[] {
    return this.events.slice(-limit);
  }

  getEventsByOperation(operation: string, limit: number = 100): AuditEvent[] {
    return this.events
      .filter(event => event.operation === operation)
      .slice(-limit);
  }
}

// Export singleton instances
export const securityManager = new SecurityManager();
export const secretManager = new SecretManager();
export const auditLogger = new AuditLogger();

// Graceful shutdown cleanup
process.on('SIGTERM', () => {
  securityManager.cleanup();
});

process.on('SIGINT', () => {
  securityManager.cleanup();
});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

export function sanitizeForLogging(obj: any): any {
  const sensitive = ['password', 'token', 'key', 'secret', 'authorization'];
  
  if (typeof obj === 'string') {
    return obj.length > 100 ? obj.substring(0, 100) + '...' : obj;
  }
  
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  
  const sanitized: any = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    const isSensitive = sensitive.some(term => keyLower.includes(term));
    
    if (isSensitive && typeof value === 'string') {
      sanitized[key] = secretManager.maskSecret(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}