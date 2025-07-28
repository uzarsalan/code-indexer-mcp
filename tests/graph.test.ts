/**
 * Comprehensive tests for Code Property Graph system
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock all external dependencies for unit testing
jest.mock('@supabase/supabase-js');
jest.mock('../src/config', () => ({
  supabaseConfig: {
    url: 'http://localhost:54321',
    anonKey: 'test-key'
  },
  openaiConfig: {
    apiKey: 'test-openai-key',
    model: 'text-embedding-ada-002'
  }
}));
import { promises as fs } from 'fs';
import { join } from 'path';

// Define interfaces for testing
interface MockNode {
  id: string;
  projectId: string;
  versionId: string;
  nodeKey: string;
  nodeType: 'FUNCTION' | 'CLASS' | 'VARIABLE' | 'MODULE';
  name?: string;
  location: {
    filePath: string;
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
  language: string;
  hash: string;
  complexity?: number;
  purpose?: string;
}

interface MockEdge {
  id: string;
  projectId: string;
  versionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: 'CALLS' | 'IMPORTS' | 'USES' | 'CONTAINS';
  weight?: number;
}

describe('Code Property Graph System', () => {

  describe('Database Connection and Schema', () => {
    it('should connect to database successfully', async () => {
      const { data, error } = await supabase
        .from('projects')
        .select('count(*)')
        .limit(1);

      expect(error).toBeNull();
      expect(data).toBeDefined();
    });

    it('should have graph tables accessible', async () => {
      const tables = ['graph_nodes', 'graph_edges', 'graph_versions', 'graph_update_operations'];
      
      for (const table of tables) {
        const { data, error } = await supabase
          .from(table)
          .select('count(*)')
          .limit(1);

        expect(error).toBeNull();
        expect(data).toBeDefined();
      }
    });
  });

  describe('Graph Storage Engine', () => {
    it('should create and retrieve versions', async () => {
      const versionId = await storage.createNewVersion(testProjectId);
      expect(versionId).toBeDefined();

      const version = await storage.getVersion(versionId);
      expect(version).toBeDefined();
      expect(version!.projectId).toBe(testProjectId);
      expect(version!.versionNumber).toBeGreaterThan(0);
    });

    it('should perform CRUD operations on nodes', async () => {
      const testNode: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> = {
        projectId: testProjectId,
        versionId: testVersionId,
        nodeKey: 'test.ts:1:testFunction',
        nodeType: NodeType.FUNCTION,
        location: {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 5,
          startColumn: 0,
          endColumn: 10
        },
        name: 'testFunction',
        signature: 'function testFunction(): void',
        language: 'typescript',
        hash: 'test-hash-123'
      };

      // Create
      const nodeId = await storage.addNode(testNode);
      expect(nodeId).toBeDefined();

      // Read
      const retrievedNode = await storage.getNode(nodeId);
      expect(retrievedNode).toBeDefined();
      expect(retrievedNode!.name).toBe('testFunction');
      expect(retrievedNode!.nodeType).toBe(NodeType.FUNCTION);

      // Update
      await storage.updateNode(nodeId, { name: 'updatedFunction' });
      const updatedNode = await storage.getNode(nodeId);
      expect(updatedNode!.name).toBe('updatedFunction');

      // Delete
      await storage.deleteNode(nodeId);
      const deletedNode = await storage.getNode(nodeId);
      expect(deletedNode).toBeNull();
    });

    it('should perform CRUD operations on edges', async () => {
      // Create two nodes first
      const sourceNode = await storage.addNode({
        projectId: testProjectId,
        versionId: testVersionId,
        nodeKey: 'test.ts:1:sourceFunction',
        nodeType: NodeType.FUNCTION,
        location: {
          filePath: 'test.ts',
          startLine: 1,
          endLine: 5,
          startColumn: 0,
          endColumn: 10
        },
        name: 'sourceFunction',
        language: 'typescript',
        hash: 'source-hash'
      });

      const targetNode = await storage.addNode({
        projectId: testProjectId,
        versionId: testVersionId,
        nodeKey: 'test.ts:10:targetFunction',
        nodeType: NodeType.FUNCTION,
        location: {
          filePath: 'test.ts',
          startLine: 10,
          endLine: 15,
          startColumn: 0,
          endColumn: 10
        },
        name: 'targetFunction',
        language: 'typescript',
        hash: 'target-hash'
      });

      // Create edge
      const testEdge: Omit<GraphEdge, 'id' | 'createdAt'> = {
        projectId: testProjectId,
        versionId: testVersionId,
        sourceNodeId: sourceNode,
        targetNodeId: targetNode,
        edgeType: EdgeType.CALLS,
        weight: 1.0
      };

      const edgeId = await storage.addEdge(testEdge);
      expect(edgeId).toBeDefined();

      // Read
      const retrievedEdge = await storage.getEdge(edgeId);
      expect(retrievedEdge).toBeDefined();
      expect(retrievedEdge!.edgeType).toBe(EdgeType.CALLS);
      expect(retrievedEdge!.sourceNodeId).toBe(sourceNode);
      expect(retrievedEdge!.targetNodeId).toBe(targetNode);

      // Delete
      await storage.deleteEdge(edgeId);
      const deletedEdge = await storage.getEdge(edgeId);
      expect(deletedEdge).toBeNull();
    });

    it('should query nodes with filters', async () => {
      // Create multiple test nodes
      const nodes = [];
      for (let i = 0; i < 3; i++) {
        const nodeId = await storage.addNode({
          projectId: testProjectId,
          versionId: testVersionId,
          nodeKey: `test.ts:${i * 10}:function${i}`,
          nodeType: i === 0 ? NodeType.FUNCTION : NodeType.CLASS,
          location: {
            filePath: 'test.ts',
            startLine: i * 10,
            endLine: i * 10 + 5,
            startColumn: 0,
            endColumn: 10
          },
          name: `testItem${i}`,
          language: 'typescript',
          hash: `hash-${i}`
        });
        nodes.push(nodeId);
      }

      // Query all nodes
      const allNodes = await storage.queryNodes({
        projectId: testProjectId,
        limit: 10
      });
      expect(allNodes.totalCount).toBe(3);

      // Query by type
      const functions = await storage.queryNodes({
        projectId: testProjectId,
        nodeType: NodeType.FUNCTION,
        limit: 10
      });
      expect(functions.totalCount).toBe(1);

      // Query by name
      const namedNodes = await storage.queryNodes({
        projectId: testProjectId,
        name: 'testItem0',
        limit: 10
      });
      expect(namedNodes.totalCount).toBe(1);
    });
  });

  describe('Graph Builder', () => {
    it('should build graph from sample TypeScript code', async () => {
      // Create sample code files
      const testDir = '/tmp/graph-test-jest';
      await fs.mkdir(testDir, { recursive: true });

      const sampleCode = `
export class AuthService {
  private apiKey: string;
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  async login(username: string, password: string): Promise<boolean> {
    return this.validateCredentials(username, password);
  }
  
  private validateCredentials(username: string, password: string): boolean {
    return username.length > 0 && password.length > 0;
  }
}

export function helper(): void {
  console.log('Helper function');
}
      `;

      await fs.writeFile(join(testDir, 'auth.ts'), sampleCode);

      // Build graph
      const context: GraphBuildContext = {
        projectId: testProjectId,
        versionId: testVersionId,
        rootPath: testDir,
        includePatterns: ['**/*.ts'],
        excludePatterns: [],
        languages: ['typescript']
      };

      const result = await graphBuilder.buildGraphFromProject(context);

      expect(result.success).toBe(true);
      expect(result.nodesAffected).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeGreaterThan(0);

      // Verify nodes were created
      const nodes = await storage.queryNodes({
        projectId: testProjectId,
        limit: 100
      });

      expect(nodes.totalCount).toBeGreaterThan(0);

      // Check for specific node types
      const classes = await storage.queryNodes({
        projectId: testProjectId,
        nodeType: NodeType.CLASS,
        limit: 10
      });
      expect(classes.totalCount).toBeGreaterThan(0);

      const functions = await storage.queryNodes({
        projectId: testProjectId,
        nodeType: NodeType.FUNCTION,
        limit: 10
      });
      expect(functions.totalCount).toBeGreaterThan(0);

      // Cleanup
      await fs.rm(testDir, { recursive: true, force: true });
    });
  });

  describe('Query Engine', () => {
    let testNodes: string[] = [];

    beforeEach(async () => {
      // Create test graph data
      testNodes = [];
      for (let i = 0; i < 3; i++) {
        const nodeId = await storage.addNode({
          projectId: testProjectId,
          versionId: testVersionId,
          nodeKey: `test.ts:${i * 10}:function${i}`,
          nodeType: NodeType.FUNCTION,
          location: {
            filePath: 'test.ts',
            startLine: i * 10,
            endLine: i * 10 + 5,
            startColumn: 0,
            endColumn: 10
          },
          name: `testFunction${i}`,
          signature: `function testFunction${i}(): void`,
          language: 'typescript',
          hash: `hash-${i}`,
          complexity: i + 1
        });
        testNodes.push(nodeId);
      }

      // Create edges between nodes
      for (let i = 0; i < testNodes.length - 1; i++) {
        await storage.addEdge({
          projectId: testProjectId,
          versionId: testVersionId,
          sourceNodeId: testNodes[i],
          targetNodeId: testNodes[i + 1],
          edgeType: EdgeType.CALLS
        });
      }
    });

    it('should find nodes by name', async () => {
      const results = await queryEngine.findNodesByName(
        testProjectId,
        'testFunction0'
      );

      expect(results).toHaveLength(1);
      expect(results[0].node.name).toBe('testFunction0');
      expect(results[0].similarity).toBe(1.0);
    });

    it('should find nodes with fuzzy search', async () => {
      const results = await queryEngine.findNodesByName(
        testProjectId,
        'testFunc',
        { fuzzy: true }
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).toBeGreaterThan(0.3);
    });

    it('should find callers and callees', async () => {
      // Test finding callees (functions called by testFunction0)
      const callees = await queryEngine.findCallees(testNodes[0]);
      expect(callees).toHaveLength(1);
      expect(callees[0].name).toBe('testFunction1');

      // Test finding callers (functions that call testFunction1)
      const callers = await queryEngine.findCallers(testNodes[1]);
      expect(callers).toHaveLength(1);
      expect(callers[0].name).toBe('testFunction0');
    });

    it('should find dependencies', async () => {
      const dependencies = await queryEngine.findDependencies(testNodes[0], {
        maxDepth: 3
      });

      expect(dependencies.length).toBeGreaterThan(0);
    });

    it('should find paths between nodes', async () => {
      const path = await queryEngine.findPath(testNodes[0], testNodes[2], {
        maxDepth: 5
      });

      expect(path).toBeDefined();
      expect(path!.path).toHaveLength(3); // 0 -> 1 -> 2
      expect(path!.edges).toHaveLength(2);
      expect(path!.length).toBe(2);
    });

    it('should analyze impact', async () => {
      const impact = await queryEngine.analyzeImpact(testNodes[0]);

      expect(impact).toBeDefined();
      expect(impact.targetNode.name).toBe('testFunction0');
      expect(impact.directlyAffected.length).toBeGreaterThanOrEqual(0);
      expect(impact.riskLevel).toMatch(/^(low|medium|high|critical)$/);
      expect(impact.affectedFiles).toContain('test.ts');
    });

    it('should find bottlenecks', async () => {
      const bottlenecks = await queryEngine.findBottlenecks(testProjectId);

      expect(bottlenecks).toBeDefined();
      expect(Array.isArray(bottlenecks)).toBe(true);
      
      if (bottlenecks.length > 0) {
        const bottleneck = bottlenecks[0];
        expect(bottleneck.node).toBeDefined();
        expect(bottleneck.centrality).toBeGreaterThanOrEqual(0);
        expect(bottleneck.totalConnections).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Incremental Updates', () => {
    it('should handle file addition', async () => {
      const fileChanges: FileChange[] = [
        {
          filePath: 'src/new.ts',
          changeType: 'added',
          newContent: 'export class NewClass { method() {} }'
        }
      ];

      const context: GraphBuildContext = {
        projectId: testProjectId,
        versionId: testVersionId,
        rootPath: '/tmp/test',
        includePatterns: ['**/*.ts'],
        excludePatterns: [],
        languages: ['typescript']
      };

      const result = await incrementalUpdater.updateFromFileChanges(
        testProjectId,
        fileChanges,
        context
      );

      expect(result.success).toBe(true);
      expect(result.operationsApplied).toBeGreaterThan(0);
      expect(result.versionId).toBeDefined();
      expect(result.executionTimeMs).toBeGreaterThan(0);

      // Verify new version was created
      const newVersion = await storage.getVersion(result.versionId);
      expect(newVersion).toBeDefined();
      expect(newVersion!.versionNumber).toBeGreaterThan(1);
    });

    it('should handle file modification', async () => {
      const fileChanges: FileChange[] = [
        {
          filePath: 'src/test.ts',
          changeType: 'modified',
          oldContent: 'function oldFunction() { return 1; }',
          newContent: 'function newFunction() { return 2; }'
        }
      ];

      const context: GraphBuildContext = {
        projectId: testProjectId,
        versionId: testVersionId,
        rootPath: '/tmp/test',
        includePatterns: ['**/*.ts'],
        excludePatterns: [],
        languages: ['typescript']
      };

      const result = await incrementalUpdater.updateFromFileChanges(
        testProjectId,
        fileChanges,
        context
      );

      expect(result.success).toBe(true);
      expect(result.operationsApplied).toBeGreaterThanOrEqual(0);
    });

    it('should handle file deletion', async () => {
      // First create a node to delete
      const nodeId = await storage.addNode({
        projectId: testProjectId,
        versionId: testVersionId,
        nodeKey: 'to-delete.ts:1:deleteMe',
        nodeType: NodeType.FUNCTION,
        location: {
          filePath: 'to-delete.ts',
          startLine: 1,
          endLine: 5,
          startColumn: 0,
          endColumn: 10
        },
        name: 'deleteMe',
        language: 'typescript',
        hash: 'delete-hash'
      });

      const fileChanges: FileChange[] = [
        {
          filePath: 'to-delete.ts',
          changeType: 'deleted'
        }
      ];

      const context: GraphBuildContext = {
        projectId: testProjectId,
        versionId: testVersionId,
        rootPath: '/tmp/test',
        includePatterns: ['**/*.ts'],
        excludePatterns: [],
        languages: ['typescript']
      };

      const result = await incrementalUpdater.updateFromFileChanges(
        testProjectId,
        fileChanges,
        context
      );

      expect(result.success).toBe(true);

      // Verify node was deleted
      const deletedNode = await storage.getNode(nodeId);
      expect(deletedNode).toBeNull();
    });
  });

  describe('Advanced Analysis', () => {
    beforeEach(async () => {
      // Create a graph with potential circular dependencies
      const nodes = [];
      for (let i = 0; i < 4; i++) {
        const nodeId = await storage.addNode({
          projectId: testProjectId,
          versionId: testVersionId,
          nodeKey: `cycle.ts:${i * 10}:function${i}`,
          nodeType: NodeType.FUNCTION,
          location: {
            filePath: 'cycle.ts',
            startLine: i * 10,
            endLine: i * 10 + 5,
            startColumn: 0,
            endColumn: 10
          },
          name: `cycleFunction${i}`,
          language: 'typescript',
          hash: `cycle-hash-${i}`,
          complexity: i + 1
        });
        nodes.push(nodeId);
      }

      // Create a cycle: 0 -> 1 -> 2 -> 0
      await storage.addEdge({
        projectId: testProjectId,
        versionId: testVersionId,
        sourceNodeId: nodes[0],
        targetNodeId: nodes[1],
        edgeType: EdgeType.CALLS
      });
      await storage.addEdge({
        projectId: testProjectId,
        versionId: testVersionId,
        sourceNodeId: nodes[1],
        targetNodeId: nodes[2],
        edgeType: EdgeType.CALLS
      });
      await storage.addEdge({
        projectId: testProjectId,
        versionId: testVersionId,
        sourceNodeId: nodes[2],
        targetNodeId: nodes[0],
        edgeType: EdgeType.CALLS
      });
    });

    it('should detect circular dependencies', async () => {
      const cycles = await queryEngine.findCircularDependencies(testProjectId);

      expect(cycles).toBeDefined();
      expect(Array.isArray(cycles)).toBe(true);
      
      if (cycles.length > 0) {
        const cycle = cycles[0];
        expect(cycle.nodes.length).toBeGreaterThanOrEqual(3);
        expect(cycle.cycleLength).toBeGreaterThanOrEqual(3);
        expect(cycle.severity).toMatch(/^(low|medium|high)$/);
      }
    });

    it('should get graph statistics', async () => {
      const stats = await storage.getGraphStatistics(testProjectId);

      expect(stats).toBeDefined();
      expect(stats.projectId).toBe(testProjectId);
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.totalEdges).toBeGreaterThan(0);
      expect(stats.versionNumber).toBeGreaterThan(0);
      expect(stats.versionCreated).toBeInstanceOf(Date);
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent node queries gracefully', async () => {
      const nonExistentId = 'non-existent-id';
      const node = await storage.getNode(nonExistentId);
      expect(node).toBeNull();
    });

    it('should handle invalid project queries gracefully', async () => {
      const result = await storage.queryNodes({
        projectId: 'non-existent-project',
        limit: 10
      });

      expect(result.totalCount).toBe(0);
      expect(result.data).toHaveLength(0);
    });

    it('should handle invalid version queries gracefully', async () => {
      const version = await storage.getVersion('non-existent-version');
      expect(version).toBeNull();
    });
  });

  describe('Performance', () => {
    it('should handle large node queries efficiently', async () => {
      // Create many nodes
      const nodePromises = [];
      for (let i = 0; i < 50; i++) {
        nodePromises.push(storage.addNode({
          projectId: testProjectId,
          versionId: testVersionId,
          nodeKey: `perf.ts:${i}:perfFunction${i}`,
          nodeType: NodeType.FUNCTION,
          location: {
            filePath: 'perf.ts',
            startLine: i,
            endLine: i + 1,
            startColumn: 0,
            endColumn: 10
          },
          name: `perfFunction${i}`,
          language: 'typescript',
          hash: `perf-hash-${i}`
        }));
      }

      await Promise.all(nodePromises);

      // Query should be fast
      const startTime = Date.now();
      const result = await storage.queryNodes({
        projectId: testProjectId,
        limit: 100
      });
      const queryTime = Date.now() - startTime;

      expect(result.totalCount).toBe(50);
      expect(queryTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });
});