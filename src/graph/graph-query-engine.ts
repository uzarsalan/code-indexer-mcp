/**
 * Graph Query Engine
 * Advanced querying capabilities for the Code Property Graph
 */

import { GraphStorageEngine } from './graph-storage.js';
import { 
  GraphNode, GraphEdge, NodeId, EdgeId, ProjectId,
  NodeQuery, EdgeQuery, TraversalOptions,
  PathSearchResult, NodeSearchResult, CircularDependency,
  ImpactAnalysis, QueryResult, EdgeType, NodeType
} from './types.js';

export class GraphQueryEngine {
  constructor(private storage: GraphStorageEngine) {}

  // ============================================================================
  // BASIC QUERIES
  // ============================================================================

  async findNodesByName(
    projectId: ProjectId, 
    name: string, 
    options?: { fuzzy?: boolean; nodeType?: NodeType }
  ): Promise<NodeSearchResult[]> {
    const query: NodeQuery = {
      projectId,
      nodeType: options?.nodeType,
      limit: 50
    };

    if (options?.fuzzy) {
      query.pattern = name;
    } else {
      query.name = name;
    }

    const result = await this.storage.queryNodes(query);
    
    return result.data.map(node => ({
      node,
      similarity: options?.fuzzy ? this.calculateNameSimilarity(node.name || '', name) : 1.0,
      matchReason: options?.fuzzy ? 'fuzzy_name_match' : 'exact_name_match'
    }));
  }

  async findNodesInFile(
    projectId: ProjectId, 
    filePath: string
  ): Promise<GraphNode[]> {
    const result = await this.storage.queryNodes({
      projectId,
      filePath,
      limit: 1000
    });

    return result.data;
  }

  async findNodesByType(
    projectId: ProjectId,
    nodeType: NodeType,
    limit = 100
  ): Promise<GraphNode[]> {
    const result = await this.storage.queryNodes({
      projectId,
      nodeType,
      limit
    });

    return result.data;
  }

  // ============================================================================
  // RELATIONSHIP QUERIES
  // ============================================================================

  async findCallers(nodeId: NodeId): Promise<GraphNode[]> {
    // Find all nodes that call this function
    const edgeResult = await this.storage.queryEdges({
      projectId: await this.getProjectIdFromNode(nodeId),
      targetNodeId: nodeId,
      edgeType: EdgeType.CALLS
    });

    const callers: GraphNode[] = [];
    for (const edge of edgeResult.data) {
      const caller = await this.storage.getNode(edge.sourceNodeId);
      if (caller) {
        callers.push(caller);
      }
    }

    return callers;
  }

  async findCallees(nodeId: NodeId): Promise<GraphNode[]> {
    // Find all functions called by this node
    const edgeResult = await this.storage.queryEdges({
      projectId: await this.getProjectIdFromNode(nodeId),
      sourceNodeId: nodeId,
      edgeType: EdgeType.CALLS
    });

    const callees: GraphNode[] = [];
    for (const edge of edgeResult.data) {
      const callee = await this.storage.getNode(edge.targetNodeId);
      if (callee) {
        callees.push(callee);
      }
    }

    return callees;
  }

  async findDependencies(
    nodeId: NodeId,
    options: TraversalOptions = {}
  ): Promise<GraphNode[]> {
    const dependencies = new Set<GraphNode>();
    const visited = new Set<NodeId>();
    const maxDepth = options.maxDepth || 5;
    const edgeTypes = options.edgeTypes || [EdgeType.USES, EdgeType.IMPORTS, EdgeType.CALLS];

    await this.traverseDependencies(
      nodeId, 
      dependencies, 
      visited, 
      0, 
      maxDepth, 
      edgeTypes,
      'outbound'
    );

    return Array.from(dependencies);
  }

  async findDependents(
    nodeId: NodeId,
    options: TraversalOptions = {}
  ): Promise<GraphNode[]> {
    const dependents = new Set<GraphNode>();
    const visited = new Set<NodeId>();
    const maxDepth = options.maxDepth || 5;
    const edgeTypes = options.edgeTypes || [EdgeType.USES, EdgeType.IMPORTS, EdgeType.CALLS];

    await this.traverseDependencies(
      nodeId,
      dependents,
      visited,
      0,
      maxDepth,
      edgeTypes,
      'inbound'
    );

    return Array.from(dependents);
  }

  // ============================================================================
  // PATH FINDING
  // ============================================================================

  async findPath(
    fromNodeId: NodeId,
    toNodeId: NodeId,
    options: TraversalOptions = {}
  ): Promise<PathSearchResult | null> {
    const maxDepth = options.maxDepth || 10;
    const edgeTypes = options.edgeTypes || [EdgeType.CALLS, EdgeType.USES];
    
    const queue: Array<{
      nodeId: NodeId;
      path: NodeId[];
      edges: EdgeId[];
      depth: number;
    }> = [{
      nodeId: fromNodeId,
      path: [fromNodeId],
      edges: [],
      depth: 0
    }];

    const visited = new Set<NodeId>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.nodeId === toNodeId) {
        // Found path, construct result
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        
        for (const nodeId of current.path) {
          const node = await this.storage.getNode(nodeId);
          if (node) nodes.push(node);
        }

        for (const edgeId of current.edges) {
          const edge = await this.storage.getEdge(edgeId);
          if (edge) edges.push(edge);
        }

        return {
          path: nodes,
          edges,
          totalWeight: edges.reduce((sum, edge) => sum + (edge.weight || 1), 0),
          length: nodes.length - 1
        };
      }

      if (current.depth >= maxDepth || visited.has(current.nodeId)) {
        continue;
      }

      visited.add(current.nodeId);
      const projectId = await this.getProjectIdFromNode(current.nodeId);

      // Find outgoing edges
      for (const edgeType of edgeTypes) {
        const edgeResult = await this.storage.queryEdges({
          projectId,
          sourceNodeId: current.nodeId,
          edgeType
        });

        for (const edge of edgeResult.data) {
          if (!visited.has(edge.targetNodeId)) {
            queue.push({
              nodeId: edge.targetNodeId,
              path: [...current.path, edge.targetNodeId],
              edges: [...current.edges, edge.id],
              depth: current.depth + 1
            });
          }
        }
      }
    }

    return null; // No path found
  }

  async findShortestPaths(
    fromNodeId: NodeId,
    toNodeIds: NodeId[],
    options: TraversalOptions = {}
  ): Promise<Map<NodeId, PathSearchResult>> {
    const results = new Map<NodeId, PathSearchResult>();

    for (const toNodeId of toNodeIds) {
      const path = await this.findPath(fromNodeId, toNodeId, options);
      if (path) {
        results.set(toNodeId, path);
      }
    }

    return results;
  }

  // ============================================================================
  // ADVANCED ANALYSIS
  // ============================================================================

  async analyzeImpact(nodeId: NodeId): Promise<ImpactAnalysis> {
    const targetNode = await this.storage.getNode(nodeId);
    if (!targetNode) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Find directly affected nodes (immediate dependents)
    const directlyAffected = await this.findDependents(nodeId, { maxDepth: 1 });
    
    // Find indirectly affected nodes (transitive dependents)
    const indirectlyAffected = await this.findDependents(nodeId, { maxDepth: 5 });
    
    // Remove directly affected from indirectly affected
    const indirectOnly = indirectlyAffected.filter(node => 
      !directlyAffected.some(direct => direct.id === node.id)
    );

    // Calculate risk level based on number of affected nodes
    const totalAffected = directlyAffected.length + indirectOnly.length;
    let riskLevel: 'low' | 'medium' | 'high' | 'critical';
    
    if (totalAffected > 50) riskLevel = 'critical';
    else if (totalAffected > 20) riskLevel = 'high';
    else if (totalAffected > 5) riskLevel = 'medium';
    else riskLevel = 'low';

    // Get affected files
    const affectedFiles = [
      ...new Set([
        ...directlyAffected.map(n => n.location.filePath),
        ...indirectOnly.map(n => n.location.filePath)
      ])
    ];

    // Estimate change complexity
    const estimatedChangeComplexity = this.calculateChangeComplexity(
      targetNode, 
      directlyAffected, 
      indirectOnly
    );

    return {
      targetNode,
      directlyAffected,
      indirectlyAffected: indirectOnly,
      riskLevel,
      affectedFiles,
      estimatedChangeComplexity
    };
  }

  async findCircularDependencies(
    projectId: ProjectId,
    maxDepth = 10
  ): Promise<CircularDependency[]> {
    return this.storage.findCircularDependencies(projectId, maxDepth);
  }

  async findBottlenecks(projectId: ProjectId): Promise<{
    node: GraphNode;
    incomingConnections: number;
    outgoingConnections: number;
    totalConnections: number;
    centrality: number;
  }[]> {
    // Find nodes with the most connections (high centrality)
    const functionNodes = await this.findNodesByType(projectId, NodeType.FUNCTION);
    const bottlenecks: any[] = [];

    for (const node of functionNodes) {
      const connections = await this.storage.getNodeWithConnections(node.id);
      if (connections) {
        const incomingCount = connections.incomingEdges.length;
        const outgoingCount = connections.outgoingEdges.length;
        const totalConnections = incomingCount + outgoingCount;
        
        // Calculate centrality score
        const centrality = this.calculateCentrality(incomingCount, outgoingCount, node.complexity || 1);

        bottlenecks.push({
          node,
          incomingConnections: incomingCount,
          outgoingConnections: outgoingCount,
          totalConnections,
          centrality
        });
      }
    }

    // Sort by centrality score (descending)
    return bottlenecks
      .sort((a, b) => b.centrality - a.centrality)
      .slice(0, 20); // Top 20 bottlenecks
  }

  // ============================================================================
  // SEARCH AND FILTERING
  // ============================================================================

  async searchNodes(
    projectId: ProjectId,
    query: string,
    options: {
      nodeTypes?: NodeType[];
      includeContent?: boolean;
      fuzzyThreshold?: number;
      limit?: number;
    } = {}
  ): Promise<NodeSearchResult[]> {
    const { nodeTypes, includeContent = false, fuzzyThreshold = 0.3, limit = 50 } = options;
    
    const results: NodeSearchResult[] = [];
    
    // Search by name pattern
    for (const nodeType of nodeTypes || Object.values(NodeType)) {
      const nameResults = await this.findNodesByName(projectId, query, {
        fuzzy: true,
        nodeType
      });
      
      results.push(...nameResults.filter(r => r.similarity! >= fuzzyThreshold));
    }

    // Search in docstrings and purposes if requested
    if (includeContent) {
      // This would require full-text search implementation
      // For now, we'll do a simple contains search
      const allNodesResult = await this.storage.queryNodes({
        projectId,
        limit: 1000
      });

      for (const node of allNodesResult.data) {
        if (nodeTypes && !nodeTypes.includes(node.nodeType)) continue;
        
        const searchableText = [
          node.name,
          node.docstring,
          node.purpose
        ].filter(Boolean).join(' ').toLowerCase();

        if (searchableText.includes(query.toLowerCase())) {
          const similarity = this.calculateTextSimilarity(searchableText, query.toLowerCase());
          if (similarity >= fuzzyThreshold) {
            results.push({
              node,
              similarity,
              matchReason: 'content_match'
            });
          }
        }
      }
    }

    // Remove duplicates and sort by similarity
    const uniqueResults = new Map<NodeId, NodeSearchResult>();
    for (const result of results) {
      const existing = uniqueResults.get(result.node.id);
      if (!existing || result.similarity! > existing.similarity!) {
        uniqueResults.set(result.node.id, result);
      }
    }

    return Array.from(uniqueResults.values())
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, limit);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private async traverseDependencies(
    nodeId: NodeId,
    collected: Set<GraphNode>,
    visited: Set<NodeId>,
    depth: number,
    maxDepth: number,
    edgeTypes: EdgeType[],
    direction: 'inbound' | 'outbound'
  ): Promise<void> {
    if (depth >= maxDepth || visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);
    const projectId = await this.getProjectIdFromNode(nodeId);

    for (const edgeType of edgeTypes) {
      const query: EdgeQuery = {
        projectId,
        edgeType
      };

      if (direction === 'outbound') {
        query.sourceNodeId = nodeId;
      } else {
        query.targetNodeId = nodeId;
      }

      const edgeResult = await this.storage.queryEdges(query);

      for (const edge of edgeResult.data) {
        const targetNodeId = direction === 'outbound' ? edge.targetNodeId : edge.sourceNodeId;
        const targetNode = await this.storage.getNode(targetNodeId);
        
        if (targetNode) {
          collected.add(targetNode);
          
          await this.traverseDependencies(
            targetNodeId,
            collected,
            visited,
            depth + 1,
            maxDepth,
            edgeTypes,
            direction
          );
        }
      }
    }
  }

  private async getProjectIdFromNode(nodeId: NodeId): Promise<ProjectId> {
    const node = await this.storage.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    return node.projectId;
  }

  private calculateNameSimilarity(name1: string, name2: string): number {
    // Simple Levenshtein distance-based similarity
    const distance = this.levenshteinDistance(name1.toLowerCase(), name2.toLowerCase());
    const maxLength = Math.max(name1.length, name2.length);
    return maxLength === 0 ? 1 : (maxLength - distance) / maxLength;
  }

  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.split(/\s+/));
    const words2 = new Set(text2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(word => words2.has(word)));
    const union = new Set([...words1, ...words2]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  private calculateChangeComplexity(
    targetNode: GraphNode,
    directlyAffected: GraphNode[],
    indirectlyAffected: GraphNode[]
  ): number {
    let complexity = targetNode.complexity || 1;
    
    // Add complexity from directly affected nodes (weighted more heavily)
    complexity += directlyAffected.reduce((sum, node) => sum + (node.complexity || 1) * 0.8, 0);
    
    // Add complexity from indirectly affected nodes (weighted less)
    complexity += indirectlyAffected.reduce((sum, node) => sum + (node.complexity || 1) * 0.3, 0);
    
    return Math.round(complexity);
  }

  private calculateCentrality(incoming: number, outgoing: number, complexity: number): number {
    // Centrality based on connections and complexity
    return (incoming * 2 + outgoing) * Math.log(complexity + 1);
  }
}