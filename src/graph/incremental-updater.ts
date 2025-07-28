/**
 * Incremental Graph Updater
 * Handles real-time updates to the Code Property Graph based on file changes
 */

import { GraphStorageEngine } from './graph-storage.js';
import { GraphBuilder } from './graph-builder.js';
import { ASTAnalyzer } from '../ast-analyzer.js';
import { 
  GraphNode, GraphEdge, NodeId, ProjectId, VersionId,
  FileChange, ASTDiff, GraphUpdateResult, GraphUpdateOperation,
  UpdateOperationType, GraphBuildContext, NodeType, EdgeType
} from './types.js';
import { promises as fs } from 'fs';
import { relative, extname } from 'path';
import crypto from 'crypto';

export class IncrementalGraphUpdater {
  constructor(
    private storage: GraphStorageEngine,
    private graphBuilder: GraphBuilder,
    private astAnalyzer: ASTAnalyzer
  ) {}

  // ============================================================================
  // MAIN UPDATE METHODS
  // ============================================================================

  async updateFromFileChanges(
    projectId: ProjectId,
    fileChanges: FileChange[],
    context: GraphBuildContext
  ): Promise<GraphUpdateResult> {
    const startTime = Date.now();
    
    try {
      // Create new version for incremental updates
      const currentVersion = await this.storage.getCurrentVersion(projectId);
      const newVersion = await this.storage.createNewVersion(
        projectId,
        currentVersion || undefined,
        this.generateVersionChecksum(fileChanges)
      );

      const updateContext = { ...context, versionId: newVersion };
      const operations: GraphUpdateOperation[] = [];
      let totalNodesAffected = 0;
      let totalEdgesAffected = 0;
      const errors: string[] = [];

      // Process each file change
      for (const fileChange of fileChanges) {
        try {
          const result = await this.processFileChange(fileChange, updateContext);
          operations.push(...result.operations);
          totalNodesAffected += result.nodesAffected;
          totalEdgesAffected += result.edgesAffected;
          
          console.log(`Processed ${fileChange.filePath}: ${result.operations.length} operations`);
        } catch (error) {
          const errorMsg = `Error processing ${fileChange.filePath}: ${error}`;
          console.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Log all operations
      for (const operation of operations) {
        await this.storage.logUpdateOperation(operation);
      }

      const executionTime = Date.now() - startTime;

      return {
        success: errors.length === 0,
        versionId: newVersion,
        operationsApplied: operations.length,
        nodesAffected: totalNodesAffected,
        edgesAffected: totalEdgesAffected,
        executionTimeMs: executionTime,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      console.error('Incremental update failed:', error);
      throw error;
    }
  }

  async processFileChange(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    const operations: GraphUpdateOperation[] = [];
    let nodesAffected = 0;
    let edgesAffected = 0;

    switch (fileChange.changeType) {
      case 'added':
        {
          const result = await this.handleFileAdded(fileChange, context);
          operations.push(...result.operations);
          nodesAffected += result.nodesAffected;
          edgesAffected += result.edgesAffected;
        }
        break;

      case 'modified':
        {
          const result = await this.handleFileModified(fileChange, context);
          operations.push(...result.operations);
          nodesAffected += result.nodesAffected;
          edgesAffected += result.edgesAffected;
        }
        break;

      case 'deleted':
        {
          const result = await this.handleFileDeleted(fileChange, context);
          operations.push(...result.operations);
          nodesAffected += result.nodesAffected;
          edgesAffected += result.edgesAffected;
        }
        break;

      case 'renamed':
        {
          const result = await this.handleFileRenamed(fileChange, context);
          operations.push(...result.operations);
          nodesAffected += result.nodesAffected;
          edgesAffected += result.edgesAffected;
        }
        break;
    }

    return { operations, nodesAffected, edgesAffected };
  }

  // ============================================================================
  // FILE CHANGE HANDLERS
  // ============================================================================

  private async handleFileAdded(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    // For added files, just process them like a new build
    const result = await this.graphBuilder.processFile(fileChange.filePath, context);
    
    // All additions are new operations
    const operations: GraphUpdateOperation[] = [
      {
        id: this.generateOperationId(),
        projectId: context.projectId,
        versionId: context.versionId,
        operationType: UpdateOperationType.ADD_NODE,
        operationData: { filePath: fileChange.filePath },
        filePath: fileChange.filePath,
        changeReason: 'file_added',
        executionTimeMs: 0,
        createdAt: new Date()
      }
    ];

    return {
      operations,
      nodesAffected: result.nodesAdded,
      edgesAffected: result.edgesAdded
    };
  }

  private async handleFileModified(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    const operations: GraphUpdateOperation[] = [];
    let nodesAffected = 0;
    let edgesAffected = 0;

    if (!fileChange.oldContent || !fileChange.newContent) {
      // Fallback: treat as full file replacement
      return this.handleFileReplacement(fileChange, context);
    }

    // Parse ASTs for both versions
    const language = this.getLanguageFromExtension(extname(fileChange.filePath));
    const oldAST = this.astAnalyzer.parseCode(fileChange.oldContent, language);
    const newAST = this.astAnalyzer.parseCode(fileChange.newContent, language);

    if (!oldAST || !newAST) {
      console.warn(`Failed to parse AST for ${fileChange.filePath}, falling back to replacement`);
      return this.handleFileReplacement(fileChange, context);
    }

    // Compute AST diff
    const astDiff = await this.computeASTDiff(oldAST, newAST, fileChange.filePath, context);

    // Process AST changes
    const diffResult = await this.applyASTDiff(astDiff, context);
    operations.push(...diffResult.operations);
    nodesAffected += diffResult.nodesAffected;
    edgesAffected += diffResult.edgesAffected;

    return { operations, nodesAffected, edgesAffected };
  }

  private async handleFileDeleted(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    const operations: GraphUpdateOperation[] = [];
    
    // Find all nodes in the deleted file
    const nodesInFile = await this.storage.queryNodes({
      projectId: context.projectId,
      filePath: fileChange.filePath,
      limit: 1000
    });

    // Delete all nodes (edges will be cascade deleted)
    for (const node of nodesInFile.data) {
      await this.storage.deleteNode(node.id);
      
      operations.push({
        id: this.generateOperationId(),
        projectId: context.projectId,
        versionId: context.versionId,
        operationType: UpdateOperationType.DELETE_NODE,
        nodeId: node.id,
        operationData: { nodeKey: node.nodeKey },
        rollbackData: node,
        filePath: fileChange.filePath,
        changeReason: 'file_deleted',
        executionTimeMs: 0,
        createdAt: new Date()
      });
    }

    return {
      operations,
      nodesAffected: nodesInFile.data.length,
      edgesAffected: 0 // Edges are cascade deleted
    };
  }

  private async handleFileRenamed(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    const operations: GraphUpdateOperation[] = [];
    
    if (!fileChange.oldPath) {
      throw new Error('oldPath is required for renamed files');
    }

    // Find all nodes in the old file
    const nodesInFile = await this.storage.queryNodes({
      projectId: context.projectId,
      filePath: fileChange.oldPath,
      limit: 1000
    });

    // Update file paths for all nodes
    for (const node of nodesInFile.data) {
      const updatedNode = {
        ...node,
        location: {
          ...node.location,
          filePath: fileChange.filePath
        },
        nodeKey: node.nodeKey.replace(fileChange.oldPath, fileChange.filePath)
      };

      await this.storage.updateNode(node.id, updatedNode);
      
      operations.push({
        id: this.generateOperationId(),
        projectId: context.projectId,
        versionId: context.versionId,
        operationType: UpdateOperationType.UPDATE_NODE,
        nodeId: node.id,
        operationData: { 
          oldPath: fileChange.oldPath, 
          newPath: fileChange.filePath 
        },
        rollbackData: { filePath: fileChange.oldPath },
        filePath: fileChange.filePath,
        changeReason: 'file_renamed',
        executionTimeMs: 0,
        createdAt: new Date()
      });
    }

    return {
      operations,
      nodesAffected: nodesInFile.data.length,
      edgesAffected: 0
    };
  }

  private async handleFileReplacement(
    fileChange: FileChange,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    // Delete all existing nodes in the file
    const deleteResult = await this.handleFileDeleted(fileChange, context);
    
    // Add new nodes from the current file
    const addResult = await this.handleFileAdded(fileChange, context);

    return {
      operations: [...deleteResult.operations, ...addResult.operations],
      nodesAffected: deleteResult.nodesAffected + addResult.nodesAffected,
      edgesAffected: deleteResult.edgesAffected + addResult.edgesAffected
    };
  }

  // ============================================================================
  // AST DIFF PROCESSING
  // ============================================================================

  private async computeASTDiff(
    oldAST: any,
    newAST: any,
    filePath: string,
    context: GraphBuildContext
  ): Promise<ASTDiff> {
    // Extract significant nodes from both ASTs
    const oldNodes = this.extractSignificantNodes(oldAST, filePath);
    const newNodes = this.extractSignificantNodes(newAST, filePath);

    // Create maps for efficient lookup
    const oldNodeMap = new Map(oldNodes.map(n => [n.nodeKey, n]));
    const newNodeMap = new Map(newNodes.map(n => [n.nodeKey, n]));

    const addedNodes = newNodes.filter(n => !oldNodeMap.has(n.nodeKey));
    const deletedNodes = oldNodes.filter(n => !newNodeMap.has(n.nodeKey));
    const modifiedNodes = newNodes.filter(n => {
      const oldNode = oldNodeMap.get(n.nodeKey);
      return oldNode && this.hasNodeChanged(oldNode, n);
    });

    // For moved nodes, we need to check if the content is the same but location changed
    const movedNodes = newNodes.filter(n => {
      const oldNode = oldNodes.find(old => 
        old.hash === n.hash && 
        old.nodeKey !== n.nodeKey &&
        !oldNodeMap.has(n.nodeKey)
      );
      return oldNode !== undefined;
    });

    return {
      addedNodes: addedNodes.map(n => ({
        nodeKey: n.nodeKey,
        nodeType: n.nodeType,
        newData: n,
        location: n.location
      })),
      modifiedNodes: modifiedNodes.map(n => ({
        nodeKey: n.nodeKey,
        nodeType: n.nodeType,
        oldData: oldNodeMap.get(n.nodeKey),
        newData: n,
        location: n.location
      })),
      deletedNodes: deletedNodes.map(n => ({
        nodeKey: n.nodeKey,
        nodeType: n.nodeType,
        oldData: n,
        location: n.location
      })),
      movedNodes: movedNodes.map(n => {
        const oldNode = oldNodes.find(old => old.hash === n.hash)!;
        return {
          nodeKey: n.nodeKey,
          nodeType: n.nodeType,
          oldData: oldNode,
          newData: n,
          location: n.location
        };
      })
    };
  }

  private async applyASTDiff(
    astDiff: ASTDiff,
    context: GraphBuildContext
  ): Promise<{
    operations: GraphUpdateOperation[];
    nodesAffected: number;
    edgesAffected: number;
  }> {
    const operations: GraphUpdateOperation[] = [];
    let nodesAffected = 0;
    let edgesAffected = 0;

    // Handle deleted nodes
    for (const deletedNode of astDiff.deletedNodes) {
      const existingNode = await this.storage.getNodeByKey(
        context.projectId,
        deletedNode.nodeKey
      );

      if (existingNode) {
        await this.storage.deleteNode(existingNode.id);
        nodesAffected++;

        operations.push({
          id: this.generateOperationId(),
          projectId: context.projectId,
          versionId: context.versionId,
          operationType: UpdateOperationType.DELETE_NODE,
          nodeId: existingNode.id,
          operationData: { nodeKey: deletedNode.nodeKey },
          rollbackData: existingNode,
          changeReason: 'node_deleted',
          executionTimeMs: 0,
          createdAt: new Date()
        });
      }
    }

    // Handle added nodes
    for (const addedNode of astDiff.addedNodes) {
      const nodeData = addedNode.newData as Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>;
      const nodeId = await this.storage.addNode(nodeData);
      nodesAffected++;

      operations.push({
        id: this.generateOperationId(),
        projectId: context.projectId,
        versionId: context.versionId,
        operationType: UpdateOperationType.ADD_NODE,
        nodeId,
        operationData: { nodeKey: addedNode.nodeKey },
        changeReason: 'node_added',
        executionTimeMs: 0,
        createdAt: new Date()
      });
    }

    // Handle modified nodes
    for (const modifiedNode of astDiff.modifiedNodes) {
      const existingNode = await this.storage.getNodeByKey(
        context.projectId,
        modifiedNode.nodeKey
      );

      if (existingNode) {
        const updates = modifiedNode.newData as Partial<GraphNode>;
        await this.storage.updateNode(existingNode.id, updates);
        nodesAffected++;

        operations.push({
          id: this.generateOperationId(),
          projectId: context.projectId,
          versionId: context.versionId,
          operationType: UpdateOperationType.UPDATE_NODE,
          nodeId: existingNode.id,
          operationData: updates,
          rollbackData: modifiedNode.oldData,
          changeReason: 'node_modified',
          executionTimeMs: 0,
          createdAt: new Date()
        });
      }
    }

    // Handle moved nodes (update node keys and locations)
    for (const movedNode of astDiff.movedNodes) {
      const oldNode = movedNode.oldData as GraphNode;
      const existingNode = await this.storage.getNodeByKey(
        context.projectId,
        oldNode.nodeKey
      );

      if (existingNode) {
        const updates = {
          nodeKey: movedNode.nodeKey,
          location: movedNode.location
        };
        
        await this.storage.updateNode(existingNode.id, updates);
        nodesAffected++;

        operations.push({
          id: this.generateOperationId(),
          projectId: context.projectId,
          versionId: context.versionId,
          operationType: UpdateOperationType.UPDATE_NODE,
          nodeId: existingNode.id,
          operationData: updates,
          rollbackData: { 
            nodeKey: oldNode.nodeKey, 
            location: oldNode.location 
          },
          changeReason: 'node_moved',
          executionTimeMs: 0,
          createdAt: new Date()
        });
      }
    }

    return { operations, nodesAffected, edgesAffected };
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private extractSignificantNodes(ast: any, filePath: string): any[] {
    // This is a simplified extraction - in practice, we'd reuse the graph builder logic
    const nodes: any[] = [];
    this.extractNodesRecursive(ast, filePath, nodes);
    return nodes;
  }

  private extractNodesRecursive(node: any, filePath: string, nodes: any[]): void {
    // Check if this is a significant node (function, class, etc.)
    if (this.isSignificantNode(node)) {
      const location = {
        filePath,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column
      };

      const name = this.extractNodeName(node);
      const nodeKey = `${filePath}:${location.startLine}:${name}`;

      nodes.push({
        nodeKey,
        nodeType: this.mapASTNodeType(node.type),
        name,
        location,
        hash: this.generateContentHash(node.text),
        text: node.text
      });
    }

    // Recursively process children
    if (node.children) {
      for (const child of node.children) {
        this.extractNodesRecursive(child, filePath, nodes);
      }
    }
  }

  private isSignificantNode(node: any): boolean {
    const significantTypes = [
      'function_declaration', 'method_definition', 'class_declaration',
      'interface_declaration', 'variable_declaration', 'import_statement'
    ];
    return significantTypes.includes(node.type);
  }

  private mapASTNodeType(astNodeType: string): NodeType {
    const mapping: Record<string, NodeType> = {
      'function_declaration': NodeType.FUNCTION,
      'method_definition': NodeType.FUNCTION,
      'class_declaration': NodeType.CLASS,
      'interface_declaration': NodeType.INTERFACE,
      'variable_declaration': NodeType.VARIABLE,
      'import_statement': NodeType.IMPORT
    };
    return mapping[astNodeType] || NodeType.BLOCK;
  }

  private extractNodeName(node: any): string {
    // Simple name extraction - would be more sophisticated in practice
    const match = node.text.match(/(?:function|class|interface|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1] || 'anonymous';
  }

  private hasNodeChanged(oldNode: any, newNode: any): boolean {
    return oldNode.hash !== newNode.hash;
  }

  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private generateVersionChecksum(fileChanges: FileChange[]): string {
    const changeData = fileChanges.map(fc => `${fc.filePath}:${fc.changeType}`).join('|');
    return crypto.createHash('sha256').update(changeData + Date.now()).digest('hex');
  }

  private generateOperationId(): string {
    return crypto.randomUUID();
  }

  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust'
    };

    return languageMap[ext] || 'text';
  }
}