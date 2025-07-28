/**
 * PostgreSQL/Supabase-based Graph Storage Engine
 * Handles all database operations for the Code Property Graph
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { 
  GraphNode, GraphEdge, GraphVersion, GraphUpdateOperation,
  NodeId, EdgeId, ProjectId, VersionId,
  NodeQuery, EdgeQuery, QueryResult,
  GraphNodeRow, GraphEdgeRow, GraphVersionRow,
  UpdateOperationType, GraphStatistics,
  GraphError, GraphNotFoundError, GraphUpdateError,
  CircularDependency, PathSearchResult, NodeSearchResult
} from './types.js';

export class GraphStorageEngine {
  constructor(private supabase: SupabaseClient) {}

  // ============================================================================
  // VERSION MANAGEMENT
  // ============================================================================

  async getCurrentVersion(projectId: ProjectId): Promise<VersionId | null> {
    const { data, error } = await this.supabase
      .rpc('get_current_version', { p_project_id: projectId });

    if (error) {
      throw new GraphError('Failed to get current version', 'VERSION_ERROR', error);
    }

    return data;
  }

  async createNewVersion(
    projectId: ProjectId, 
    parentVersionId?: VersionId,
    checksum?: string
  ): Promise<VersionId> {
    const { data, error } = await this.supabase
      .rpc('create_new_version', {
        p_project_id: projectId,
        p_parent_version_id: parentVersionId,
        p_checksum: checksum || this.generateChecksum()
      });

    if (error) {
      throw new GraphError('Failed to create new version', 'VERSION_CREATE_ERROR', error);
    }

    return data;
  }

  async getVersion(versionId: VersionId): Promise<GraphVersion | null> {
    const { data, error } = await this.supabase
      .from('graph_versions')
      .select('*')
      .eq('id', versionId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw new GraphError('Failed to get version', 'VERSION_ERROR', error);
    }

    return this.mapVersionRowToVersion(data);
  }

  async getVersionHistory(projectId: ProjectId, limit = 10): Promise<GraphVersion[]> {
    const { data, error } = await this.supabase
      .from('graph_versions')
      .select('*')
      .eq('project_id', projectId)
      .order('version_number', { ascending: false })
      .limit(limit);

    if (error) {
      throw new GraphError('Failed to get version history', 'VERSION_ERROR', error);
    }

    return data.map(row => this.mapVersionRowToVersion(row));
  }

  // ============================================================================
  // NODE OPERATIONS
  // ============================================================================

  async addNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<NodeId> {
    const nodeRow = this.mapNodeToRow(node);
    
    const { data, error } = await this.supabase
      .from('graph_nodes')
      .insert(nodeRow)
      .select('id')
      .single();

    if (error) {
      throw new GraphUpdateError('Failed to add node', error);
    }

    return data.id;
  }

  async updateNode(nodeId: NodeId, updates: Partial<GraphNode>): Promise<void> {
    const updateData = this.mapNodeToRow(updates as any);
    delete updateData.id;
    delete updateData.created_at;
    updateData.updated_at = new Date().toISOString();

    const { error } = await this.supabase
      .from('graph_nodes')  
      .update(updateData)
      .eq('id', nodeId);

    if (error) {
      throw new GraphUpdateError('Failed to update node', error);
    }
  }

  async deleteNode(nodeId: NodeId): Promise<void> {
    // Delete edges first (foreign key constraints)
    await this.supabase
      .from('graph_edges')
      .delete()
      .or(`source_node_id.eq.${nodeId},target_node_id.eq.${nodeId}`);

    const { error } = await this.supabase
      .from('graph_nodes')
      .delete()
      .eq('id', nodeId);

    if (error) {
      throw new GraphUpdateError('Failed to delete node', error);
    }
  }

  async getNode(nodeId: NodeId): Promise<GraphNode | null> {
    const { data, error } = await this.supabase
      .from('graph_nodes')
      .select('*')
      .eq('id', nodeId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new GraphError('Failed to get node', 'NODE_ERROR', error);
    }

    return this.mapRowToNode(data);
  }

  async getNodeByKey(projectId: ProjectId, nodeKey: string, versionId?: VersionId): Promise<GraphNode | null> {
    let query = this.supabase
      .from('graph_nodes')
      .select('*')
      .eq('project_id', projectId)
      .eq('node_key', nodeKey);

    if (versionId) {
      query = query.eq('version_id', versionId);
    } else {
      const currentVersion = await this.getCurrentVersion(projectId);
      if (currentVersion) {
        query = query.eq('version_id', currentVersion);
      }
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new GraphError('Failed to get node by key', 'NODE_ERROR', error);
    }

    return this.mapRowToNode(data);
  }

  async queryNodes(query: NodeQuery): Promise<QueryResult<GraphNode>> {
    let supabaseQuery = this.supabase
      .from('graph_nodes')
      .select('*', { count: 'exact' })
      .eq('project_id', query.projectId);

    // Get current version if not specified
    const currentVersion = await this.getCurrentVersion(query.projectId);
    if (currentVersion) {
      supabaseQuery = supabaseQuery.eq('version_id', currentVersion);
    }

    // Apply filters
    if (query.nodeType) {
      supabaseQuery = supabaseQuery.eq('node_type', query.nodeType);
    }

    if (query.name) {
      supabaseQuery = supabaseQuery.eq('name', query.name);
    }

    if (query.filePath) {
      supabaseQuery = supabaseQuery.eq('file_path', query.filePath);
    }

    if (query.pattern) {
      // Use fuzzy search function
      const { data: searchData, error: searchError } = await this.supabase
        .rpc('find_nodes_by_pattern', {
          p_project_id: query.projectId,
          p_pattern: query.pattern,
          p_node_type: query.nodeType,
          p_limit: query.limit || 100
        });

      if (searchError) {
        throw new GraphError('Failed to search nodes', 'SEARCH_ERROR', searchError);
      }

      return {
        data: searchData.map((row: any) => this.mapRowToNode(row)),
        totalCount: searchData.length,
        hasMore: false,
        executionTimeMs: 0
      };
    }

    // Apply pagination
    if (query.limit) {
      supabaseQuery = supabaseQuery.limit(query.limit);
    }
    if (query.offset) {
      supabaseQuery = supabaseQuery.range(query.offset, query.offset + (query.limit || 50) - 1);
    }

    const startTime = Date.now();
    const { data, error, count } = await supabaseQuery;
    const executionTime = Date.now() - startTime;

    if (error) {
      throw new GraphError('Failed to query nodes', 'QUERY_ERROR', error);
    }

    return {
      data: data.map(row => this.mapRowToNode(row)),  
      totalCount: count || 0,
      hasMore: (query.offset || 0) + data.length < (count || 0),
      executionTimeMs: executionTime
    };
  }

  // ============================================================================
  // EDGE OPERATIONS
  // ============================================================================

  async addEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'>): Promise<EdgeId> {
    const edgeRow = this.mapEdgeToRow(edge);

    const { data, error } = await this.supabase
      .from('graph_edges')
      .insert(edgeRow)
      .select('id')
      .single();

    if (error) {
      throw new GraphUpdateError('Failed to add edge', error);
    }

    return data.id;
  }

  async deleteEdge(edgeId: EdgeId): Promise<void> {
    const { error } = await this.supabase
      .from('graph_edges')
      .delete()
      .eq('id', edgeId);

    if (error) {
      throw new GraphUpdateError('Failed to delete edge', error);
    }
  }

  async getEdge(edgeId: EdgeId): Promise<GraphEdge | null> {
    const { data, error } = await this.supabase
      .from('graph_edges')
      .select('*')
      .eq('id', edgeId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new GraphError('Failed to get edge', 'EDGE_ERROR', error);
    }

    return this.mapRowToEdge(data);
  }

  async queryEdges(query: EdgeQuery): Promise<QueryResult<GraphEdge>> {
    let supabaseQuery = this.supabase
      .from('graph_edges')
      .select('*', { count: 'exact' })
      .eq('project_id', query.projectId);

    // Get current version
    const currentVersion = await this.getCurrentVersion(query.projectId);
    if (currentVersion) {
      supabaseQuery = supabaseQuery.eq('version_id', currentVersion);
    }

    // Apply filters
    if (query.sourceNodeId) {
      supabaseQuery = supabaseQuery.eq('source_node_id', query.sourceNodeId);
    }

    if (query.targetNodeId) {
      supabaseQuery = supabaseQuery.eq('target_node_id', query.targetNodeId);
    }

    if (query.edgeType) {
      supabaseQuery = supabaseQuery.eq('edge_type', query.edgeType);
    }

    // Apply pagination
    if (query.limit) {
      supabaseQuery = supabaseQuery.limit(query.limit);
    }
    if (query.offset) {
      supabaseQuery = supabaseQuery.range(query.offset, query.offset + (query.limit || 50) - 1);
    }

    const startTime = Date.now();
    const { data, error, count } = await supabaseQuery;
    const executionTime = Date.now() - startTime;

    if (error) {
      throw new GraphError('Failed to query edges', 'QUERY_ERROR', error);
    }

    return {
      data: data.map(row => this.mapRowToEdge(row)),
      totalCount: count || 0,
      hasMore: (query.offset || 0) + data.length < (count || 0),
      executionTimeMs: executionTime
    };
  }

  // ============================================================================
  // GRAPH ANALYSIS
  // ============================================================================

  async findCircularDependencies(projectId: ProjectId, maxDepth = 10): Promise<CircularDependency[]> {
    const { data, error } = await this.supabase
      .rpc('find_circular_dependencies', {
        p_project_id: projectId,
        p_max_depth: maxDepth
      });

    if (error) {
      throw new GraphError('Failed to find circular dependencies', 'ANALYSIS_ERROR', error);
    }

    return data.map((row: any) => ({
      nodes: row.cycle_nodes,
      edges: [], // TODO: Get edge IDs
      cycleLength: row.cycle_length,
      edgeTypes: row.edge_types,
      severity: this.calculateCycleSeverity(row.cycle_length, row.edge_types)
    }));
  }

  async getNodeWithConnections(nodeId: NodeId): Promise<{
    node: GraphNode;
    incomingEdges: GraphEdge[];
    outgoingEdges: GraphEdge[];
  } | null> {
    const { data, error } = await this.supabase
      .rpc('get_node_with_edges', { p_node_id: nodeId });

    if (error) {
      throw new GraphError('Failed to get node with connections', 'QUERY_ERROR', error);
    }

    if (!data || data.length === 0) return null;

    const result = data[0];
    return {
      node: this.mapRowToNode(result.node_data),
      incomingEdges: result.incoming_edges.map((edge: any) => this.mapRowToEdge(edge)),
      outgoingEdges: result.outgoing_edges.map((edge: any) => this.mapRowToEdge(edge))
    };
  }

  async getGraphStatistics(projectId: ProjectId): Promise<GraphStatistics> {
    const { data, error } = await this.supabase
      .from('graph_statistics')
      .select('*')
      .eq('project_id', projectId)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      throw new GraphError('Failed to get graph statistics', 'STATS_ERROR', error);
    }

    return {
      projectId: data.project_id,
      versionNumber: data.version_number,
      totalNodes: data.total_nodes,
      totalEdges: data.total_edges,
      totalFiles: data.total_files,
      nodeTypeCounts: {
        FUNCTION: data.function_count,
        CLASS: data.class_count,
        MODULE: data.module_count,
        // Add other types as needed
      } as any,
      edgeTypeCounts: {} as any, // TODO: Implement edge type counts
      averageComplexity: data.avg_complexity,
      versionCreated: new Date(data.version_created)
    };
  }

  // ============================================================================
  // UPDATE OPERATIONS
  // ============================================================================

  async logUpdateOperation(operation: Omit<GraphUpdateOperation, 'id' | 'createdAt'>): Promise<void> {
    const { error } = await this.supabase
      .from('graph_update_operations')
      .insert({
        project_id: operation.projectId,
        version_id: operation.versionId,
        operation_type: operation.operationType,
        node_id: operation.nodeId,
        edge_id: operation.edgeId,
        operation_data: operation.operationData,
        rollback_data: operation.rollbackData,
        file_path: operation.filePath,
        change_reason: operation.changeReason,
        execution_time_ms: operation.executionTimeMs
      });

    if (error) {
      console.error('Failed to log update operation:', error);
      // Don't throw here as this is just logging
    }
  }

  async executeTransaction<T>(operations: (() => Promise<T>)[]): Promise<T[]> {
    // Supabase doesn't have explicit transaction support in the client
    // We'll implement a simple sequential execution with rollback on error
    const results: T[] = [];
    const rollbackOps: (() => Promise<void>)[] = [];

    try {
      for (const operation of operations) {
        const result = await operation();
        results.push(result);
      }
      return results;
    } catch (error) {
      // Attempt to rollback completed operations
      for (const rollback of rollbackOps.reverse()) {
        try {
          await rollback();
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
        }
      }
      throw error;
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private mapRowToNode(row: GraphNodeRow): GraphNode {
    return {
      id: row.id,
      projectId: row.project_id,
      versionId: row.version_id,
      nodeKey: row.node_key,
      nodeType: row.node_type as any,
      location: {
        filePath: row.file_path,
        startLine: row.start_line,
        endLine: row.end_line,
        startColumn: row.start_column,
        endColumn: row.end_column
      },
      name: row.name,
      signature: row.signature,
      language: row.language,
      visibility: row.visibility as any,
      isAsync: row.is_async,
      isStatic: row.is_static,
      isAbstract: row.is_abstract,
      complexity: row.complexity,
      parameters: row.parameters,
      returnType: row.return_type,
      docstring: row.docstring,
      purpose: row.purpose,
      hash: row.hash,
      dependencies: row.dependencies,
      exports: row.exports,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private mapNodeToRow(node: Partial<GraphNode>): Partial<GraphNodeRow> {
    return {
      id: node.id,
      project_id: node.projectId,
      version_id: node.versionId,
      node_key: node.nodeKey,
      node_type: node.nodeType,
      file_path: node.location?.filePath,
      start_line: node.location?.startLine,
      end_line: node.location?.endLine,
      start_column: node.location?.startColumn,
      end_column: node.location?.endColumn,
      name: node.name,
      signature: node.signature,
      language: node.language,
      visibility: node.visibility,
      is_async: node.isAsync,
      is_static: node.isStatic,
      is_abstract: node.isAbstract,
      complexity: node.complexity,
      parameters: node.parameters,
      return_type: node.returnType,
      docstring: node.docstring,
      purpose: node.purpose,
      hash: node.hash,
      dependencies: node.dependencies,
      exports: node.exports
    };
  }

  private mapRowToEdge(row: GraphEdgeRow): GraphEdge {
    return {
      id: row.id,
      projectId: row.project_id,
      versionId: row.version_id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      edgeType: row.edge_type as any,
      weight: row.weight,
      callType: row.call_type as any,
      isConditional: row.is_conditional,
      isLoopDependent: row.is_loop_dependent,
      isAsyncContext: row.is_async_context,
      properties: row.properties,
      createdAt: new Date(row.created_at)
    };
  }

  private mapEdgeToRow(edge: Partial<GraphEdge>): Partial<GraphEdgeRow> {
    return {
      id: edge.id,
      project_id: edge.projectId,
      version_id: edge.versionId,
      source_node_id: edge.sourceNodeId,
      target_node_id: edge.targetNodeId,
      edge_type: edge.edgeType,
      weight: edge.weight,
      call_type: edge.callType,
      is_conditional: edge.isConditional,
      is_loop_dependent: edge.isLoopDependent,
      is_async_context: edge.isAsyncContext,
      properties: edge.properties
    };
  }

  private mapVersionRowToVersion(row: GraphVersionRow): GraphVersion {
    return {
      id: row.id,
      projectId: row.project_id,
      versionNumber: row.version_number,
      parentVersionId: row.parent_version_id,
      checksum: row.checksum,
      operationsCount: row.operations_count,
      metadata: row.metadata,
      createdAt: new Date(row.created_at)
    };
  }

  private generateChecksum(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  private calculateCycleSeverity(length: number, edgeTypes: string[]): 'low' | 'medium' | 'high' {
    if (length > 10) return 'high';
    if (length > 5) return 'medium';
    return 'low';
  }
}