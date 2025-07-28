/**
 * Feature Analyzer
 * Analyzes feature requirements and maps them to code locations using the graph
 */

import { GraphQueryEngine } from './graph/graph-query-engine.js';
import { GraphStorageEngine } from './graph/graph-storage.js';
import { EmbeddingService } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { SearchService } from './search-service.js';
import { NodeType, EdgeType, GraphNode } from './graph/types.js';
import { createClient } from '@supabase/supabase-js';
import { supabaseConfig } from './config.js';

export interface FeatureRequirement {
  title: string;
  description: string;
  components: string[];
  functionalAreas: string[];
  technicalRequirements?: string[];
  dependencies?: string[];
}

export interface CodeLocation {
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string;
  nodeType?: NodeType;
  context?: string;
}

export interface FeatureImplementationPlan {
  requirement: FeatureRequirement;
  affectedLocations: CodeLocation[];
  impactAnalysis: {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    affectedFiles: string[];
    bottlenecks: string[];
    circularDependencies: boolean;
  };
  implementationSteps: ImplementationStep[];
  prompt: string;
}

export interface ImplementationStep {
  order: number;
  action: 'CREATE' | 'MODIFY' | 'DELETE';
  target: CodeLocation;
  description: string;
  dependencies: number[]; // references to other steps
}

export class FeatureAnalyzer {
  private queryEngine: GraphQueryEngine;
  private storage: GraphStorageEngine;
  private embeddings: EmbeddingService;
  private searchService: SearchService;
  private vectorStore: VectorStore;
  private supabase;

  constructor() {
    this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    this.storage = new GraphStorageEngine(this.supabase);
    this.queryEngine = new GraphQueryEngine(this.storage);
    this.embeddings = new EmbeddingService();
    this.searchService = new SearchService();
    this.vectorStore = new VectorStore();
  }

  /**
   * Analyze feature requirements and generate implementation plan
   */
  async analyzeFeature(
    projectName: string,
    requirement: FeatureRequirement
  ): Promise<FeatureImplementationPlan> {
    
    // 1. Get project info
    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project "${projectName}" not found`);
    }

    // 2. Find relevant code locations using semantic search
    const affectedLocations = await this.findRelevantCodeLocations(
      projectName, 
      requirement
    );

    // 3. Analyze impact of changes
    const impactAnalysis = await this.analyzeImpact(
      project.id,
      affectedLocations
    );

    // 4. Generate implementation steps
    const implementationSteps = await this.generateImplementationSteps(
      requirement,
      affectedLocations
    );

    // 5. Create comprehensive prompt
    const prompt = await this.generateImplementationPrompt(
      requirement,
      affectedLocations,
      implementationSteps,
      impactAnalysis
    );

    return {
      requirement,
      affectedLocations,
      impactAnalysis,
      implementationSteps,
      prompt
    };
  }

  /**
   * Find code locations relevant to the feature using multiple search strategies
   */
  private async findRelevantCodeLocations(
    projectName: string,
    requirement: FeatureRequirement
  ): Promise<CodeLocation[]> {
    const locations: CodeLocation[] = [];
    const processedFiles = new Set<string>();

    // Strategy 1: Semantic search in code chunks
    const semanticResults = await this.searchSemantically(projectName, requirement);
    for (const result of semanticResults) {
      locations.push({
        filePath: result.chunk.filePath,
        startLine: result.chunk.startLine,
        endLine: result.chunk.endLine,
        context: `Semantic match: ${result.similarity.toFixed(3)} - ${result.chunk.content.slice(0, 100)}...`
      });
      processedFiles.add(result.chunk.filePath);
    }

    // Strategy 2: Graph-based component search
    const graphResults = await this.searchInGraph(projectName, requirement);
    for (const node of graphResults) {
      if (!processedFiles.has(node.location.filePath)) {
        locations.push({
          filePath: node.location.filePath,
          startLine: node.location.startLine,
          endLine: node.location.endLine,
          nodeId: node.id,
          nodeType: node.nodeType,
          context: `Graph match: ${node.name} (${node.nodeType}) - ${node.purpose || 'No description'}`
        });
        processedFiles.add(node.location.filePath);
      }
    }

    // Strategy 3: Find related components through relationships
    const relatedComponents = await this.findRelatedComponents(projectName, graphResults);
    for (const node of relatedComponents) {
      if (!processedFiles.has(node.location.filePath)) {
        locations.push({
          filePath: node.location.filePath,
          startLine: node.location.startLine,
          endLine: node.location.endLine,
          nodeId: node.id,
          nodeType: node.nodeType,
          context: `Related component: ${node.name} (${node.nodeType})`
        });
        processedFiles.add(node.location.filePath);
      }
    }

    return locations.slice(0, 20); // Limit to most relevant
  }

  /**
   * Semantic search using embeddings
   */
  private async searchSemantically(
    projectName: string,
    requirement: FeatureRequirement
  ): Promise<any[]> {
    const searchQueries = [
      requirement.description,
      ...requirement.components,
      ...requirement.functionalAreas,
      ...(requirement.technicalRequirements || [])
    ];

    const allResults: any[] = [];
    
    for (const query of searchQueries) {
      try {
        const results = await this.searchService.searchCode(
          query,
          5, // limit per query
          0.6, // lower threshold for more results
          undefined,
          (await this.vectorStore.getProjectByName(projectName))?.id
        );
        allResults.push(...results);
      } catch (error) {
        console.warn(`Search failed for query: ${query}`, error);
      }
    }

    // Deduplicate and sort by similarity
    const uniqueResults = allResults
      .filter((result, index, self) => 
        index === self.findIndex(r => 
          r.chunk.filePath === result.chunk.filePath && 
          r.chunk.startLine === result.chunk.startLine
        )
      )
      .sort((a, b) => b.similarity - a.similarity);

    return uniqueResults.slice(0, 10);
  }

  /**
   * Search in the code property graph
   */
  private async searchInGraph(
    projectName: string,
    requirement: FeatureRequirement
  ): Promise<GraphNode[]> {
    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) return [];

    const searchTerms = [
      ...requirement.components,
      ...requirement.functionalAreas.map(area => area.toLowerCase())
    ];

    const foundNodes: GraphNode[] = [];

    for (const term of searchTerms) {
      try {
        const results = await this.queryEngine.searchNodes(
          project.id,
          term,
          {
            nodeTypes: [NodeType.FUNCTION, NodeType.CLASS, NodeType.MODULE],
            limit: 5,
            fuzzyThreshold: 0.3
          }
        );
        
        foundNodes.push(...results.map(r => r.node));
      } catch (error) {
        console.warn(`Graph search failed for term: ${term}`, error);
      }
    }

    return foundNodes;
  }

  /**
   * Find components related to the initial matches
   */
  private async findRelatedComponents(
    projectName: string,
    initialNodes: GraphNode[]
  ): Promise<GraphNode[]> {
    const relatedNodes: GraphNode[] = [];

    for (const node of initialNodes) {
      try {
        // Find callers and callees
        const callers = await this.queryEngine.findCallers(node.id);
        const callees = await this.queryEngine.findCallees(node.id);
        
        relatedNodes.push(...callers, ...callees);
      } catch (error) {
        console.warn(`Failed to find relationships for node: ${node.name}`, error);
      }
    }

    return relatedNodes;
  }

  /**
   * Analyze impact of potential changes
   */
  private async analyzeImpact(
    projectId: string,
    locations: CodeLocation[]
  ): Promise<any> {
    const affectedFiles = [...new Set(locations.map(loc => loc.filePath))];
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    const bottlenecks: string[] = [];

    // Check if any locations are bottlenecks
    const bottleneckResults = await this.queryEngine.findBottlenecks(projectId);
    
    for (const location of locations) {
      if (location.nodeId) {
        const bottleneck = bottleneckResults.find(b => b.node.id === location.nodeId);
        if (bottleneck) {
          bottlenecks.push(`${bottleneck.node.name} (centrality: ${bottleneck.centrality.toFixed(2)})`);
          if (bottleneck.centrality > 50) riskLevel = 'HIGH';
          else if (bottleneck.centrality > 20) riskLevel = 'MEDIUM';
        }
      }
    }

    // Check for circular dependencies
    const cycles = await this.queryEngine.findCircularDependencies(projectId);

    return {
      riskLevel,
      affectedFiles,
      bottlenecks,
      circularDependencies: cycles.length > 0
    };
  }

  /**
   * Generate ordered implementation steps
   */
  private async generateImplementationSteps(
    requirement: FeatureRequirement,
    locations: CodeLocation[]
  ): Promise<ImplementationStep[]> {
    const steps: ImplementationStep[] = [];
    let order = 1;

    // Group locations by file and action type
    const fileGroups = new Map<string, CodeLocation[]>();
    for (const location of locations) {
      if (!fileGroups.has(location.filePath)) {
        fileGroups.set(location.filePath, []);
      }
      fileGroups.get(location.filePath)!.push(location);
    }

    // Generate steps for each file
    for (const [filePath, fileLocations] of fileGroups) {
      for (const location of fileLocations) {
        steps.push({
          order: order++,
          action: 'MODIFY', // Default to modify, could be smarter
          target: location,
          description: `Implement ${requirement.title} changes in ${location.context || 'this location'}`,
          dependencies: []
        });
      }
    }

    return steps;
  }

  /**
   * Generate comprehensive implementation prompt
   */
  private async generateImplementationPrompt(
    requirement: FeatureRequirement,
    locations: CodeLocation[],
    steps: ImplementationStep[],
    impact: any
  ): Promise<string> {
    let prompt = `# Feature Implementation: ${requirement.title}\n\n`;
    
    prompt += `## Requirements\n${requirement.description}\n\n`;
    
    if (requirement.components.length > 0) {
      prompt += `**Components:** ${requirement.components.join(', ')}\n`;
    }
    
    if (requirement.functionalAreas.length > 0) {
      prompt += `**Functional Areas:** ${requirement.functionalAreas.join(', ')}\n\n`;
    }

    prompt += `## Impact Analysis\n`;
    prompt += `- **Risk Level:** ${impact.riskLevel}\n`;
    prompt += `- **Files to Modify:** ${impact.affectedFiles.length}\n`;
    if (impact.bottlenecks.length > 0) {
      prompt += `- **⚠️ Bottlenecks Affected:** ${impact.bottlenecks.join(', ')}\n`;
    }
    prompt += `- **Circular Dependencies:** ${impact.circularDependencies ? '⚠️ Present' : '✅ None'}\n\n`;

    prompt += `## Code Locations to Modify\n\n`;
    
    for (let i = 0; i < locations.length; i++) {
      const location = locations[i];
      prompt += `### ${i + 1}. ${location.filePath}\n`;
      
      if (location.startLine && location.endLine) {
        prompt += `**Lines:** ${location.startLine}-${location.endLine}\n`;
      }
      
      if (location.nodeType) {
        prompt += `**Type:** ${location.nodeType}\n`;
      }
      
      if (location.context) {
        prompt += `**Context:** ${location.context}\n`;
      }
      
      prompt += `**Reference:** \`${location.filePath}:${location.startLine || 1}\`\n\n`;
    }

    prompt += `## Implementation Steps\n\n`;
    for (const step of steps) {
      prompt += `${step.order}. **${step.action}** ${step.target.filePath}\n`;
      prompt += `   ${step.description}\n\n`;
    }

    prompt += `## Instructions\n`;
    prompt += `Please implement the feature by modifying the code locations listed above. `;
    prompt += `Use the provided file references (\`file:line\`) to navigate to the exact locations. `;
    
    if (impact.riskLevel === 'HIGH') {
      prompt += `⚠️ **HIGH RISK:** This change affects critical bottlenecks. Test thoroughly after each modification.`;
    }

    return prompt;
  }
}