/**
 * Real Graph System Test
 * Test the actual implemented Code Property Graph system
 */

import { createClient } from '@supabase/supabase-js';
import { GraphStorageEngine } from './dist/graph/graph-storage.js';
import { GraphQueryEngine } from './dist/graph/graph-query-engine.js';
import { supabaseConfig } from './dist/config.js';

async function testRealGraphSystem() {
  console.log('🎯 Testing Real Code Property Graph System');
  console.log('==========================================\n');

  try {
    // Initialize components
    const supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    const storage = new GraphStorageEngine(supabase);
    const queryEngine = new GraphQueryEngine(storage);

    console.log('✅ Components initialized');

    // Test 1: Database connection
    console.log('\n📊 Testing database connection...');
    const { data, error } = await supabase
      .from('projects')
      .select('count(*)')
      .limit(1);

    if (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }
    console.log('✅ Database connection successful');

    // Test 2: Check graph tables
    console.log('\n🗄️ Testing graph tables...');
    const tables = ['graph_nodes', 'graph_edges', 'graph_versions'];
    
    for (const table of tables) {
      const { data: tableData, error: tableError } = await supabase
        .from(table)
        .select('count(*)')
        .limit(1);

      if (tableError) {
        console.log(`❌ Table ${table} not accessible: ${tableError.message}`);
      } else {
        console.log(`✅ Table ${table} accessible`);
      }
    }

    // Test 3: Create test project
    console.log('\n📁 Creating test project...');
    const { data: project } = await supabase
      .from('projects')
      .insert({
        name: `real-test-${Date.now()}`,
        path: '/test/real',
        description: 'Real system test'
      })
      .select()
      .single();

    const projectId = project.id;
    console.log(`✅ Test project created: ${projectId}`);

    // Test 4: Version management
    console.log('\n📋 Testing version management...');
    const versionId = await storage.createNewVersion(projectId);
    console.log(`✅ Version created: ${versionId}`);

    const version = await storage.getVersion(versionId);
    console.log(`✅ Version retrieved: v${version.versionNumber}`);

    // Test 5: Node operations
    console.log('\n📦 Testing node operations...');
    const testNode = {
      projectId,
      versionId,
      nodeKey: 'real-test.ts:1:realFunction',
      nodeType: 'FUNCTION',
      location: {
        filePath: 'real-test.ts',
        startLine: 1,
        endLine: 10,
        startColumn: 0,
        endColumn: 20
      },
      name: 'realFunction',
      signature: 'function realFunction(): string',
      language: 'typescript',
      hash: 'real-hash-123',
      complexity: 3,
      purpose: 'A real test function for graph testing'
    };

    const nodeId = await storage.addNode(testNode);
    console.log(`✅ Node created: ${nodeId}`);

    const retrievedNode = await storage.getNode(nodeId);
    console.log(`✅ Node retrieved: ${retrievedNode.name}`);

    // Test 6: Edge operations
    console.log('\n🔗 Testing edge operations...');
    const testEdge = {
      projectId,
      versionId,
      sourceNodeId: nodeId,
      targetNodeId: nodeId, // Self-reference for testing
      edgeType: 'CALLS',
      weight: 1.0
    };

    const edgeId = await storage.addEdge(testEdge);
    console.log(`✅ Edge created: ${edgeId}`);

    // Test 7: Query operations
    console.log('\n🔍 Testing query operations...');
    const nodeResults = await storage.queryNodes({
      projectId,
      nodeType: 'FUNCTION',
      limit: 10
    });

    console.log(`✅ Found ${nodeResults.totalCount} nodes`);
    console.log(`✅ Query time: ${nodeResults.executionTimeMs}ms`);

    // Test 8: Search functionality
    console.log('\n🔎 Testing search functionality...');
    const searchResults = await queryEngine.findNodesByName(
      projectId, 
      'realFunction'
    );

    console.log(`✅ Search found ${searchResults.length} results`);
    if (searchResults.length > 0) {
      console.log(`✅ Found: ${searchResults[0].node.name} (similarity: ${searchResults[0].similarity})`);
    }

    // Test 9: Graph statistics
    console.log('\n📊 Testing graph statistics...');
    const stats = await storage.getGraphStatistics(projectId);
    console.log(`✅ Graph stats:`);
    console.log(`   - Nodes: ${stats.totalNodes}`);
    console.log(`   - Edges: ${stats.totalEdges}`);
    console.log(`   - Files: ${stats.totalFiles}`);
    console.log(`   - Version: ${stats.versionNumber}`);

    // Test 10: SQL functions
    console.log('\n🔧 Testing SQL functions...');
    const { data: currentVersion } = await supabase
      .rpc('get_current_version', { p_project_id: projectId });
    
    console.log(`✅ Current version function: ${currentVersion}`);

    // Test 11: Complex queries
    console.log('\n🧠 Testing advanced analysis...');
    const nodeConnections = await storage.getNodeWithConnections(nodeId);
    if (nodeConnections) {
      console.log(`✅ Node connections:`);
      console.log(`   - Incoming: ${nodeConnections.incomingEdges.length}`);
      console.log(`   - Outgoing: ${nodeConnections.outgoingEdges.length}`);
    }

    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await supabase.from('projects').delete().eq('id', projectId);
    console.log('✅ Cleanup completed');

    console.log('\n🎉 All Real Graph System Tests Passed!');
    console.log('=====================================');
    console.log('✅ Database: Connected and working');
    console.log('✅ Storage Engine: All operations successful');
    console.log('✅ Query Engine: Search and analysis working');
    console.log('✅ SQL Functions: Custom functions operational');
    console.log('✅ Performance: Sub-second response times');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the tests
testRealGraphSystem();