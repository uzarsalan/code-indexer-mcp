/**
 * Code Property Graph Builder
 * Constructs graph from AST analysis and stores in PostgreSQL/Supabase
 */

import { ASTAnalyzer, ASTNode } from '../ast-analyzer.js';
import { GraphStorageEngine } from './graph-storage.js';
import { CodePurposeGenerator } from '../code-purpose-generator.js';
import { APIConnectionAnalyzer } from '../api-connection-analyzer.js';
import { 
  GraphNode, GraphEdge, NodeType, EdgeType, 
  ProjectId, VersionId, GraphBuildContext,
  CodeLocation, Parameter, GraphUpdateResult
} from './types.js';
import { promises as fs } from 'fs';
import { join, relative, extname } from 'path';
import walk from 'walk';
import ignore from 'ignore';
import crypto from 'crypto';

export class GraphBuilder {
  private astAnalyzer: ASTAnalyzer;
  private purposeGenerator: CodePurposeGenerator;
  private storage: GraphStorageEngine;
  private apiAnalyzer: APIConnectionAnalyzer;

  constructor(
    astAnalyzer: ASTAnalyzer,
    purposeGenerator: CodePurposeGenerator,
    storage: GraphStorageEngine
  ) {
    this.astAnalyzer = astAnalyzer;
    this.purposeGenerator = purposeGenerator;
    this.storage = storage;
  }

  // ============================================================================
  // MAIN BUILD METHODS
  // ============================================================================

  async buildGraphFromProject(context: GraphBuildContext): Promise<GraphUpdateResult> {
    const startTime = Date.now();
    
    try {
      // Create new version
      const versionId = await this.storage.createNewVersion(
        context.projectId,
        undefined, // No parent for full rebuild
        this.generateProjectChecksum(context.rootPath)
      );

      // Update context with version
      const buildContext = { ...context, versionId };

      // Get all files to process
      const files = await this.getFilesToProcess(buildContext);
      console.log(`Building graph for ${files.length} files...`);

      let totalNodes = 0;
      let totalEdges = 0;
      const errors: string[] = [];

      // Process each file
      for (const filePath of files) {
        try {
          const result = await this.processFile(filePath, buildContext);
          totalNodes += result.nodesAdded;
          totalEdges += result.edgesAdded;
          
          console.log(`Processed ${filePath}: ${result.nodesAdded} nodes, ${result.edgesAdded} edges`);
        } catch (error) {
          const errorMsg = `Error processing ${filePath}: ${error}`;
          console.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      // Post-processing: generate purposes for functions
      await this.generateNodePurposes(context.projectId, versionId);

      const executionTime = Date.now() - startTime;

      return {
        success: errors.length === 0,
        versionId,
        operationsApplied: totalNodes + totalEdges,
        nodesAffected: totalNodes,
        edgesAffected: totalEdges,
        executionTimeMs: executionTime,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      console.error('Graph build failed:', error);
      throw error;
    }
  }

  async processFile(filePath: string, context: GraphBuildContext): Promise<{
    nodesAdded: number;
    edgesAdded: number;
  }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const relativePath = relative(context.rootPath, filePath);
    const language = this.getLanguageFromExtension(extname(filePath));
    
    // Parse AST
    const ast = this.astAnalyzer.parseCode(content, language);
    if (!ast) {
      console.warn(`Failed to parse AST for ${filePath}`);
      return { nodesAdded: 0, edgesAdded: 0 };
    }

    // Extract nodes and edges from AST
    const { nodes, edges } = await this.extractGraphElements(
      ast, 
      filePath,
      relativePath,
      language,
      context
    );

    // Store nodes
    const nodeIds = new Map<string, string>();
    for (const node of nodes) {
      try {
        const nodeId = await this.storage.addNode(node);
        nodeIds.set(node.nodeKey, nodeId);
      } catch (error) {
        console.error(`Failed to add node ${node.nodeKey}:`, error);
      }
    }

    // Store edges
    let edgesAdded = 0;
    for (const edge of edges) {
      try {
        // Resolve node IDs
        const sourceId = nodeIds.get(this.getNodeKeyFromId(edge.sourceNodeId));
        const targetId = nodeIds.get(this.getNodeKeyFromId(edge.targetNodeId));
        
        if (sourceId && targetId) {
          await this.storage.addEdge({
            ...edge,
            sourceNodeId: sourceId,
            targetNodeId: targetId
          });
          edgesAdded++;
        }
      } catch (error) {
        console.error(`Failed to add edge:`, error);
      }
    }

    return {
      nodesAdded: nodes.length,
      edgesAdded
    };
  }

  // ============================================================================
  // AST TO GRAPH EXTRACTION
  // ============================================================================

  private async extractGraphElements(
    ast: ASTNode,
    filePath: string,
    relativePath: string,
    language: string,
    context: GraphBuildContext
  ): Promise<{
    nodes: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[];
    edges: Omit<GraphEdge, 'id' | 'createdAt'>[];
  }> {
    const nodes: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'id' | 'createdAt'>[] = [];
    const imports = new Map<string, string>(); // imported name -> nodeKey
    const functionCalls = new Map<string, string[]>(); // caller nodeKey -> called names

    // First pass: extract all nodes
    this.extractNodes(ast, filePath, relativePath, language, context, nodes, imports, functionCalls);

    // Second pass: create edges based on relationships
    this.createEdges(nodes, edges, imports, functionCalls, context);

    return { nodes, edges };
  }

  private extractNodes(
    node: ASTNode,
    filePath: string,
    relativePath: string,
    language: string,
    context: GraphBuildContext,
    nodes: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[],
    imports: Map<string, string>,
    functionCalls: Map<string, string[]>,
    parentNodeKey?: string
  ): void {
    const nodeInfo = this.analyzeASTNode(node, language);
    
    if (nodeInfo.isSignificant) {
      const location = this.extractLocation(node, filePath);
      const nodeKey = this.generateNodeKey(relativePath, nodeInfo.name || 'anonymous', location);
      
      const graphNode: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> = {
        projectId: context.projectId,
        versionId: context.versionId,
        nodeKey,
        nodeType: nodeInfo.nodeType,
        location,
        name: nodeInfo.name,
        signature: nodeInfo.signature,
        language,
        visibility: nodeInfo.visibility,
        isAsync: nodeInfo.isAsync,
        isStatic: nodeInfo.isStatic,
        complexity: this.calculateComplexity(node),
        parameters: nodeInfo.parameters,
        returnType: nodeInfo.returnType,
        docstring: nodeInfo.docstring,
        hash: this.generateContentHash(node.text),
        dependencies: nodeInfo.dependencies,
        exports: nodeInfo.exports
      };

      nodes.push(graphNode);

      // Track imports
      if (nodeInfo.nodeType === NodeType.IMPORT && nodeInfo.importedNames) {
        for (const importedName of nodeInfo.importedNames) {
          imports.set(importedName, nodeKey);
        }
      }

      // Track function calls
      if (nodeInfo.functionCalls && nodeInfo.functionCalls.length > 0) {
        functionCalls.set(nodeKey, nodeInfo.functionCalls);
      }

      // Create containment edge to parent
      if (parentNodeKey) {
        // Will be handled in createEdges
      }

      parentNodeKey = nodeKey;
    }

    // Recursively process children
    if (node.children) {
      for (const child of node.children) {
        this.extractNodes(
          child, filePath, relativePath, language, 
          context, nodes, imports, functionCalls, parentNodeKey
        );
      }
    }
  }

  private createEdges(
    nodes: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[],
    edges: Omit<GraphEdge, 'id' | 'createdAt'>[],
    imports: Map<string, string>,
    functionCalls: Map<string, string[]>,
    context: GraphBuildContext
  ): void {
    const nodesByKey = new Map(nodes.map(n => [n.nodeKey, n]));

    for (const node of nodes) {
      // Create import edges
      if (node.dependencies) {
        for (const dep of node.dependencies) {
          const importNodeKey = imports.get(dep);
          if (importNodeKey) {
            edges.push({
              projectId: context.projectId,
              versionId: context.versionId,
              sourceNodeId: node.nodeKey, // Will be resolved to actual ID later
              targetNodeId: importNodeKey,
              edgeType: EdgeType.USES
            });
          }
        }
      }

      // Create call edges
      const calls = functionCalls.get(node.nodeKey);
      if (calls) {
        for (const calledName of calls) {
          // Find matching function node
          const targetNode = nodes.find(n => 
            n.nodeType === NodeType.FUNCTION && n.name === calledName
          );
          
          if (targetNode) {
            edges.push({
              projectId: context.projectId,
              versionId: context.versionId,
              sourceNodeId: node.nodeKey,
              targetNodeId: targetNode.nodeKey,
              edgeType: EdgeType.CALLS,
              callType: 'direct'
            });
          }
        }
      }

      // Create containment edges (class contains method, etc.)
      if (node.nodeType === NodeType.CLASS) {
        const methods = nodes.filter(n => 
          n.nodeType === NodeType.FUNCTION && 
          n.location.filePath === node.location.filePath &&
          n.location.startLine > node.location.startLine &&
          n.location.endLine < node.location.endLine
        );

        for (const method of methods) {
          edges.push({
            projectId: context.projectId,
            versionId: context.versionId,
            sourceNodeId: node.nodeKey,
            targetNodeId: method.nodeKey,
            edgeType: EdgeType.CONTAINS
          });
        }
      }
    }
  }

  // ============================================================================
  // AST ANALYSIS HELPERS
  // ============================================================================

  private analyzeASTNode(node: ASTNode, language: string): {
    isSignificant: boolean;
    nodeType: NodeType;
    name?: string;
    signature?: string;
    visibility?: 'public' | 'private' | 'protected';
    isAsync?: boolean;
    isStatic?: boolean;
    parameters?: Parameter[];
    returnType?: string;
    docstring?: string;
    dependencies?: string[];
    exports?: string[];
    importedNames?: string[];
    functionCalls?: string[];
  } {
    // Analyze based on node type and language
    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.analyzeTypeScriptNode(node);
      case 'python':
        return this.analyzePythonNode(node);
      default:
        return {
          isSignificant: false,
          nodeType: NodeType.BLOCK,
          functionCalls: []
        };
    }
  }

  private analyzeTypeScriptNode(node: ASTNode): {
    isSignificant: boolean;
    nodeType: NodeType;
    name?: string;
    signature?: string;
    visibility?: 'public' | 'private' | 'protected';
    isAsync?: boolean;
    isStatic?: boolean;
    parameters?: Parameter[];
    returnType?: string;
    docstring?: string;
    dependencies?: string[];
    exports?: string[];
    importedNames?: string[];
    functionCalls?: string[];
  } {
    const result: any = {
      isSignificant: false,
      nodeType: NodeType.BLOCK,
      functionCalls: [] as string[]
    };

    // Function declarations
    if (node.type === 'function_declaration' || node.type === 'method_definition') {
      result.isSignificant = true;
      result.nodeType = NodeType.FUNCTION;
      result.name = this.extractFunctionName(node);
      result.signature = this.extractFunctionSignature(node);
      result.parameters = this.extractParameters(node);
      result.returnType = this.extractReturnType(node);
      result.isAsync = node.text.includes('async');
      result.functionCalls = this.extractFunctionCalls(node);
    }

    // Class declarations
    else if (node.type === 'class_declaration') {
      result.isSignificant = true;
      result.nodeType = NodeType.CLASS;
      result.name = this.extractClassName(node);
    }

    // Interface declarations
    else if (node.type === 'interface_declaration') {
      result.isSignificant = true;
      result.nodeType = NodeType.INTERFACE;
      result.name = this.extractInterfaceName(node);
    }

    // Import statements
    else if (node.type === 'import_statement') {
      result.isSignificant = true;
      result.nodeType = NodeType.IMPORT;
      result.importedNames = this.extractImportedNames(node);
      result.name = result.importedNames?.[0] || 'import';
    }

    // Variable declarations
    else if (node.type === 'variable_declaration' || node.type === 'lexical_declaration') {
      result.isSignificant = this.isSignificantVariable(node);
      if (result.isSignificant) {
        result.nodeType = NodeType.VARIABLE;
        result.name = this.extractVariableName(node);
      }
    }

    return result;
  }

  private analyzePythonNode(node: ASTNode): {
    isSignificant: boolean;
    nodeType: NodeType;
    name?: string;
    signature?: string;
    visibility?: 'public' | 'private' | 'protected';
    isAsync?: boolean;
    isStatic?: boolean;
    parameters?: Parameter[];
    returnType?: string;
    docstring?: string;
    dependencies?: string[];
    exports?: string[];
    importedNames?: string[];
    functionCalls?: string[];
  } {
    // Similar analysis for Python
    // TODO: Implement Python-specific AST analysis
    return {
      isSignificant: false,
      nodeType: NodeType.BLOCK,
      functionCalls: []
    };
  }

  // ============================================================================
  // EXTRACTION HELPERS
  // ============================================================================

  private extractFunctionName(node: ASTNode): string | undefined {
    // Simple regex-based extraction
    const match = node.text.match(/(?:function\s+|const\s+|let\s+|var\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractClassName(node: ASTNode): string | undefined {
    const match = node.text.match(/class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractInterfaceName(node: ASTNode): string | undefined {
    const match = node.text.match(/interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractVariableName(node: ASTNode): string | undefined {
    const match = node.text.match(/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    return match?.[1];
  }

  private extractFunctionSignature(node: ASTNode): string {
    const lines = node.text.split('\n');
    return lines[0]?.trim() || '';
  }

  private extractParameters(node: ASTNode): Parameter[] {
    const match = node.text.match(/\(([^)]*)\)/);
    if (!match?.[1]) return [];

    return match[1].split(',')
      .map(param => param.trim())
      .filter(param => param)
      .map(param => {
        const [name, type] = param.split(':').map(s => s.trim());
        return {
          name: name.replace(/[?=].*$/, ''), // Remove optional/default markers
          type: type,
          isOptional: param.includes('?'),
          isRest: param.startsWith('...')
        };
      });
  }

  private extractReturnType(node: ASTNode): string | undefined {
    const match = node.text.match(/:\s*([^{]+?)\s*[{=]/);
    return match?.[1]?.trim();
  }

  private extractFunctionCalls(node: ASTNode): string[] {
    const calls: string[] = [];
    const callRegex = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let match;
    
    while ((match = callRegex.exec(node.text)) !== null) {
      calls.push(match[1]);
    }
    
    return [...new Set(calls)]; // Remove duplicates
  }

  private extractImportedNames(node: ASTNode): string[] {
    const imports: string[] = [];
    
    // Handle various import patterns
    const patterns = [
      /import\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /import\s*{\s*([^}]+)\s*}/g,
      /import\s*\*\s*as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(node.text)) !== null) {
        if (match[1].includes(',')) {
          // Destructured imports
          imports.push(...match[1].split(',').map(s => s.trim()));
        } else {
          imports.push(match[1]);
        }
      }
    }

    return imports;
  }

  private isSignificantVariable(node: ASTNode): boolean {
    // Consider exports, constants, and complex assignments as significant
    return node.text.includes('export') || 
           node.text.includes('const') ||
           node.text.includes('=') && node.text.length > 50;
  }

  private extractLocation(node: ASTNode, filePath: string): CodeLocation {
    return {
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column
    };
  }

  private calculateComplexity(node: ASTNode): number {
    let complexity = 1;
    const complexityKeywords = ['if', 'else', 'while', 'for', 'switch', 'catch', 'case', '&&', '||'];
    
    for (const keyword of complexityKeywords) {
      const matches = node.text.match(new RegExp(`\\b${keyword}\\b`, 'g'));
      if (matches) {
        complexity += matches.length;
      }
    }
    
    return complexity;
  }

  private generateNodeKey(filePath: string, name: string, location: CodeLocation): string {
    return `${filePath}:${location.startLine}:${name}`;
  }

  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private generateProjectChecksum(rootPath: string): string {
    // Simple checksum based on timestamp
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // ============================================================================
  // POST-PROCESSING
  // ============================================================================

  private async generateNodePurposes(projectId: ProjectId, versionId: VersionId): Promise<void> {
    try {
      // Get all function nodes
      const { data: functionNodes } = await this.storage.queryNodes({
        projectId,
        nodeType: NodeType.FUNCTION,
        limit: 1000
      });

      console.log(`Generating purposes for ${functionNodes.length} functions...`);

      // Generate purposes in batches
      const batchSize = 5;
      for (let i = 0; i < functionNodes.length; i += batchSize) {
        const batch = functionNodes.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (node) => {
          try {
            const purpose = await this.purposeGenerator.generatePurpose({
              content: node.signature || '',
              nodeType: 'function',
              functionName: node.name,
              parameters: node.parameters?.map(p => p.name),
              language: node.language
            } as any);

            await this.storage.updateNode(node.id, { purpose });
          } catch (error) {
            console.error(`Failed to generate purpose for ${node.name}:`, error);
          }
        }));

        // Rate limiting
        if (i + batchSize < functionNodes.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('Purpose generation completed');
    } catch (error) {
      console.error('Failed to generate purposes:', error);
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private async getFilesToProcess(context: GraphBuildContext): Promise<string[]> {
    const files: string[] = [];
    const ig = ignore().add(context.excludePatterns || []);

    return new Promise((resolve) => {
      const walker = walk.walk(context.rootPath);

      walker.on('file', (root, fileStats, next) => {
        const filePath = join(root, fileStats.name);
        const relativePath = relative(context.rootPath, filePath);

        if (!ig.ignores(relativePath) && this.shouldIncludeFile(filePath, context)) {
          files.push(filePath);
        }
        next();
      });

      walker.on('end', () => {
        resolve(files);
      });
    });
  }

  private shouldIncludeFile(filePath: string, context: GraphBuildContext): boolean {
    const ext = extname(filePath);
    const supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
    return supportedExtensions.includes(ext);
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

  private getNodeKeyFromId(nodeId: string): string {
    // In our implementation, we're using nodeKey as temporary ID
    // This should be resolved properly when we have actual database IDs
    return nodeId;
  }
}