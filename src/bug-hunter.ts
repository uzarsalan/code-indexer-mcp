/**
 * Bug Hunter
 * Automated bug analysis and root cause detection using code property graph
 */

import { GraphQueryEngine } from './graph/graph-query-engine.js';
import { GraphStorageEngine } from './graph/graph-storage.js';
import { EmbeddingService } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { SearchService } from './search-service.js';
import { NodeType, EdgeType, GraphNode } from './graph/types.js';
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config.js';

export interface BugReport {
  title: string;
  description: string;
  errorMessage?: string;
  stackTrace?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  stepsToReproduce?: string[];
  environment?: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface SuspiciousLocation {
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string;
  nodeType?: NodeType;
  suspicionScore: number;
  reason: string;
  evidence: string[];
  relatedNodes?: GraphNode[];
}

export interface BugPattern {
  name: string;
  description: string;
  indicators: string[];
  commonCauses: string[];
  searchTerms: string[];
}

export interface RootCauseAnalysis {
  bugReport: BugReport;
  suspiciousLocations: SuspiciousLocation[];
  relatedPatterns: BugPattern[];
  analysisSteps: AnalysisStep[];
  recommendedActions: RecommendedAction[];
  investigationPrompt: string;
}

export interface AnalysisStep {
  order: number;
  action: string;
  target: SuspiciousLocation;
  reasoning: string;
  confidence: number;
}

export interface RecommendedAction {
  type: 'INVESTIGATE' | 'FIX' | 'TEST' | 'REVIEW';
  description: string;
  priority: number;
  files: string[];
  estimatedEffort: 'LOW' | 'MEDIUM' | 'HIGH';
}

export class BugHunter {
  private queryEngine: GraphQueryEngine;
  private storage: GraphStorageEngine;
  private embeddings: EmbeddingService;
  private searchService: SearchService;
  private vectorStore: VectorStore;
  private supabase;

  // Common bug patterns
  private readonly BUG_PATTERNS: BugPattern[] = [
    {
      name: 'Null Pointer/Undefined Reference',
      description: 'Accessing properties or methods on null/undefined values',
      indicators: ['Cannot read property', 'undefined is not', 'null pointer', 'TypeError'],
      commonCauses: ['Missing null checks', 'Async timing issues', 'Initialization problems'],
      searchTerms: ['null', 'undefined', 'optional', 'nullable', 'check']
    },
    {
      name: 'Async/Promise Issues',
      description: 'Problems with asynchronous code execution',
      indicators: ['Promise', 'async', 'await', 'callback', 'timeout', 'race condition'],
      commonCauses: ['Missing await', 'Unhandled rejections', 'Callback hell', 'Race conditions'],
      searchTerms: ['async', 'await', 'promise', 'callback', 'timeout', 'race']
    },
    {
      name: 'Memory Leaks',
      description: 'Memory not being properly released',
      indicators: ['memory', 'leak', 'heap', 'garbage', 'out of memory'],
      commonCauses: ['Event listeners not removed', 'Circular references', 'Unclosed resources'],
      searchTerms: ['memory', 'cleanup', 'dispose', 'remove', 'close', 'listener']
    },
    {
      name: 'API/Network Issues',
      description: 'Problems with external API calls or network requests',
      indicators: ['fetch', 'request', 'response', 'network', 'timeout', '404', '500'],
      commonCauses: ['Missing error handling', 'Incorrect endpoints', 'Network timeouts'],
      searchTerms: ['fetch', 'request', 'api', 'network', 'error', 'catch']
    },
    {
      name: 'Type Mismatch',
      description: 'Incorrect data types being used',
      indicators: ['type', 'expected', 'string', 'number', 'object', 'array'],
      commonCauses: ['Incorrect type assumptions', 'Missing type validation', 'API contract changes'],
      searchTerms: ['type', 'typeof', 'instanceof', 'validate', 'cast', 'convert']
    },
    {
      name: 'Infinite Loop/Recursion',
      description: 'Code getting stuck in endless loops',
      indicators: ['infinite', 'loop', 'recursion', 'stack overflow', 'maximum call stack'],
      commonCauses: ['Missing loop conditions', 'Incorrect recursion base case', 'Logic errors'],
      searchTerms: ['loop', 'while', 'for', 'recursive', 'break', 'continue']
    },
    {
      name: 'Concurrency Issues',
      description: 'Problems with concurrent access to shared resources',
      indicators: ['race', 'deadlock', 'concurrent', 'mutex', 'lock', 'synchronization'],
      commonCauses: ['Missing synchronization', 'Improper locking', 'Race conditions'],
      searchTerms: ['lock', 'mutex', 'atomic', 'concurrent', 'sync', 'parallel']
    }
  ];

  constructor() {
    this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    this.storage = new GraphStorageEngine(this.supabase);
    this.queryEngine = new GraphQueryEngine(this.storage);
    this.embeddings = new EmbeddingService();
    this.searchService = new SearchService();
    this.vectorStore = new VectorStore();
  }

  /**
   * Analyze a bug report and find potential root causes
   */
  async huntBug(
    projectName: string,
    bugReport: BugReport
  ): Promise<RootCauseAnalysis> {
    
    // 1. Get project info
    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project "${projectName}" not found`);
    }

    // 2. Identify relevant bug patterns
    const relatedPatterns = this.identifyBugPatterns(bugReport);

    // 3. Find suspicious code locations
    const suspiciousLocations = await this.findSuspiciousLocations(
      projectName,
      bugReport,
      relatedPatterns
    );

    // 4. Perform deeper analysis on top suspects
    const enhancedLocations = await this.enhanceSuspiciousLocations(
      project.id,
      suspiciousLocations
    );

    // 5. Generate analysis steps
    const analysisSteps = this.generateAnalysisSteps(enhancedLocations);

    // 6. Create recommended actions
    const recommendedActions = this.generateRecommendedActions(
      bugReport,
      enhancedLocations,
      relatedPatterns
    );

    // 7. Generate investigation prompt
    const investigationPrompt = this.generateInvestigationPrompt(
      bugReport,
      enhancedLocations,
      analysisSteps,
      recommendedActions
    );

    return {
      bugReport,
      suspiciousLocations: enhancedLocations,
      relatedPatterns,
      analysisSteps,
      recommendedActions,
      investigationPrompt
    };
  }

  /**
   * Identify bug patterns that match the reported issue
   */
  private identifyBugPatterns(bugReport: BugReport): BugPattern[] {
    const matchingPatterns: { pattern: BugPattern; score: number }[] = [];
    
    const searchText = [
      bugReport.title,
      bugReport.description,
      bugReport.errorMessage || '',
      bugReport.actualBehavior || '',
      ...(bugReport.stackTrace || [])
    ].join(' ').toLowerCase();

    for (const pattern of this.BUG_PATTERNS) {
      let score = 0;
      
      // Check indicators
      for (const indicator of pattern.indicators) {
        if (searchText.includes(indicator.toLowerCase())) {
          score += 2;
        }
      }

      // Check search terms
      for (const term of pattern.searchTerms) {
        if (searchText.includes(term.toLowerCase())) {
          score += 1;
        }
      }

      if (score > 0) {
        matchingPatterns.push({ pattern, score });
      }
    }

    return matchingPatterns
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(m => m.pattern);
  }

  /**
   * Find code locations that might be causing the bug
   */
  private async findSuspiciousLocations(
    projectName: string,
    bugReport: BugReport,
    patterns: BugPattern[]
  ): Promise<SuspiciousLocation[]> {
    const locations: SuspiciousLocation[] = [];
    const processedFiles = new Set<string>();

    // Strategy 1: Search by error message and stack trace
    if (bugReport.errorMessage || bugReport.stackTrace) {
      const errorLocations = await this.searchByErrorInfo(
        projectName,
        bugReport
      );
      locations.push(...errorLocations);
      errorLocations.forEach(loc => processedFiles.add(loc.filePath));
    }

    // Strategy 2: Semantic search by description
    const semanticLocations = await this.searchSemanticallySuspicious(
      projectName,
      bugReport
    );
    for (const location of semanticLocations) {
      if (!processedFiles.has(location.filePath)) {
        locations.push(location);
        processedFiles.add(location.filePath);
      }
    }

    // Strategy 3: Pattern-based search
    for (const pattern of patterns) {
      const patternLocations = await this.searchByPattern(
        projectName,
        pattern
      );
      for (const location of patternLocations) {
        if (!processedFiles.has(location.filePath)) {
          locations.push(location);
          processedFiles.add(location.filePath);
        }
      }
    }

    // Strategy 4: Graph-based analysis (find bottlenecks and high-complexity nodes)
    const graphLocations = await this.findGraphSuspects(projectName);
    for (const location of graphLocations) {
      if (!processedFiles.has(location.filePath)) {
        locations.push(location);
        processedFiles.add(location.filePath);
      }
    }

    return locations
      .sort((a, b) => b.suspicionScore - a.suspicionScore)
      .slice(0, 15);
  }

  /**
   * Search for locations based on error messages and stack traces
   */
  private async searchByErrorInfo(
    projectName: string,
    bugReport: BugReport
  ): Promise<SuspiciousLocation[]> {
    const locations: SuspiciousLocation[] = [];
    
    const searchQueries: string[] = [];
    
    if (bugReport.errorMessage) {
      // Extract key parts from error message
      const errorParts = bugReport.errorMessage
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(part => part.length > 2);
      searchQueries.push(...errorParts);
    }

    if (bugReport.stackTrace) {
      // Extract function names and file references from stack trace
      for (const frame of bugReport.stackTrace) {
        const functionMatch = frame.match(/at\s+(\w+)/);
        if (functionMatch) {
          searchQueries.push(functionMatch[1]);
        }
      }
    }

    for (const query of searchQueries.slice(0, 5)) {
      try {
        const results = await this.searchService.searchCode(
          query,
          3,
          0.5,
          undefined,
          (await this.vectorStore.getProjectByName(projectName))?.id
        );

        for (const result of results) {
          locations.push({
            filePath: result.chunk.filePath,
            startLine: result.chunk.startLine,
            endLine: result.chunk.endLine,
            suspicionScore: result.similarity * 0.9, // High weight for error-based search
            reason: 'Error message match',
            evidence: [`Query: "${query}"`, `Similarity: ${result.similarity.toFixed(3)}`]
          });
        }
      } catch (error) {
        console.warn(`Error search failed for query: ${query}`, error);
      }
    }

    return locations;
  }

  /**
   * Semantic search for suspicious locations
   */
  private async searchSemanticallySuspicious(
    projectName: string,
    bugReport: BugReport
  ): Promise<SuspiciousLocation[]> {
    const locations: SuspiciousLocation[] = [];
    
    const searchQueries = [
      bugReport.description,
      bugReport.actualBehavior || '',
      bugReport.expectedBehavior || ''
    ].filter(q => q.length > 0);

    for (const query of searchQueries) {
      try {
        const results = await this.searchService.searchCode(
          query,
          5,
          0.6,
          undefined,
          (await this.vectorStore.getProjectByName(projectName))?.id
        );

        for (const result of results) {
          locations.push({
            filePath: result.chunk.filePath,
            startLine: result.chunk.startLine,
            endLine: result.chunk.endLine,
            suspicionScore: result.similarity * 0.7,
            reason: 'Semantic similarity to bug description',
            evidence: [`Similarity: ${result.similarity.toFixed(3)}`, `Context: ${result.chunk.content.slice(0, 100)}...`]
          });
        }
      } catch (error) {
        console.warn(`Semantic search failed for query: ${query}`, error);
      }
    }

    return locations;
  }

  /**
   * Search by bug pattern indicators
   */
  private async searchByPattern(
    projectName: string,
    pattern: BugPattern
  ): Promise<SuspiciousLocation[]> {
    const locations: SuspiciousLocation[] = [];

    for (const term of pattern.searchTerms.slice(0, 3)) {
      try {
        const results = await this.searchService.searchCode(
          term,
          3,
          0.5,
          undefined,
          (await this.vectorStore.getProjectByName(projectName))?.id
        );

        for (const result of results) {
          locations.push({
            filePath: result.chunk.filePath,
            startLine: result.chunk.startLine,
            endLine: result.chunk.endLine,
            suspicionScore: result.similarity * 0.6,
            reason: `Pattern match: ${pattern.name}`,
            evidence: [`Pattern: ${pattern.name}`, `Term: "${term}"`, `Similarity: ${result.similarity.toFixed(3)}`]
          });
        }
      } catch (error) {
        console.warn(`Pattern search failed for term: ${term}`, error);
      }
    }

    return locations;
  }

  /**
   * Find suspicious locations using graph analysis
   */
  private async findGraphSuspects(projectName: string): Promise<SuspiciousLocation[]> {
    const locations: SuspiciousLocation[] = [];
    
    try {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) return locations;

      // Find bottlenecks (high-risk nodes)
      const bottlenecks = await this.queryEngine.findBottlenecks(project.id);
      
      for (const bottleneck of bottlenecks.slice(0, 5)) {
        locations.push({
          filePath: bottleneck.node.location.filePath,
          startLine: bottleneck.node.location.startLine,
          endLine: bottleneck.node.location.endLine,
          nodeId: bottleneck.node.id,
          nodeType: bottleneck.node.nodeType,
          suspicionScore: Math.min(bottleneck.centrality / 100, 0.8),
          reason: 'High-risk bottleneck',
          evidence: [
            `Centrality: ${bottleneck.centrality.toFixed(2)}`,
            `Connections: ${bottleneck.totalConnections}`,
            `Complexity: ${bottleneck.node.complexity || 'N/A'}`
          ]
        });
      }
    } catch (error) {
      console.warn('Graph suspects search failed', error);
    }

    return locations;
  }

  /**
   * Enhance suspicious locations with relationship analysis
   */
  private async enhanceSuspiciousLocations(
    projectId: string,
    locations: SuspiciousLocation[]
  ): Promise<SuspiciousLocation[]> {
    const enhanced: SuspiciousLocation[] = [];

    for (const location of locations) {
      const enhancedLocation = { ...location };
      
      if (location.nodeId) {
        try {
          // Find related nodes
          const callers = await this.queryEngine.findCallers(location.nodeId);
          const callees = await this.queryEngine.findCallees(location.nodeId);
          
          enhancedLocation.relatedNodes = [...callers, ...callees].slice(0, 5);
          
          // Boost suspicion score if it has many connections
          const connectionCount = callers.length + callees.length;
          if (connectionCount > 5) {
            enhancedLocation.suspicionScore *= 1.2;
            enhancedLocation.evidence.push(`High connectivity: ${connectionCount} connections`);
          }
        } catch (error) {
          console.warn(`Failed to enhance location: ${location.filePath}`, error);
        }
      }

      enhanced.push(enhancedLocation);
    }

    return enhanced.sort((a, b) => b.suspicionScore - a.suspicionScore);
  }

  /**
   * Generate analysis steps for investigation
   */
  private generateAnalysisSteps(locations: SuspiciousLocation[]): AnalysisStep[] {
    const steps: AnalysisStep[] = [];
    let order = 1;

    // Prioritize by suspicion score
    const sortedLocations = locations
      .sort((a, b) => b.suspicionScore - a.suspicionScore)
      .slice(0, 8);

    for (const location of sortedLocations) {
      steps.push({
        order: order++,
        action: `Investigate ${location.reason.toLowerCase()}`,
        target: location,
        reasoning: `${location.reason} - ${location.evidence.join(', ')}`,
        confidence: location.suspicionScore
      });
    }

    return steps;
  }

  /**
   * Generate recommended actions
   */
  private generateRecommendedActions(
    bugReport: BugReport,
    locations: SuspiciousLocation[],
    patterns: BugPattern[]
  ): RecommendedAction[] {
    const actions: RecommendedAction[] = [];
    
    // High priority: Investigate top suspects
    const topSuspects = locations.slice(0, 3);
    if (topSuspects.length > 0) {
      actions.push({
        type: 'INVESTIGATE',
        description: 'Examine the most suspicious code locations first',
        priority: 1,
        files: topSuspects.map(s => s.filePath),
        estimatedEffort: 'MEDIUM'
      });
    }

    // Pattern-based recommendations
    for (const pattern of patterns) {
      actions.push({
        type: 'REVIEW',
        description: `Review code for ${pattern.name} issues: ${pattern.description}`,
        priority: 2,
        files: locations.filter(l => l.reason.includes(pattern.name)).map(l => l.filePath),
        estimatedEffort: 'LOW'
      });
    }

    // Testing recommendations
    if (bugReport.stepsToReproduce) {
      actions.push({
        type: 'TEST',
        description: 'Create automated test case to reproduce the bug',
        priority: 3,
        files: [],
        estimatedEffort: 'MEDIUM'
      });
    }

    return actions.slice(0, 5);
  }

  /**
   * Generate comprehensive investigation prompt
   */
  private generateInvestigationPrompt(
    bugReport: BugReport,
    locations: SuspiciousLocation[],
    steps: AnalysisStep[],
    actions: RecommendedAction[]
  ): string {
    let prompt = `# Bug Investigation: ${bugReport.title}\n\n`;
    
    prompt += `## Bug Report\n`;
    prompt += `**Severity:** ${bugReport.severity}\n`;
    prompt += `**Description:** ${bugReport.description}\n\n`;
    
    if (bugReport.errorMessage) {
      prompt += `**Error Message:** \`${bugReport.errorMessage}\`\n\n`;
    }
    
    if (bugReport.stackTrace) {
      prompt += `**Stack Trace:**\n\`\`\`\n${bugReport.stackTrace.join('\n')}\n\`\`\`\n\n`;
    }

    if (bugReport.stepsToReproduce) {
      prompt += `**Steps to Reproduce:**\n${bugReport.stepsToReproduce.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\n`;
    }

    prompt += `## Suspicious Locations (${locations.length} found)\n\n`;
    
    for (let i = 0; i < Math.min(locations.length, 10); i++) {
      const location = locations[i];
      prompt += `### ${i + 1}. ${location.filePath} (Suspicion: ${(location.suspicionScore * 100).toFixed(1)}%)\n`;
      
      if (location.startLine && location.endLine) {
        prompt += `**Lines:** ${location.startLine}-${location.endLine}\n`;
      }
      
      prompt += `**Reason:** ${location.reason}\n`;
      prompt += `**Evidence:**\n${location.evidence.map(e => `- ${e}`).join('\n')}\n`;
      
      if (location.relatedNodes && location.relatedNodes.length > 0) {
        prompt += `**Related Components:** ${location.relatedNodes.map(n => n.name).join(', ')}\n`;
      }
      
      prompt += `**Reference:** \`${location.filePath}:${location.startLine || 1}\`\n\n`;
    }

    prompt += `## Investigation Steps\n\n`;
    for (const step of steps.slice(0, 6)) {
      prompt += `${step.order}. **${step.action}** (Confidence: ${(step.confidence * 100).toFixed(1)}%)\n`;
      prompt += `   ${step.reasoning}\n`;
      prompt += `   → Check: \`${step.target.filePath}:${step.target.startLine || 1}\`\n\n`;
    }

    prompt += `## Recommended Actions\n\n`;
    for (const action of actions) {
      prompt += `### ${action.type}: ${action.description}\n`;
      prompt += `**Priority:** ${action.priority} | **Effort:** ${action.estimatedEffort}\n`;
      if (action.files.length > 0) {
        prompt += `**Files:** ${action.files.slice(0, 3).join(', ')}${action.files.length > 3 ? '...' : ''}\n`;
      }
      prompt += '\n';
    }

    prompt += `## Investigation Instructions\n`;
    prompt += `1. Start with the highest suspicion locations first\n`;
    prompt += `2. Use the provided file references (\`file:line\`) to navigate to exact locations\n`;
    prompt += `3. Look for the specific patterns and evidence mentioned\n`;
    prompt += `4. Check related components and their interactions\n`;
    
    if (bugReport.severity === 'CRITICAL' || bugReport.severity === 'HIGH') {
      prompt += `\n⚠️ **${bugReport.severity} SEVERITY:** Prioritize this investigation and consider immediate workarounds.`;
    }

    return prompt;
  }
}