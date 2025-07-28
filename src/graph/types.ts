/**
 * Code Property Graph Types and Interfaces
 * Based on PostgreSQL/Supabase implementation
 */

export type NodeId = string;
export type EdgeId = string;
export type ProjectId = string;
export type VersionId = string;

// Node Types in the Code Property Graph
export enum NodeType {
  FUNCTION = 'FUNCTION',
  CLASS = 'CLASS',
  VARIABLE = 'VARIABLE',
  MODULE = 'MODULE',
  PARAMETER = 'PARAMETER',
  RETURN = 'RETURN',
  CALL_SITE = 'CALL_SITE',
  IMPORT = 'IMPORT',
  EXPORT = 'EXPORT',
  INTERFACE = 'INTERFACE',
  TYPE = 'TYPE',
  NAMESPACE = 'NAMESPACE',
  BLOCK = 'BLOCK'
}

// Edge Types for Relationships
export enum EdgeType {
  CALLS = 'CALLS',
  IMPORTS = 'IMPORTS',
  EXTENDS = 'EXTENDS',
  IMPLEMENTS = 'IMPLEMENTS',
  DATA_FLOW = 'DATA_FLOW',
  CONTROL_FLOW = 'CONTROL_FLOW',
  CONTAINS = 'CONTAINS',
  USES = 'USES',
  DEFINES = 'DEFINES',
  REFERENCES = 'REFERENCES'
}

// Code location information
export interface CodeLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

// Graph Node representation
export interface GraphNode {
  id: NodeId;
  projectId: ProjectId;
  versionId: VersionId;
  nodeKey: string; // unique identifier within project
  nodeType: NodeType;
  
  // Location
  location: CodeLocation;
  
  // Core properties
  name?: string;
  signature?: string;
  language: string;
  visibility?: 'public' | 'private' | 'protected';
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  
  // Semantic information
  complexity?: number;
  parameters?: Parameter[];
  returnType?: string;
  docstring?: string;
  purpose?: string; // AI-generated description
  
  // Technical metadata
  hash: string; // content hash for change detection
  dependencies?: string[]; // imported/used identifiers
  exports?: string[]; // what this node exports
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// Function/Method parameter
export interface Parameter {
  name: string;
  type?: string;
  defaultValue?: string;
  isOptional?: boolean;
  isRest?: boolean;
}

// Graph Edge representation
export interface GraphEdge {
  id: EdgeId;
  projectId: ProjectId;
  versionId: VersionId;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
  edgeType: EdgeType;
  
  // Edge properties
  weight?: number;
  callType?: 'direct' | 'indirect' | 'dynamic';
  isConditional?: boolean;
  isLoopDependent?: boolean;
  isAsyncContext?: boolean;
  
  // Additional properties
  properties?: Record<string, any>;
  
  createdAt: Date;
}

// Graph Version for incremental updates
export interface GraphVersion {
  id: VersionId;
  projectId: ProjectId;
  versionNumber: number;
  parentVersionId?: VersionId;
  checksum: string;
  operationsCount: number;
  metadata?: Record<string, any>;
  createdAt: Date;
}

// Update operation types
export enum UpdateOperationType {
  ADD_NODE = 'ADD_NODE',
  UPDATE_NODE = 'UPDATE_NODE',
  DELETE_NODE = 'DELETE_NODE',
  ADD_EDGE = 'ADD_EDGE',
  UPDATE_EDGE = 'UPDATE_EDGE',
  DELETE_EDGE = 'DELETE_EDGE'
}

// Graph update operation
export interface GraphUpdateOperation {
  id: string;
  projectId: ProjectId;
  versionId: VersionId;
  operationType: UpdateOperationType;
  nodeId?: NodeId;
  edgeId?: EdgeId;
  operationData: any;
  rollbackData?: any;
  filePath?: string;
  changeReason?: string;
  executionTimeMs?: number;
  createdAt: Date;
}

// Query interfaces
export interface NodeQuery {
  projectId: ProjectId;
  nodeType?: NodeType;
  name?: string;
  filePath?: string;
  pattern?: string; // for fuzzy search
  limit?: number;
  offset?: number;
}

export interface EdgeQuery {
  projectId: ProjectId;
  sourceNodeId?: NodeId;
  targetNodeId?: NodeId;
  edgeType?: EdgeType;
  limit?: number;
  offset?: number;
}

// Graph traversal options
export interface TraversalOptions {
  maxDepth?: number;
  edgeTypes?: EdgeType[];
  direction?: 'inbound' | 'outbound' | 'both';
  includeProperties?: boolean;
}

// Search results
export interface NodeSearchResult {
  node: GraphNode;
  similarity?: number;
  matchReason?: string;
}

export interface PathSearchResult {
  path: GraphNode[];
  edges: GraphEdge[];
  totalWeight: number;
  length: number;
}

// Circular dependency detection
export interface CircularDependency {
  nodes: NodeId[];
  edges: EdgeId[];
  cycleLength: number;
  edgeTypes: EdgeType[];
  severity: 'low' | 'medium' | 'high';
}

// Impact analysis
export interface ImpactAnalysis {
  targetNode: GraphNode;
  directlyAffected: GraphNode[];
  indirectlyAffected: GraphNode[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedFiles: string[];
  estimatedChangeComplexity: number;
}

// Graph statistics
export interface GraphStatistics {
  projectId: ProjectId;
  versionNumber: number;
  totalNodes: number;
  totalEdges: number;
  totalFiles: number;
  nodeTypeCounts: Record<NodeType, number>;
  edgeTypeCounts: Record<EdgeType, number>;
  averageComplexity: number;
  versionCreated: Date;
}

// Graph building context
export interface GraphBuildContext {
  projectId: ProjectId;
  versionId: VersionId;
  rootPath: string;
  includePatterns: string[];
  excludePatterns: string[];
  languages: string[];
}

// Change detection types
export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldContent?: string;
  newContent?: string;
  oldPath?: string; // for renames
}

export interface ASTDiff {
  addedNodes: ASTNodeDiff[];
  modifiedNodes: ASTNodeDiff[];
  deletedNodes: ASTNodeDiff[];
  movedNodes: ASTNodeDiff[];
}

export interface ASTNodeDiff {
  nodeKey: string;
  nodeType: NodeType;
  oldData?: any;
  newData?: any;
  location: CodeLocation;
}

// Update result
export interface GraphUpdateResult {
  success: boolean;
  versionId: VersionId;
  operationsApplied: number;
  nodesAffected: number;
  edgesAffected: number;
  executionTimeMs: number;
  errors?: string[];
}

// Graph query builder result
export interface QueryResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  executionTimeMs: number;
}

// Database row types (matching PostgreSQL schema)
export interface GraphNodeRow {
  id: string;
  project_id: string;
  version_id: string;
  node_key: string;
  node_type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  name?: string;
  signature?: string;
  language: string;
  visibility?: string;
  is_async?: boolean;
  is_static?: boolean;
  is_abstract?: boolean;
  complexity?: number;
  parameters?: any;
  return_type?: string;
  docstring?: string;
  purpose?: string;
  hash: string;
  dependencies?: any;
  exports?: any;
  created_at: string;
  updated_at: string;
}

export interface GraphEdgeRow {
  id: string;
  project_id: string;
  version_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  weight?: number;
  call_type?: string;
  is_conditional?: boolean;
  is_loop_dependent?: boolean;
  is_async_context?: boolean;
  properties?: any;
  created_at: string;
}

export interface GraphVersionRow {
  id: string;
  project_id: string;
  version_number: number;
  parent_version_id?: string;
  checksum: string;
  operations_count: number;
  metadata?: any;
  created_at: string;
}

// Error types
export class GraphError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export class GraphNotFoundError extends GraphError {
  constructor(resource: string, identifier: string) {
    super(`${resource} not found: ${identifier}`, 'GRAPH_NOT_FOUND');
  }
}

export class GraphValidationError extends GraphError {
  constructor(message: string, details?: any) {
    super(message, 'GRAPH_VALIDATION_ERROR', details);
  }
}

export class GraphUpdateError extends GraphError {
  constructor(message: string, details?: any) {
    super(message, 'GRAPH_UPDATE_ERROR', details);
  }
}