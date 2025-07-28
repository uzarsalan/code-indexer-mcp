/**
 * Structured Logging and Observability System
 * Provides comprehensive logging, metrics collection, and basic monitoring
 */

import winston from 'winston';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { StructuredError, ErrorCode } from './error-handling.js';
import { MemoryStats } from './memory-management.js';
import { sanitizeForLogging } from './validation-security.js';

// =============================================================================
// STRUCTURED LOGGING
// =============================================================================

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  TRACE = 'trace'
}

export interface LogContext {
  traceId?: string;
  operation?: string;
  resource?: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  requestId?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
    severity?: string;
  };
  service: string;
  version: string;
  environment: string;
}

export class StructuredLogger {
  private winston: winston.Logger;
  private defaultContext: LogContext;

  constructor(config: {
    service: string;
    version: string;
    environment: string;
    logLevel?: LogLevel;
    enableConsole?: boolean;
    enableFile?: boolean;
    logDir?: string;
  }) {
    this.defaultContext = {};
    
    const transports: winston.transport[] = [];

    // Console transport with colorized output for development
    if (config.enableConsole !== false) {
      transports.push(new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(this.formatConsoleOutput.bind(this))
        )
      }));
    }

    // File transport for production
    if (config.enableFile) {
      const logDir = config.logDir || './logs';
      
      // Application logs
      transports.push(new winston.transports.File({
        filename: `${logDir}/app.log`,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
        maxsize: 50 * 1024 * 1024, // 50MB
        maxFiles: 5
      }));

      // Error logs
      transports.push(new winston.transports.File({
        filename: `${logDir}/error.log`,
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
        maxsize: 50 * 1024 * 1024,
        maxFiles: 10
      }));
    }

    this.winston = winston.createLogger({
      level: config.logLevel || LogLevel.INFO,
      defaultMeta: {
        service: config.service,
        version: config.version,
        environment: config.environment
      },
      transports,
      exitOnError: false
    });
  }

  private formatConsoleOutput(info: any): string {
    const { timestamp, level, message, service, ...meta } = info;
    const metaStr = Object.keys(meta).length ? JSON.stringify(sanitizeForLogging(meta), null, 2) : '';
    return `${timestamp} [${service}] ${level}: ${message}${metaStr ? `\n${metaStr}` : ''}`;
  }

  // Create child logger with additional context
  child(context: LogContext): StructuredLogger {
    const childLogger = Object.create(this);
    childLogger.defaultContext = { ...this.defaultContext, ...context };
    return childLogger;
  }

  // Core logging methods
  error(message: string, context: LogContext = {}, error?: Error | StructuredError): void {
    this.log(LogLevel.ERROR, message, context, error);
  }

  warn(message: string, context: LogContext = {}): void {
    this.log(LogLevel.WARN, message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.log(LogLevel.INFO, message, context);
  }

  debug(message: string, context: LogContext = {}): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  trace(message: string, context: LogContext = {}): void {
    this.log(LogLevel.TRACE, message, context);
  }

  private log(level: LogLevel, message: string, context: LogContext = {}, error?: Error | StructuredError): void {
    const mergedContext = { ...this.defaultContext, ...context };
    const logEntry: any = {
      message,
      context: sanitizeForLogging(mergedContext)
    };

    if (error) {
      logEntry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };

      if (error instanceof StructuredError) {
        logEntry.error.code = error.code;
        logEntry.error.severity = error.severity;
      }
    }

    this.winston.log(level, logEntry);
  }

  // Operation logging with automatic timing
  async logOperation<T>(
    operation: string,
    fn: () => Promise<T>,
    context: LogContext = {}
  ): Promise<T> {
    const traceId = context.traceId || this.generateTraceId();
    const startTime = performance.now();
    
    const operationContext = {
      ...context,
      operation,
      traceId
    };

    this.info(`Starting operation: ${operation}`, operationContext);

    try {
      const result = await fn();
      const duration = performance.now() - startTime;
      
      this.info(`Operation completed: ${operation}`, {
        ...operationContext,
        duration: Math.round(duration)
      });

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      
      this.error(`Operation failed: ${operation}`, {
        ...operationContext,
        duration: Math.round(duration)
      }, error as Error);

      throw error;
    }
  }

  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// =============================================================================
// METRICS COLLECTION
// =============================================================================

export interface MetricValue {
  value: number;
  timestamp: Date;
  labels?: Record<string, string>;
}

export interface HistogramBucket {
  le: number; // Less than or equal to
  count: number;
}

export interface MetricData {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  values: MetricValue[];
  histogram?: {
    buckets: HistogramBucket[];
    sum: number;
    count: number;
  };
}

export class MetricsCollector extends EventEmitter {
  private metrics: Map<string, MetricData> = new Map();
  private readonly histogramBuckets = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]; // seconds
  private readonly maxValuesPerMetric: number = 10000;
  private readonly maxMetrics: number = 1000;

  // Counter metrics
  increment(name: string, labels?: Record<string, string>, value: number = 1): void {
    const metric = this.getOrCreateMetric(name, 'counter', `${name} counter`);
    
    // Prevent unbounded metric value growth
    if (metric.values.length >= this.maxValuesPerMetric) {
      const keepCount = Math.floor(this.maxValuesPerMetric / 2);
      metric.values = metric.values.slice(-keepCount);
    }
    
    metric.values.push({
      value,
      timestamp: new Date(),
      labels
    });

    this.emit('metricUpdated', { name, type: 'counter', value, labels });
  }

  // Gauge metrics
  set(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.getOrCreateMetric(name, 'gauge', `${name} gauge`);
    
    // Prevent unbounded metric value growth
    if (metric.values.length >= this.maxValuesPerMetric) {
      const keepCount = Math.floor(this.maxValuesPerMetric / 2);
      metric.values = metric.values.slice(-keepCount);
    }
    
    metric.values.push({
      value,
      timestamp: new Date(),
      labels
    });

    this.emit('metricUpdated', { name, type: 'gauge', value, labels });
  }

  // Histogram metrics for timing
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.getOrCreateMetric(name, 'histogram', `${name} histogram`);
    
    if (!metric.histogram) {
      metric.histogram = {
        buckets: this.histogramBuckets.map(le => ({ le, count: 0 })),
        sum: 0,
        count: 0
      };
    }

    // Prevent unbounded metric value growth
    if (metric.values.length >= this.maxValuesPerMetric) {
      const keepCount = Math.floor(this.maxValuesPerMetric / 2);
      metric.values = metric.values.slice(-keepCount);
      
      // Reset histogram buckets to prevent unbounded growth
      if (metric.histogram.count > this.maxValuesPerMetric * 2) {
        metric.histogram = {
          buckets: this.histogramBuckets.map(le => ({ le, count: 0 })),
          sum: 0,
          count: 0
        };
      }
    }

    // Update buckets
    for (const bucket of metric.histogram.buckets) {
      if (value <= bucket.le) {
        bucket.count++;
      }
    }

    metric.histogram.sum += value;
    metric.histogram.count++;

    metric.values.push({
      value,
      timestamp: new Date(),
      labels
    });

    this.emit('metricUpdated', { name, type: 'histogram', value, labels });
  }

  // Timer utility for measuring operation duration
  startTimer(name: string, labels?: Record<string, string>): () => void {
    const startTime = performance.now();
    return () => {
      const duration = (performance.now() - startTime) / 1000; // Convert to seconds
      this.observe(name, duration, labels);
    };
  }

  private getOrCreateMetric(name: string, type: MetricData['type'], help: string): MetricData {
    if (!this.metrics.has(name)) {
      // Prevent unbounded metrics growth
      if (this.metrics.size >= this.maxMetrics) {
        // Remove oldest metrics (simple LRU-like)
        const oldestMetricName = this.metrics.keys().next().value as string;
        this.metrics.delete(oldestMetricName);
      }
      
      this.metrics.set(name, {
        name,
        type,
        help,
        values: []
      });
    }
    return this.metrics.get(name)!;
  }

  // Get all metrics in Prometheus format
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.type === 'histogram' && metric.histogram) {
        // Histogram buckets
        for (const bucket of metric.histogram.buckets) {
          const labelsStr = `le="${bucket.le}"`;
          lines.push(`${metric.name}_bucket{${labelsStr}} ${bucket.count}`);
        }
        lines.push(`${metric.name}_sum ${metric.histogram.sum}`);
        lines.push(`${metric.name}_count ${metric.histogram.count}`);
      } else {
        // Counter and gauge values (latest values by label combination)
        const latestValues = this.getLatestValuesByLabels(metric.values);
        for (const [labelsKey, value] of latestValues) {
          const labelsStr = labelsKey || '';
          lines.push(`${metric.name}${labelsStr ? `{${labelsStr}}` : ''} ${value.value}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  private getLatestValuesByLabels(values: MetricValue[]): Map<string, MetricValue> {
    const latest = new Map<string, MetricValue>();

    for (const value of values) {
      const labelsKey = value.labels ? 
        Object.entries(value.labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}="${v}"`)
          .join(',') : '';

      if (!latest.has(labelsKey) || value.timestamp > latest.get(labelsKey)!.timestamp) {
        latest.set(labelsKey, value);
      }
    }

    return latest;
  }

  // Reset all metrics (useful for testing)
  reset(): void {
    this.metrics.clear();
  }

  // Get metric summary
  getMetricsSummary(): Record<string, any> {
    const summary: Record<string, any> = {};

    for (const [name, metric] of this.metrics) {
      summary[name] = {
        type: metric.type,
        valueCount: metric.values.length,
        lastUpdated: metric.values.length > 0 ? 
          Math.max(...metric.values.map(v => v.timestamp.getTime())) : null
      };

      if (metric.type === 'histogram' && metric.histogram) {
        summary[name].histogram = {
          count: metric.histogram.count,
          sum: metric.histogram.sum,
          avg: metric.histogram.count > 0 ? metric.histogram.sum / metric.histogram.count : 0
        };
      }
    }

    return summary;
  }
}

// =============================================================================
// APPLICATION METRICS
// =============================================================================

export class ApplicationMetrics {
  private metrics: MetricsCollector;
  private logger: StructuredLogger;

  constructor(metrics: MetricsCollector, logger: StructuredLogger) {
    this.metrics = metrics;
    this.logger = logger;
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    // HTTP request metrics
    this.metrics['getOrCreateMetric']('http_requests_total', 'counter', 'Total HTTP requests');
    this.metrics['getOrCreateMetric']('http_request_duration_seconds', 'histogram', 'HTTP request duration');
    
    // MCP operation metrics  
    this.metrics['getOrCreateMetric']('mcp_operations_total', 'counter', 'Total MCP operations');
    this.metrics['getOrCreateMetric']('mcp_operation_duration_seconds', 'histogram', 'MCP operation duration');
    this.metrics['getOrCreateMetric']('mcp_operation_errors_total', 'counter', 'Total MCP operation errors');
    
    // Indexing metrics
    this.metrics['getOrCreateMetric']('indexing_operations_total', 'counter', 'Total indexing operations');
    this.metrics['getOrCreateMetric']('indexing_chunks_processed', 'counter', 'Total chunks processed');
    this.metrics['getOrCreateMetric']('indexing_duration_seconds', 'histogram', 'Indexing operation duration');
    
    // Search metrics
    this.metrics['getOrCreateMetric']('search_operations_total', 'counter', 'Total search operations');
    this.metrics['getOrCreateMetric']('search_results_returned', 'histogram', 'Number of search results');
    this.metrics['getOrCreateMetric']('search_duration_seconds', 'histogram', 'Search operation duration');
    
    // External service metrics
    this.metrics['getOrCreateMetric']('openai_api_calls_total', 'counter', 'Total OpenAI API calls');
    this.metrics['getOrCreateMetric']('openai_api_duration_seconds', 'histogram', 'OpenAI API call duration');
    this.metrics['getOrCreateMetric']('openai_api_errors_total', 'counter', 'Total OpenAI API errors');
    
    this.metrics['getOrCreateMetric']('supabase_operations_total', 'counter', 'Total Supabase operations');
    this.metrics['getOrCreateMetric']('supabase_operation_duration_seconds', 'histogram', 'Supabase operation duration');
    
    // System metrics
    this.metrics['getOrCreateMetric']('memory_usage_bytes', 'gauge', 'Memory usage in bytes');
    this.metrics['getOrCreateMetric']('active_connections', 'gauge', 'Number of active connections');
  }

  // Track MCP operations
  trackMCPOperation<T>(
    operation: string,
    fn: () => Promise<T>,
    context: LogContext = {}
  ): Promise<T> {
    const timer = this.metrics.startTimer('mcp_operation_duration_seconds', { operation });
    
    return this.logger.logOperation(`mcp:${operation}`, async () => {
      try {
        const result = await fn();
        this.metrics.increment('mcp_operations_total', { operation, status: 'success' });
        return result;
      } catch (error) {
        this.metrics.increment('mcp_operations_total', { operation, status: 'error' });
        this.metrics.increment('mcp_operation_errors_total', { operation, error: (error as Error).constructor.name });
        throw error;
      } finally {
        timer();
      }
    }, context);
  }

  // Track indexing operations
  trackIndexingOperation<T>(
    type: 'full' | 'incremental' | 'git',
    fn: () => Promise<T>,
    context: LogContext = {}
  ): Promise<T> {
    const timer = this.metrics.startTimer('indexing_duration_seconds', { type });
    
    return this.logger.logOperation(`indexing:${type}`, async () => {
      try {
        const result = await fn();
        this.metrics.increment('indexing_operations_total', { type, status: 'success' });
        return result;
      } catch (error) {
        this.metrics.increment('indexing_operations_total', { type, status: 'error' });
        throw error;
      } finally {
        timer();
      }
    }, context);
  }

  // Track external API calls
  trackExternalAPICall<T>(
    service: 'openai' | 'supabase',
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const timer = this.metrics.startTimer(`${service}_api_duration_seconds`, { operation });
    
    return this.logger.logOperation(`${service}:${operation}`, async () => {
      try {
        const result = await fn();
        this.metrics.increment(`${service}_api_calls_total`, { operation, status: 'success' });
        return result;
      } catch (error) {
        this.metrics.increment(`${service}_api_calls_total`, { operation, status: 'error' });
        this.metrics.increment(`${service}_api_errors_total`, { operation, error: (error as Error).constructor.name });
        throw error;
      } finally {
        timer();
      }
    });
  }

  // Update system metrics
  updateMemoryMetrics(memoryStats: MemoryStats): void {
    this.metrics.set('memory_usage_bytes', memoryStats.heapUsedMB * 1024 * 1024, { type: 'heap_used' });
    this.metrics.set('memory_usage_bytes', memoryStats.heapTotalMB * 1024 * 1024, { type: 'heap_total' });
    this.metrics.set('memory_usage_bytes', memoryStats.rss * 1024 * 1024, { type: 'rss' });
  }

  trackChunksProcessed(count: number, type: string): void {
    this.metrics.increment('indexing_chunks_processed', { type }, count);
  }

  trackSearchResults(count: number, queryType: string): void {
    this.metrics.observe('search_results_returned', count, { type: queryType });
  }
}

// =============================================================================
// HEALTH CHECKS
// =============================================================================

export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy'
}

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  message?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

export interface SystemHealth {
  status: HealthStatus;
  timestamp: Date;
  checks: HealthCheckResult[];
  uptime: number;
  version: string;
}

export class HealthChecker {
  private checks: Map<string, () => Promise<HealthCheckResult>> = new Map();
  private logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    this.checks.set('memory', this.checkMemory.bind(this));
    this.checks.set('process', this.checkProcess.bind(this));
  }

  registerCheck(name: string, check: () => Promise<HealthCheckResult>): void {
    this.checks.set(name, check);
  }

  async checkHealth(): Promise<SystemHealth> {
    const startTime = performance.now();
    const results: HealthCheckResult[] = [];
    
    this.logger.debug('Starting health check');

    for (const [name, check] of this.checks) {
      try {
        const checkStartTime = performance.now();
        const result = await check();
        result.duration = Math.round(performance.now() - checkStartTime);
        results.push(result);
      } catch (error) {
        results.push({
          name,
          status: HealthStatus.UNHEALTHY,
          message: error instanceof Error ? error.message : 'Health check failed',
          duration: Math.round(performance.now() - startTime)
        });
      }
    }

    const overallStatus = this.determineOverallStatus(results);
    const totalDuration = Math.round(performance.now() - startTime);

    const health: SystemHealth = {
      status: overallStatus,
      timestamp: new Date(),
      checks: results,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0'
    };

    this.logger.info('Health check completed', {
      operation: 'health_check',
      duration: totalDuration,
      metadata: { status: overallStatus, checks: results.length }
    });

    return health;
  }

  private determineOverallStatus(results: HealthCheckResult[]): HealthStatus {
    const unhealthyCount = results.filter(r => r.status === HealthStatus.UNHEALTHY).length;
    const degradedCount = results.filter(r => r.status === HealthStatus.DEGRADED).length;

    if (unhealthyCount > 0) {
      return HealthStatus.UNHEALTHY;
    } else if (degradedCount > 0) {
      return HealthStatus.DEGRADED;
    }
    
    return HealthStatus.HEALTHY;
  }

  private async checkMemory(): Promise<HealthCheckResult> {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    
    let status = HealthStatus.HEALTHY;
    let message = `Heap: ${heapUsedMB}MB/${heapTotalMB}MB`;

    if (heapUsedMB > 1500) { // > 1.5GB
      status = HealthStatus.UNHEALTHY;
      message += ' (Critical memory usage)';
    } else if (heapUsedMB > 1000) { // > 1GB
      status = HealthStatus.DEGRADED;
      message += ' (High memory usage)';
    }

    return {
      name: 'memory',
      status,
      message,
      metadata: {
        heapUsed: heapUsedMB,
        heapTotal: heapTotalMB,
        rss: Math.round(memUsage.rss / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      }
    };
  }

  private async checkProcess(): Promise<HealthCheckResult> {
    const uptime = process.uptime();
    const cpuUsage = process.cpuUsage();
    
    return {
      name: 'process',
      status: HealthStatus.HEALTHY,
      message: `Uptime: ${Math.round(uptime)}s`,
      metadata: {
        uptime,
        pid: process.pid,
        nodeVersion: process.version,
        cpuUsage: {
          user: cpuUsage.user,
          system: cpuUsage.system
        }
      }
    };
  }
}

// =============================================================================
// SINGLETON INSTANCES
// =============================================================================

export const logger = new StructuredLogger({
  service: 'code-indexer-mcp',
  version: process.env.npm_package_version || '1.0.0',
  environment: process.env.NODE_ENV || 'development',
  logLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
  enableConsole: process.env.NODE_ENV !== 'production',
  enableFile: process.env.NODE_ENV === 'production',
  logDir: process.env.LOG_DIR || './logs'
});

export const metrics = new MetricsCollector();
export const appMetrics = new ApplicationMetrics(metrics, logger);
export const healthChecker = new HealthChecker(logger);

// Set up metrics collection interval with cleanup
let metricsInterval: NodeJS.Timeout | null = null;

if (process.env.NODE_ENV === 'production' || process.env.ENABLE_METRICS === 'true') {
  metricsInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    metrics.set('memory_usage_bytes', memUsage.heapUsed, { type: 'heap_used' });
    metrics.set('memory_usage_bytes', memUsage.heapTotal, { type: 'heap_total' });
    metrics.set('memory_usage_bytes', memUsage.rss, { type: 'rss' });
  }, 15000); // Every 15 seconds
}

// Cleanup on shutdown
process.on('SIGTERM', () => {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
});

process.on('SIGINT', () => {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
});