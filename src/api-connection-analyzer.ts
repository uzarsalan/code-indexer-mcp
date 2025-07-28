/**
 * API Connection Analyzer
 * Detects and maps connections between frontend API calls and backend handlers
 */

import { ASTAnalyzer, ASTNode } from './ast-analyzer.js';
import { GraphNode, GraphEdge, EdgeType } from './graph/types.js';

export interface APICall {
  method: string; // GET, POST, PUT, DELETE
  endpoint: string; // /api/projects/:id/graph
  location: {
    filePath: string;
    startLine: number;
    endLine: number;
  };
  callType: 'fetch' | 'axios' | 'xhr' | 'other';
  parameters?: string[];
  context?: string; // surrounding function/method
}

export interface APIHandler {
  method: string;
  endpoint: string;
  handlerFunction: string;
  location: {
    filePath: string;
    startLine: number;
    endLine: number;
  };
  middleware?: string[];
  parameters?: string[];
}

export interface APIConnection {
  frontendCall: APICall;
  backendHandler: APIHandler;
  confidence: number; // 0.0 - 1.0
  matchReason: string;
}

export class APIConnectionAnalyzer {
  private astAnalyzer: ASTAnalyzer;
  private detectedCalls: Map<string, APICall[]> = new Map();
  private detectedHandlers: Map<string, APIHandler[]> = new Map();

  constructor(astAnalyzer: ASTAnalyzer) {
    this.astAnalyzer = astAnalyzer;
  }

  /**
   * Analyze a file for API calls (frontend) and handlers (backend)
   */
  async analyzeFile(filePath: string, content: string): Promise<{
    apiCalls: APICall[];
    apiHandlers: APIHandler[];
  }> {
    const language = this.getLanguageFromPath(filePath);
    const ast = await this.astAnalyzer.parseCode(content, language);

    const apiCalls = this.extractAPICalls(ast, filePath, content);
    const apiHandlers = this.extractAPIHandlers(ast, filePath, content);

    // Cache results
    this.detectedCalls.set(filePath, apiCalls);
    this.detectedHandlers.set(filePath, apiHandlers);

    return { apiCalls, apiHandlers };
  }

  /**
   * Extract frontend API calls from AST
   */
  private extractAPICalls(ast: ASTNode, filePath: string, content: string): APICall[] {
    const calls: APICall[] = [];
    const lines = content.split('\n');

    this.traverseAST(ast, (node) => {
      // Look for fetch() calls
      if (this.isFetchCall(node)) {
        const call = this.extractFetchCall(node, filePath, lines);
        if (call) calls.push(call);
      }
      
      // Look for axios calls
      if (this.isAxiosCall(node)) {
        const call = this.extractAxiosCall(node, filePath, lines);
        if (call) calls.push(call);
      }

      // Look for XMLHttpRequest
      if (this.isXHRCall(node)) {
        const call = this.extractXHRCall(node, filePath, lines);
        if (call) calls.push(call);
      }
    });

    return calls;
  }

  /**
   * Extract backend API handlers from AST
   */
  private extractAPIHandlers(ast: ASTNode, filePath: string, content: string): APIHandler[] {
    const handlers: APIHandler[] = [];
    const lines = content.split('\n');

    this.traverseAST(ast, (node) => {
      // Look for Express route definitions
      if (this.isExpressRoute(node)) {
        const handler = this.extractExpressRoute(node, filePath, lines);
        if (handler) handlers.push(handler);
      }

      // Look for Fastify route definitions
      if (this.isFastifyRoute(node)) {
        const handler = this.extractFastifyRoute(node, filePath, lines);
        if (handler) handlers.push(handler);
      }

      // Look for other framework routes (Koa, Hapi, etc.)
      if (this.isOtherFrameworkRoute(node)) {
        const handler = this.extractOtherFrameworkRoute(node, filePath, lines);
        if (handler) handlers.push(handler);
      }
    });

    return handlers;
  }

  /**
   * Match frontend calls with backend handlers
   */
  findAPIConnections(): APIConnection[] {
    const connections: APIConnection[] = [];
    
    // Get all detected calls and handlers
    const allCalls = Array.from(this.detectedCalls.values()).flat();
    const allHandlers = Array.from(this.detectedHandlers.values()).flat();

    for (const call of allCalls) {
      for (const handler of allHandlers) {
        const match = this.matchCallToHandler(call, handler);
        if (match.confidence > 0.7) { // Only high-confidence matches
          connections.push({
            frontendCall: call,
            backendHandler: handler,
            confidence: match.confidence,
            matchReason: match.reason
          });
        }
      }
    }

    return connections;
  }

  /**
   * Match a frontend call to a backend handler
   */
  private matchCallToHandler(call: APICall, handler: APIHandler): { 
    confidence: number; 
    reason: string; 
  } {
    let confidence = 0;
    const reasons: string[] = [];

    // Method match
    if (call.method.toUpperCase() === handler.method.toUpperCase()) {
      confidence += 0.3;
      reasons.push('HTTP method match');
    }

    // Endpoint match
    const endpointMatch = this.matchEndpoints(call.endpoint, handler.endpoint);
    confidence += endpointMatch.score;
    if (endpointMatch.score > 0) {
      reasons.push(endpointMatch.reason);
    }

    // Parameter match
    if (call.parameters && handler.parameters) {
      const paramMatch = this.matchParameters(call.parameters, handler.parameters);
      confidence += paramMatch * 0.2;
      if (paramMatch > 0.5) {
        reasons.push('Parameter similarity');
      }
    }

    return {
      confidence: Math.min(1.0, confidence),
      reason: reasons.join(', ')
    };
  }

  /**
   * Match endpoints considering URL parameters
   */
  private matchEndpoints(callEndpoint: string, handlerEndpoint: string): {
    score: number;
    reason: string;
  } {
    // Exact match
    if (callEndpoint === handlerEndpoint) {
      return { score: 0.5, reason: 'Exact endpoint match' };
    }

    // Parameter substitution match
    // e.g., /api/projects/123/graph matches /api/projects/:id/graph
    const normalizedCall = this.normalizeEndpoint(callEndpoint);
    const normalizedHandler = this.normalizeEndpoint(handlerEndpoint);
    
    if (normalizedCall === normalizedHandler) {
      return { score: 0.4, reason: 'Parameterized endpoint match' };
    }

    // Partial match
    const callParts = callEndpoint.split('/').filter(p => p);
    const handlerParts = handlerEndpoint.split('/').filter(p => p);
    
    if (callParts.length !== handlerParts.length) {
      return { score: 0, reason: 'Different endpoint structure' };
    }

    let matchedParts = 0;
    for (let i = 0; i < callParts.length; i++) {
      if (callParts[i] === handlerParts[i] || 
          handlerParts[i].startsWith(':') || 
          /^\d+$/.test(callParts[i])) {
        matchedParts++;
      }
    }

    const partialScore = matchedParts / callParts.length * 0.3;
    return { 
      score: partialScore, 
      reason: `Partial endpoint match (${matchedParts}/${callParts.length} parts)` 
    };
  }

  /**
   * Generate graph edges for API connections
   */
  generateAPIConnectionEdges(connections: APIConnection[]): GraphEdge[] {
    const edges: GraphEdge[] = [];

    for (const connection of connections) {
      // Create edge from frontend call site to backend handler
      edges.push({
        id: `api-connection-${Date.now()}-${Math.random()}`,
        projectId: '', // Will be set by caller
        versionId: '', // Will be set by caller
        sourceNodeId: '', // Frontend node ID (from call location)
        targetNodeId: '', // Backend handler node ID
        edgeType: EdgeType.CALLS,
        properties: {
          connectionType: 'api_call',
          method: connection.frontendCall.method,
          endpoint: connection.frontendCall.endpoint,
          confidence: connection.confidence,
          matchReason: connection.matchReason,
          callType: connection.frontendCall.callType
        },
        weight: connection.confidence,
        createdAt: new Date()
      });
    }

    return edges;
  }

  // Helper methods for AST analysis
  private isFetchCall(node: ASTNode): boolean {
    return node.type === 'call_expression' && 
           node.text.includes('fetch(');
  }

  private isAxiosCall(node: ASTNode): boolean {
    return node.type === 'call_expression' && 
           (node.text.includes('axios.') || node.text.includes('axios('));
  }

  private isXHRCall(node: ASTNode): boolean {
    return node.text.includes('XMLHttpRequest') || 
           node.text.includes('new XMLHttpRequest');
  }

  private isExpressRoute(node: ASTNode): boolean {
    return node.type === 'call_expression' && 
           /app\.(get|post|put|delete|patch)\s*\(/.test(node.text);
  }

  private isFastifyRoute(node: ASTNode): boolean {
    return node.type === 'call_expression' && 
           /fastify\.(get|post|put|delete|patch)\s*\(/.test(node.text);
  }

  private isOtherFrameworkRoute(node: ASTNode): boolean {
    return node.type === 'call_expression' && 
           /router\.(get|post|put|delete|patch)\s*\(/.test(node.text);
  }

  private extractFetchCall(node: ASTNode, filePath: string, lines: string[]): APICall | null {
    try {
      const text = node.text;
      const fetchMatch = /fetch\s*\(\s*['"`]([^'"`]+)['"`]/.exec(text);
      
      if (!fetchMatch) return null;

      const endpoint = fetchMatch[1];
      const method = this.extractHTTPMethod(text) || 'GET';

      return {
        method,
        endpoint,
        location: {
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1
        },
        callType: 'fetch',
        context: this.findContainingFunction(node, lines)
      };
    } catch (error) {
      return null;
    }
  }

  private extractExpressRoute(node: ASTNode, filePath: string, lines: string[]): APIHandler | null {
    try {
      const text = node.text;
      const routeMatch = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/.exec(text);
      
      if (!routeMatch) return null;

      const method = routeMatch[1].toUpperCase();
      const endpoint = routeMatch[2];

      return {
        method,
        endpoint,
        handlerFunction: this.extractHandlerFunctionName(text),
        location: {
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1
        }
      };
    } catch (error) {
      return null;
    }
  }

  private extractHTTPMethod(text: string): string | null {
    const methodMatch = /method\s*:\s*['"`](\w+)['"`]/.exec(text);
    return methodMatch ? methodMatch[1].toUpperCase() : null;
  }

  private extractHandlerFunctionName(text: string): string {
    // Try to extract handler function name from route definition
    const handlerMatch = /,\s*(\w+)(?:\.\w+)?\s*\)/.exec(text);
    return handlerMatch ? handlerMatch[1] : 'anonymous';
  }

  private findContainingFunction(node: ASTNode, lines: string[]): string | undefined {
    // Simple heuristic to find containing function
    const startLine = Math.max(0, node.startPosition.row - 10);
    const endLine = Math.min(lines.length, node.startPosition.row);
    
    for (let i = endLine - 1; i >= startLine; i--) {
      const line = lines[i];
      const funcMatch = /(?:function\s+(\w+)|(\w+)\s*:\s*(?:async\s+)?function|(\w+)\s*\([^)]*\)\s*\{)/.exec(line);
      if (funcMatch) {
        return funcMatch[1] || funcMatch[2] || funcMatch[3];
      }
    }
    
    return undefined;
  }

  private normalizeEndpoint(endpoint: string): string {
    // Replace numeric IDs and UUIDs with placeholders
    return endpoint
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9-]{36}/g, '/:uuid')
      .replace(/\/[a-f0-9]{24}/g, '/:objectid');
  }

  private matchParameters(callParams: string[], handlerParams: string[]): number {
    if (callParams.length === 0 && handlerParams.length === 0) return 1.0;
    if (callParams.length === 0 || handlerParams.length === 0) return 0.0;

    const intersection = callParams.filter(p => handlerParams.includes(p));
    return intersection.length / Math.max(callParams.length, handlerParams.length);
  }

  private traverseAST(node: ASTNode, callback: (node: ASTNode) => void): void {
    callback(node);
    if (node.children) {
      for (const child of node.children) {
        this.traverseAST(child, callback);
      }
    }
  }

  private getLanguageFromPath(filePath: string): string {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
    if (filePath.endsWith('.html')) return 'html';
    return 'javascript'; // default
  }

  // Additional extraction methods for other frameworks...
  private extractAxiosCall(node: ASTNode, filePath: string, lines: string[]): APICall | null {
    // Implementation for axios calls
    return null;
  }

  private extractXHRCall(node: ASTNode, filePath: string, lines: string[]): APICall | null {
    // Implementation for XMLHttpRequest
    return null;
  }

  private extractFastifyRoute(node: ASTNode, filePath: string, lines: string[]): APIHandler | null {
    // Implementation for Fastify routes
    return null;
  }

  private extractOtherFrameworkRoute(node: ASTNode, filePath: string, lines: string[]): APIHandler | null {
    // Implementation for other frameworks
    return null;
  }
}