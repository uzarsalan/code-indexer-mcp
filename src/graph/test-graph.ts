/**
 * Graph System Testing Suite
 * Tests all components of the Code Property Graph system
 */

import { createClient } from '@supabase/supabase-js';
import { GraphStorageEngine } from './graph-storage.js';
import { GraphBuilder } from './graph-builder.js';
import { GraphQueryEngine } from './graph-query-engine.js';
import { IncrementalGraphUpdater } from './incremental-updater.js';
import { ASTAnalyzer } from '../ast-analyzer.js';
import { CodePurposeGenerator } from '../code-purpose-generator.js';
import { 
  GraphNode, GraphEdge, NodeType, EdgeType,
  GraphBuildContext, FileChange
} from './types.js';
import { supabaseConfig } from '../config.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export class GraphTestSuite {
  private supabase: any;
  private storage: GraphStorageEngine;
  private queryEngine: GraphQueryEngine;
  private graphBuilder: GraphBuilder;
  private incrementalUpdater: IncrementalGraphUpdater;
  private astAnalyzer: ASTAnalyzer;
  private purposeGenerator: CodePurposeGenerator;

  constructor() {
    this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    this.storage = new GraphStorageEngine(this.supabase);
    this.queryEngine = new GraphQueryEngine(this.storage);
    this.astAnalyzer = new ASTAnalyzer();
    this.purposeGenerator = new CodePurposeGenerator();
    this.graphBuilder = new GraphBuilder(
      this.astAnalyzer,
      this.purposeGenerator,
      this.storage
    );
    this.incrementalUpdater = new IncrementalGraphUpdater(
      this.storage,
      this.graphBuilder,
      this.astAnalyzer
    );
  }

  async runFullTestSuite(): Promise<void> {
    console.log('🚀 Starting Code Property Graph Test Suite...\n');

    try {
      await this.testDatabaseConnection();
      await this.testBasicStorageOperations();
      await this.testGraphBuilding();
      await this.testQueryEngine();
      await this.testIncrementalUpdates();
      await this.testAdvancedAnalysis();

      console.log('\n✅ All tests completed successfully!');
    } catch (error) {
      console.error('\n❌ Test suite failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST DATABASE CONNECTION
  // ============================================================================

  async testDatabaseConnection(): Promise<void> {
    console.log('📊 Testing database connection...');

    try {
      // Test basic connection
      const { data, error } = await this.supabase
        .from('projects')
        .select('count(*)')
        .limit(1);

      if (error) {
        throw new Error(`Database connection failed: ${error.message}`);
      }

      console.log('✅ Database connection successful');

      // Test graph-specific tables
      const { data: graphData, error: graphError } = await this.supabase
        .from('graph_nodes')
        .select('count(*)')
        .limit(1);

      if (graphError) {
        throw new Error(`Graph tables not found: ${graphError.message}`);
      }

      console.log('✅ Graph tables accessible');
    } catch (error) {
      console.error('❌ Database connection test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST BASIC STORAGE OPERATIONS
  // ============================================================================

  async testBasicStorageOperations(): Promise<void> {
    console.log('\n🔧 Testing basic storage operations...');

    try {
      // Create test project
      const { data: project } = await this.supabase
        .from('projects')
        .insert({
          name: 'test-graph-project',
          path: '/test/path',
          description: 'Test project for graph testing'
        })
        .select()
        .single();

      const projectId = project.id;
      console.log(`📁 Created test project: ${projectId}`);

      // Test version management
      const versionId = await this.storage.createNewVersion(projectId);
      console.log(`📋 Created version: ${versionId}`);

      const version = await this.storage.getVersion(versionId);
      if (!version) {
        throw new Error('Failed to retrieve created version');
      }
      console.log('✅ Version management working');

      // Test node operations
      const testNode: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> = {
        projectId,
        versionId,
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

      const nodeId = await this.storage.addNode(testNode);
      console.log(`📦 Created test node: ${nodeId}`);

      const retrievedNode = await this.storage.getNode(nodeId);
      if (!retrievedNode || retrievedNode.name !== 'testFunction') {
        throw new Error('Failed to retrieve created node');
      }
      console.log('✅ Node CRUD operations working');

      // Test edge operations
      const testEdge: Omit<GraphEdge, 'id' | 'createdAt'> = {
        projectId,
        versionId,
        sourceNodeId: nodeId,
        targetNodeId: nodeId, // Self-reference for testing
        edgeType: EdgeType.CALLS,
        weight: 1.0
      };

      const edgeId = await this.storage.addEdge(testEdge);
      console.log(`🔗 Created test edge: ${edgeId}`);

      const retrievedEdge = await this.storage.getEdge(edgeId);
      if (!retrievedEdge || retrievedEdge.edgeType !== EdgeType.CALLS) {
        throw new Error('Failed to retrieve created edge');
      }
      console.log('✅ Edge CRUD operations working');

      // Cleanup
      await this.storage.deleteEdge(edgeId);
      await this.storage.deleteNode(nodeId);
      await this.supabase.from('projects').delete().eq('id', projectId);
      console.log('🧹 Cleanup completed');

    } catch (error) {
      console.error('❌ Basic storage operations test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST GRAPH BUILDING
  // ============================================================================

  async testGraphBuilding(): Promise<void> {
    console.log('\n🏗️ Testing graph building from code...');

    try {
      // Create sample TypeScript files for testing
      await this.createSampleProject();

      // Create test project
      const { data: project } = await this.supabase
        .from('projects')
        .insert({
          name: 'sample-typescript-project',
          path: '/tmp/graph-test',
          description: 'Sample project for graph building test'
        })
        .select()
        .single();

      const projectId = project.id;

      // Build graph context
      const context: GraphBuildContext = {
        projectId,
        versionId: '', // Will be set by builder
        rootPath: '/tmp/graph-test',
        includePatterns: ['**/*.ts'],
        excludePatterns: ['node_modules/**'],
        languages: ['typescript']
      };

      // Build graph
      console.log('🔄 Building graph from sample code...');
      const result = await this.graphBuilder.buildGraphFromProject(context);

      if (!result.success) {
        throw new Error(`Graph building failed: ${result.errors?.join(', ')}`);
      }

      console.log(`✅ Graph built successfully:`);
      console.log(`   - Nodes: ${result.nodesAffected}`);
      console.log(`   - Edges: ${result.edgesAffected}`);
      console.log(`   - Time: ${result.executionTimeMs}ms`);

      // Verify nodes were created
      const nodeCount = await this.storage.queryNodes({
        projectId,
        limit: 1000
      });

      if (nodeCount.totalCount === 0) {
        throw new Error('No nodes were created during graph building');
      }

      console.log(`✅ Created ${nodeCount.totalCount} nodes`);

      // Test specific node types
      const functions = await this.storage.queryNodes({
        projectId,
        nodeType: NodeType.FUNCTION,
        limit: 100
      });

      const classes = await this.storage.queryNodes({
        projectId,
        nodeType: NodeType.CLASS,
        limit: 100
      });

      console.log(`📊 Node breakdown:`);
      console.log(`   - Functions: ${functions.totalCount}`);
      console.log(`   - Classes: ${classes.totalCount}`);

      // Cleanup
      await this.supabase.from('projects').delete().eq('id', projectId);
      await this.cleanupSampleProject();

    } catch (error) {
      console.error('❌ Graph building test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST QUERY ENGINE
  // ============================================================================

  async testQueryEngine(): Promise<void> {
    console.log('\n🔍 Testing query engine...');

    try {
      // Create test data
      const projectId = await this.createTestGraphData();

      // Test basic node search
      console.log('🔎 Testing node search...');
      const searchResults = await this.queryEngine.findNodesByName(
        projectId,
        'testFunction',
        { fuzzy: false }
      );

      if (searchResults.length === 0) {
        throw new Error('Failed to find test function');
      }
      console.log(`✅ Found ${searchResults.length} nodes by name`);

      // Test fuzzy search
      const fuzzyResults = await this.queryEngine.findNodesByName(
        projectId,
        'testFunc',
        { fuzzy: true }
      );
      console.log(`✅ Fuzzy search found ${fuzzyResults.length} results`);

      // Test relationship queries
      const testNodeId = searchResults[0].node.id;
      console.log('🔗 Testing relationship queries...');

      const dependencies = await this.queryEngine.findDependencies(testNodeId, {
        maxDepth: 3
      });
      console.log(`✅ Found ${dependencies.length} dependencies`);

      // Test graph statistics
      const stats = await this.storage.getGraphStatistics(projectId);
      console.log(`📊 Graph statistics:`);
      console.log(`   - Total nodes: ${stats.totalNodes}`);
      console.log(`   - Total edges: ${stats.totalEdges}`);
      console.log(`   - Total files: ${stats.totalFiles}`);

      // Cleanup
      await this.supabase.from('projects').delete().eq('id', projectId);

    } catch (error) {
      console.error('❌ Query engine test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST INCREMENTAL UPDATES
  // ============================================================================

  async testIncrementalUpdates(): Promise<void> {
    console.log('\n⚡ Testing incremental updates...');

    try {
      // Create initial graph
      const projectId = await this.createTestGraphData();
      const currentVersion = await this.storage.getCurrentVersion(projectId);

      if (!currentVersion) {
        throw new Error('No current version found');
      }

      // Simulate file changes
      const fileChanges: FileChange[] = [
        {
          filePath: 'src/test.ts',
          changeType: 'modified',
          oldContent: 'function oldFunction() { return 1; }',
          newContent: 'function newFunction() { return 2; }'
        },
        {
          filePath: 'src/new.ts',
          changeType: 'added',
          newContent: 'export class NewClass { method() {} }'
        }
      ];

      const context: GraphBuildContext = {
        projectId,
        versionId: currentVersion,
        rootPath: '/tmp/test',
        includePatterns: ['**/*.ts'],
        excludePatterns: [],
        languages: ['typescript']
      };

      console.log('🔄 Applying incremental updates...');
      const updateResult = await this.incrementalUpdater.updateFromFileChanges(
        projectId,
        fileChanges,
        context
      );

      if (!updateResult.success) {
        throw new Error(`Incremental update failed: ${updateResult.errors?.join(', ')}`);
      }

      console.log(`✅ Incremental update successful:`);
      console.log(`   - Operations: ${updateResult.operationsApplied}`);
      console.log(`   - Nodes affected: ${updateResult.nodesAffected}`);
      console.log(`   - Time: ${updateResult.executionTimeMs}ms`);

      // Verify version was created
      const newVersion = await this.storage.getVersion(updateResult.versionId);
      if (!newVersion || newVersion.versionNumber <= 1) {
        throw new Error('New version was not created properly');
      }
      console.log(`✅ New version created: ${newVersion.versionNumber}`);

      // Cleanup
      await this.supabase.from('projects').delete().eq('id', projectId);

    } catch (error) {
      console.error('❌ Incremental updates test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // TEST ADVANCED ANALYSIS
  // ============================================================================

  async testAdvancedAnalysis(): Promise<void> {
    console.log('\n🧠 Testing advanced analysis...');

    try {
      // Create complex test graph with cycles
      const projectId = await this.createComplexTestGraphData();

      // Test circular dependency detection
      console.log('🔄 Testing circular dependency detection...');
      const cycles = await this.queryEngine.findCircularDependencies(projectId);
      console.log(`✅ Found ${cycles.length} circular dependencies`);

      // Test impact analysis
      const nodes = await this.storage.queryNodes({
        projectId,
        nodeType: NodeType.FUNCTION,
        limit: 1
      });

      if (nodes.data.length > 0) {
        console.log('📊 Testing impact analysis...');
        const impact = await this.queryEngine.analyzeImpact(nodes.data[0].id);
        console.log(`✅ Impact analysis:`);
        console.log(`   - Risk level: ${impact.riskLevel}`);
        console.log(`   - Direct impact: ${impact.directlyAffected.length}`);
        console.log(`   - Indirect impact: ${impact.indirectlyAffected.length}`);
        console.log(`   - Files affected: ${impact.affectedFiles.length}`);
      }

      // Test bottleneck detection
      console.log('🎯 Testing bottleneck detection...');
      const bottlenecks = await this.queryEngine.findBottlenecks(projectId);
      console.log(`✅ Found ${bottlenecks.length} potential bottlenecks`);

      if (bottlenecks.length > 0) {
        const top = bottlenecks[0];
        console.log(`   - Top bottleneck: ${top.node.name}`);
        console.log(`   - Centrality: ${top.centrality.toFixed(2)}`);
        console.log(`   - Connections: ${top.totalConnections}`);
      }

      // Cleanup
      await this.supabase.from('projects').delete().eq('id', projectId);

    } catch (error) {
      console.error('❌ Advanced analysis test failed:', error);
      throw error;
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async createSampleProject(): Promise<void> {
    const testDir = '/tmp/graph-test';
    
    // Create directory structure
    await fs.mkdir(testDir, { recursive: true });
    
    // Create sample TypeScript files
    const sampleFiles = {
      'auth.ts': `
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
      `,
      'user.ts': `
export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private users: User[] = [];
  
  async getUser(id: string): Promise<User | null> {
    return this.users.find(user => user.id === id) || null;
  }
  
  async createUser(userData: Omit<User, 'id'>): Promise<User> {
    const user: User = {
      id: Math.random().toString(36),
      ...userData
    };
    this.users.push(user);
    return user;
  }
}
      `,
      'app.ts': `
import { AuthService } from './auth.js';
import { UserService } from './user.js';

export class Application {
  private auth: AuthService;
  private users: UserService;
  
  constructor() {
    this.auth = new AuthService('api-key-123');
    this.users = new UserService();
  }
  
  async start(): Promise<void> {
    console.log('Application starting...');
    await this.initialize();
  }
  
  private async initialize(): Promise<void> {
    // Application initialization logic
  }
}
      `
    };

    for (const [filename, content] of Object.entries(sampleFiles)) {
      await fs.writeFile(join(testDir, filename), content);
    }
  }

  private async cleanupSampleProject(): Promise<void> {
    try {
      await fs.rm('/tmp/graph-test', { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  private async createTestGraphData(): Promise<string> {
    // Create test project with some nodes and edges
    const { data: project } = await this.supabase
      .from('projects')
      .insert({
        name: 'test-query-project',
        path: '/test/query',
        description: 'Test project for query testing'
      })
      .select()
      .single();

    const projectId = project.id;
    const versionId = await this.storage.createNewVersion(projectId);

    // Create test nodes
    const functionNode = await this.storage.addNode({
      projectId,
      versionId,
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
      hash: 'test-hash-func'
    });

    const classNode = await this.storage.addNode({
      projectId,
      versionId,
      nodeKey: 'test.ts:10:TestClass',
      nodeType: NodeType.CLASS,
      location: {
        filePath: 'test.ts',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 10
      },
      name: 'TestClass',
      signature: 'class TestClass',
      language: 'typescript',
      hash: 'test-hash-class'
    });

    // Create test edge
    await this.storage.addEdge({
      projectId,
      versionId,
      sourceNodeId: functionNode,
      targetNodeId: classNode,
      edgeType: EdgeType.USES
    });

    return projectId;
  }

  private async createComplexTestGraphData(): Promise<string> {
    // Create a more complex graph with potential cycles for advanced testing
    const { data: project } = await this.supabase
      .from('projects')
      .insert({
        name: 'complex-test-project',
        path: '/test/complex',
        description: 'Complex test project for advanced analysis'
      })
      .select()
      .single();

    const projectId = project.id;
    const versionId = await this.storage.createNewVersion(projectId);

    // Create multiple interconnected nodes
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      const nodeId = await this.storage.addNode({
        projectId,
        versionId,
        nodeKey: `test.ts:${i * 10}:function${i}`,
        nodeType: NodeType.FUNCTION,
        location: {
          filePath: 'test.ts',
          startLine: i * 10,
          endLine: i * 10 + 5,
          startColumn: 0,
          endColumn: 10
        },
        name: `function${i}`,
        signature: `function function${i}(): void`,
        language: 'typescript',
        hash: `test-hash-${i}`,
        complexity: i + 1
      });
      nodes.push(nodeId);
    }

    // Create edges to form a complex graph with potential cycles
    for (let i = 0; i < nodes.length; i++) {
      const nextIndex = (i + 1) % nodes.length;
      await this.storage.addEdge({
        projectId,
        versionId,
        sourceNodeId: nodes[i],
        targetNodeId: nodes[nextIndex],
        edgeType: EdgeType.CALLS
      });
    }

    return projectId;
  }
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

export async function runGraphTests(): Promise<void> {
  const testSuite = new GraphTestSuite();
  await testSuite.runFullTestSuite();
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runGraphTests().catch(console.error);
}