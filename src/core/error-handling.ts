/**
 * Production-Grade Error Handling System
 * Provides structured error handling, retry mechanisms, and circuit breaker patterns
 */

import { EventEmitter } from 'events';

// Error classification system
export enum ErrorCode {
  // Client errors (4xx equivalent)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  RATE_LIMITED = 'RATE_LIMITED',
  
  // Server errors (5xx equivalent)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  
  // External service errors
  OPENAI_API_ERROR = 'OPENAI_API_ERROR',
  SUPABASE_ERROR = 'SUPABASE_ERROR',
  GIT_ERROR = 'GIT_ERROR',
  
  // Business logic errors
  INDEXING_FAILED = 'INDEXING_FAILED',
  EMBEDDING_FAILED = 'EMBEDDING_FAILED',
  SEARCH_FAILED = 'SEARCH_FAILED'
}

export interface ErrorContext {
  operation: string;
  resource?: string;
  userId?: string;
  projectId?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
  traceId: string;
}

export class StructuredError extends Error {
  public readonly code: ErrorCode;
  public readonly context: ErrorContext;
  public readonly retryable: boolean;
  public readonly severity: 'low' | 'medium' | 'high' | 'critical';
  public readonly cause?: Error;

  constructor(
    code: ErrorCode,
    message: string,
    context: Partial<ErrorContext> & { operation: string },
    options: {
      retryable?: boolean;
      severity?: 'low' | 'medium' | 'high' | 'critical';
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = 'StructuredError';
    this.code = code;
    this.retryable = options.retryable ?? this.isRetryableByDefault(code);
    this.severity = options.severity ?? this.getSeverityByDefault(code);
    this.cause = options.cause;
    
    this.context = {
      timestamp: new Date(),
      traceId: this.generateTraceId(),
      ...context
    } as ErrorContext;

    // Maintain stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StructuredError);
    }
  }

  private isRetryableByDefault(code: ErrorCode): boolean {
    const retryableCodes = [
      ErrorCode.SERVICE_UNAVAILABLE,
      ErrorCode.TIMEOUT_ERROR,
      ErrorCode.RATE_LIMITED,
      ErrorCode.OPENAI_API_ERROR,
      ErrorCode.SUPABASE_ERROR
    ];
    return retryableCodes.includes(code);
  }

  private getSeverityByDefault(code: ErrorCode): 'low' | 'medium' | 'high' | 'critical' {
    switch (code) {
      case ErrorCode.VALIDATION_ERROR:
      case ErrorCode.RESOURCE_NOT_FOUND:
        return 'low';
      
      case ErrorCode.PERMISSION_DENIED:
      case ErrorCode.RATE_LIMITED:
        return 'medium';
      
      case ErrorCode.TIMEOUT_ERROR:
      case ErrorCode.OPENAI_API_ERROR:
      case ErrorCode.SUPABASE_ERROR:
        return 'high';
      
      case ErrorCode.INTERNAL_ERROR:
      case ErrorCode.SERVICE_UNAVAILABLE:
        return 'critical';
      
      default:
        return 'medium';
    }
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      retryable: this.retryable,
      severity: this.severity,
      stack: this.stack,
      cause: this.cause?.message
    };
  }
}

// Result pattern for error handling
export class Result<T, E = StructuredError> {
  private constructor(
    private readonly _value?: T,
    private readonly _error?: E
  ) {}

  static success<T>(value: T): Result<T> {
    return new Result(value);
  }

  static failure<E = StructuredError>(error: E): Result<never, E> {
    return new Result(undefined, error);
  }

  get isSuccess(): boolean {
    return this._error === undefined;
  }

  get isFailure(): boolean {
    return this._error !== undefined;
  }

  get value(): T {
    if (this._error) {
      throw new Error('Cannot get value from failed result');
    }
    return this._value!;
  }

  get error(): E {
    if (!this._error) {
      throw new Error('Cannot get error from successful result');
    }
    return this._error;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    if (this._error) {
      return Result.failure(this._error);
    }
    try {
      return Result.success(fn(this._value!));
    } catch (error) {
      return Result.failure(error as E);
    }
  }

  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    if (this._error) {
      return Result.failure(this._error);
    }
    return fn(this._value!);
  }

  mapError<F>(fn: (error: E) => F): Result<T, F> {
    if (this._error) {
      return Result.failure(fn(this._error));
    }
    return Result.success(this._value!);
  }

  getOrElse(defaultValue: T): T {
    return this._error ? defaultValue : this._value!;
  }

  getOrThrow(): T {
    if (this._error) {
      throw this._error;
    }
    return this._value!;
  }
}

// Retry configuration
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs: number;
  retryOn?: (error: Error) => boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterMs: 100,
  retryOn: (error) => error instanceof StructuredError && error.retryable
};

// Retry executor with exponential backoff
export class RetryExecutor {
  private readonly config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  async execute<T>(
    operation: () => Promise<T>,
    context: { operation: string; resource?: string }
  ): Promise<Result<T, StructuredError>> {
    let lastError: Error;
    
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const result = await operation();
        return Result.success(result);
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        const shouldRetry = this.shouldRetry(error, attempt);
        if (!shouldRetry) {
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = this.calculateDelay(attempt);
        
        // Log retry attempt
        console.warn(`Retry attempt ${attempt}/${this.config.maxAttempts} for ${context.operation} after ${delay}ms`, {
          error: error.message,
          attempt,
          delay
        });

        await this.sleep(delay);
      }
    }

    // All retries failed, wrap in StructuredError if needed
    const structuredError = lastError instanceof StructuredError 
      ? lastError 
      : new StructuredError(
          ErrorCode.INTERNAL_ERROR,
          `Operation failed after ${this.config.maxAttempts} attempts: ${lastError.message}`,
          context,
          { cause: lastError }
        );

    return Result.failure(structuredError);
  }

  private shouldRetry(error: Error, attempt: number): boolean {
    if (attempt >= this.config.maxAttempts) {
      return false;
    }

    if (this.config.retryOn) {
      return this.config.retryOn(error);
    }

    return error instanceof StructuredError && error.retryable;
  }

  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    const jitter = Math.random() * this.config.jitterMs;
    
    return Math.floor(cappedDelay + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Circuit breaker implementation
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  monitoringWindowMs: number;
  volumeThreshold: number;
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number[] = [];
  private nextAttempt: number = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = {
      failureThreshold: 5,
      resetTimeoutMs: 60000,
      monitoringWindowMs: 60000,
      volumeThreshold: 10,
      ...config
    };
  }

  async execute<T>(
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        if (fallback) {
          return fallback();
        }
        throw new StructuredError(
          ErrorCode.SERVICE_UNAVAILABLE,
          'Circuit breaker is OPEN',
          { operation: 'circuit_breaker' },
          { retryable: false }
        );
      } else {
        this.state = CircuitState.HALF_OPEN;
        this.emit('stateChange', CircuitState.HALF_OPEN);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.failures = [];
      this.emit('stateChange', CircuitState.CLOSED);
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    
    // Remove old failures outside monitoring window
    const cutoff = now - this.config.monitoringWindowMs;
    this.failures = this.failures.filter(time => time > cutoff);

    // Check if we should open the circuit
    if (this.failures.length >= this.config.volumeThreshold) {
      const failureRate = this.failures.length / this.config.volumeThreshold;
      
      if (failureRate >= this.config.failureThreshold / this.config.volumeThreshold) {
        this.state = CircuitState.OPEN;
        this.nextAttempt = now + this.config.resetTimeoutMs;
        this.emit('stateChange', CircuitState.OPEN);
      }
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats() {
    const now = Date.now();
    const cutoff = now - this.config.monitoringWindowMs;
    const recentFailures = this.failures.filter(time => time > cutoff);
    
    return {
      state: this.state,
      failures: recentFailures.length,
      failureRate: recentFailures.length / this.config.volumeThreshold,
      nextAttempt: this.state === CircuitState.OPEN ? new Date(this.nextAttempt) : null
    };
  }
}

// Global error handler
export class GlobalErrorHandler {
  private static instance: GlobalErrorHandler;
  private retryExecutor: RetryExecutor;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  private constructor() {
    this.retryExecutor = new RetryExecutor();
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Promise Rejection:', reason);
      // Log to monitoring system
      this.logError(new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        'Unhandled promise rejection',
        { operation: 'unhandled_rejection' },
        { cause: reason instanceof Error ? reason : new Error(String(reason)) }
      ));
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      this.logError(new StructuredError(
        ErrorCode.INTERNAL_ERROR,
        'Uncaught exception',
        { operation: 'uncaught_exception' },
        { cause: error }
      ));
      
      // Exit gracefully
      process.exit(1);
    });
  }

  static getInstance(): GlobalErrorHandler {
    if (!GlobalErrorHandler.instance) {
      GlobalErrorHandler.instance = new GlobalErrorHandler();
    }
    return GlobalErrorHandler.instance;
  }

  getCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, new CircuitBreaker(config));
    }
    return this.circuitBreakers.get(name)!;
  }

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: { operation: string; resource?: string },
    retryConfig?: Partial<RetryConfig>
  ): Promise<Result<T, StructuredError>> {
    const executor = retryConfig ? new RetryExecutor(retryConfig) : this.retryExecutor;
    return executor.execute(operation, context);
  }

  async executeWithCircuitBreaker<T>(
    operation: () => Promise<T>,
    circuitName: string,
    fallback?: () => Promise<T>,
    circuitConfig?: Partial<CircuitBreakerConfig>
  ): Promise<T> {
    const circuitBreaker = this.getCircuitBreaker(circuitName, circuitConfig);
    return circuitBreaker.execute(operation, fallback);
  }

  private logError(error: StructuredError): void {
    // In production, this would send to logging service (e.g., Winston, DataDog)
    console.error('Structured Error:', {
      code: error.code,
      message: error.message,
      context: error.context,
      severity: error.severity,
      retryable: error.retryable,
      stack: error.stack
    });
  }
}

// Utility functions for common error patterns
export function wrapAsyncOperation<T>(
  operation: () => Promise<T>,
  context: { operation: string; resource?: string }
): Promise<Result<T, StructuredError>> {
  return GlobalErrorHandler.getInstance().executeWithRetry(operation, context);
}

export function createValidationError(
  message: string,
  field?: string,
  value?: any
): StructuredError {
  return new StructuredError(
    ErrorCode.VALIDATION_ERROR,
    message,
    {
      operation: 'validation',
      metadata: { field, value }
    },
    { retryable: false, severity: 'low' }
  );
}

export function createNotFoundError(
  resource: string,
  identifier: string
): StructuredError {
  return new StructuredError(
    ErrorCode.RESOURCE_NOT_FOUND,
    `${resource} not found: ${identifier}`,
    {
      operation: 'resource_lookup',
      resource,
      metadata: { identifier }
    },
    { retryable: false, severity: 'low' }
  );
}

export function createExternalServiceError(
  service: 'openai' | 'supabase' | 'git',
  message: string,
  cause?: Error
): StructuredError {
  const codeMap = {
    openai: ErrorCode.OPENAI_API_ERROR,
    supabase: ErrorCode.SUPABASE_ERROR,
    git: ErrorCode.GIT_ERROR
  };

  return new StructuredError(
    codeMap[service],
    `${service} error: ${message}`,
    {
      operation: `${service}_call`,
      metadata: { service }
    },
    { retryable: true, severity: 'high', cause }
  );
}

// Export singleton instance
export const errorHandler = GlobalErrorHandler.getInstance();