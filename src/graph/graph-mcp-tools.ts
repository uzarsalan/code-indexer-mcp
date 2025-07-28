/**
 * Graph MCP Tools
 * MCP tools for Code Property Graph functionality
 */

import { createClient } from '@supabase/supabase-js';
import { GraphStorageEngine } from './graph-storage.js';
import { GraphBuilder } from './graph-builder.js';
import { GraphQueryEngine } from './graph-query-engine.js';
import { IncrementalGraphUpdater } from './incremental-updater.js';
import { ASTAnalyzer } from '../ast-analyzer.js';
import { CodePurposeGenerator } from '../code-purpose-generator.js';
import { supabaseConfig } from '../config.js';

/**
 * MCP tools for Graph functionality
 */
export const GRAPH_MCP_TOOLS = [
  {
    name: 'build_project_graph',
    description: 'Build Code Property Graph for a project from source files',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project to build graph for'
        },
        projectPath: {
          type: 'string',
          description: 'Path to the project directory'
        },
        includePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'File patterns to include (e.g., ["**/*.ts", "**/*.js"])',
          default: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx']
        },
        excludePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'File patterns to exclude',
          default: ['node_modules/**', 'dist/**', 'build/**', '**/*.test.*', '**/*.spec.*']
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Programming languages to analyze',
          default: ['typescript', 'javascript']
        }
      },
      required: ['projectName', 'projectPath']
    }
  },
  {
    name: 'get_graph_stats',
    description: 'Get statistics about the Code Property Graph for a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        }
      },
      required: ['projectName']
    }
  },
  {
    name: 'search_graph_nodes',
    description: 'Search for nodes in the Code Property Graph',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        query: {
          type: 'string',
          description: 'Search query'
        },
        nodeTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by node types (FUNCTION, CLASS, VARIABLE, MODULE)',
          default: []
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 10
        },
        fuzzyThreshold: {
          type: 'number',
          description: 'Fuzzy search threshold (0-1)',
          default: 0.3
        }
      },
      required: ['projectName', 'query']
    }
  },
  {
    name: 'get_node_relationships',
    description: 'Get relationships (callers/callees) for a specific node',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        nodeName: {
          type: 'string',
          description: 'Name of the node to analyze'
        },
        relationshipType: {
          type: 'string',
          enum: ['callers', 'callees', 'dependencies', 'all'],
          description: 'Type of relationships to find',
          default: 'all'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum depth for dependency traversal',
          default: 3
        }
      },
      required: ['projectName', 'nodeName']
    }
  },
  {
    name: 'analyze_impact',
    description: 'Analyze the impact of changing a specific node',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        nodeName: {
          type: 'string',
          description: 'Name of the node to analyze impact for'
        }
      },
      required: ['projectName', 'nodeName']
    }
  },
  {
    name: 'find_bottlenecks',
    description: 'Find bottlenecks (highly connected nodes) in the project',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of bottlenecks to return',
          default: 10
        }
      },
      required: ['projectName']
    }
  },
  {
    name: 'find_circular_dependencies',
    description: 'Find circular dependencies in the project',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        }
      },
      required: ['projectName']
    }
  },
  {
    name: 'update_graph_incremental',
    description: 'Update the graph incrementally based on file changes',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              changeType: { 
                type: 'string',
                enum: ['added', 'modified', 'deleted']
              },
              oldContent: { type: 'string' },
              newContent: { type: 'string' }
            },
            required: ['filePath', 'changeType']
          },
          description: 'List of file changes to process'
        }
      },
      required: ['projectName', 'changes']
    }
  }
];

/**
 * Graph MCP Tools Handler
 */
export class GraphMCPHandler {
  private supabase;
  private storage: GraphStorageEngine;
  private builder: GraphBuilder;
  private queryEngine: GraphQueryEngine;
  private updater: IncrementalGraphUpdater;
  private astAnalyzer: ASTAnalyzer;
  private purposeGenerator: CodePurposeGenerator;

  constructor() {
    this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    this.storage = new GraphStorageEngine(this.supabase);
    this.astAnalyzer = new ASTAnalyzer();
    this.purposeGenerator = new CodePurposeGenerator();
    this.builder = new GraphBuilder(this.astAnalyzer, this.purposeGenerator, this.storage);
    this.queryEngine = new GraphQueryEngine(this.storage);
    this.updater = new IncrementalGraphUpdater(this.storage, this.builder, this.astAnalyzer);
  }

  async handleTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'build_project_graph':
        return await this.handleBuildProjectGraph(args);
      case 'get_graph_stats':
        return await this.handleGetGraphStats(args);
      case 'search_graph_nodes':
        return await this.handleSearchGraphNodes(args);
      case 'get_node_relationships':
        return await this.handleGetNodeRelationships(args);
      case 'analyze_impact':
        return await this.handleAnalyzeImpact(args);
      case 'find_bottlenecks':
        return await this.handleFindBottlenecks(args);
      case 'find_circular_dependencies':
        return await this.handleFindCircularDependencies(args);
      case 'update_graph_incremental':
        return await this.handleUpdateGraphIncremental(args);
      default:
        throw new Error(`Unknown graph tool: ${name}`);
    }
  }

  private async handleBuildProjectGraph(args: {
    projectName: string;
    projectPath: string;
    includePatterns?: string[];
    excludePatterns?: string[];
    languages?: string[];
  }) {
    try {
      // First, ensure project exists in the database
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found. Create it first using create_project.`);
      }

      // Create new graph version
      const versionId = await this.storage.createNewVersion(project.id);

      // Build graph from project
      const context = {
        projectId: project.id,
        versionId,
        rootPath: args.projectPath,
        includePatterns: args.includePatterns || ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx'],
        excludePatterns: args.excludePatterns || ['node_modules/**', 'dist/**', 'build/**', '**/*.test.*', '**/*.spec.*'],
        languages: args.languages || ['typescript', 'javascript']
      };

      const result = await this.builder.buildGraphFromProject(context);

      if (result.success) {
        const stats = await this.storage.getGraphStatistics(project.id);
        return {
          content: [
            {
              type: 'text',
              text: `# Graph Built Successfully for Project: ${args.projectName}\n\n` +
                    `✅ **Build Results:**\n` +
                    `- Nodes processed: ${result.nodesAffected}\n` +
                    `- Edges created: ${result.edgesAffected || 0}\n` +
                    `- Files analyzed: ${result.operationsApplied || 0}\n` +
                    `- Execution time: ${result.executionTimeMs}ms\n` +
                    `- Version: ${versionId}\n\n` +
                    `📊 **Current Graph Stats:**\n` +
                    `- Total nodes: ${stats.totalNodes}\n` +
                    `- Total edges: ${stats.totalEdges}\n` +
                    `- Total files: ${stats.totalFiles}\n` +
                    `- Graph version: ${stats.versionNumber}\n` +
                    `- Average complexity: ${stats.averageComplexity?.toFixed(2) || 'N/A'}\n\n` +
                    `🎨 **Visualization:** Your graph is now ready for visualization at http://localhost:3000`
            }
          ]
        };
      } else {
        throw new Error(`Graph build failed: ${result.errors?.join(', ') || 'Unknown error'}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error building graph:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleGetGraphStats(args: { projectName: string }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      const stats = await this.storage.getGraphStatistics(project.id);
      const bottlenecks = await this.queryEngine.findBottlenecks(project.id);
      const cycles = await this.queryEngine.findCircularDependencies(project.id);

      return {
        content: [
          {
            type: 'text',
            text: `# Graph Statistics for Project: ${args.projectName}\n\n` +
                  `📊 **Overview:**\n` +
                  `- Total nodes: ${stats.totalNodes}\n` +
                  `- Total edges: ${stats.totalEdges}\n` +
                  `- Total files: ${stats.totalFiles}\n` +
                  `- Graph version: ${stats.versionNumber}\n` +
                  `- Last updated: ${stats.versionCreated?.toISOString()}\n\n` +
                  `🔧 **Complexity:**\n` +
                  `- Average complexity: ${stats.averageComplexity?.toFixed(2) || 'N/A'}\n` +
                  `- Max complexity: N/A\n\n` +
                  `⚠️ **Issues:**\n` +
                  `- Bottlenecks found: ${bottlenecks.length}\n` +
                  `- Circular dependencies: ${cycles.length}\n\n` +
                  `🎯 **Top Bottlenecks:**\n` +
                  bottlenecks.slice(0, 5).map((b, i) => 
                    `${i + 1}. ${b.node.name} (centrality: ${b.centrality.toFixed(2)}, connections: ${b.totalConnections})`
                  ).join('\n')
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error getting graph stats:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleSearchGraphNodes(args: {
    projectName: string;
    query: string;
    nodeTypes?: string[];
    limit?: number;
    fuzzyThreshold?: number;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      const results = await this.queryEngine.searchNodes(
        project.id,
        args.query,
        {
          nodeTypes: args.nodeTypes as any,
          limit: args.limit || 10,
          fuzzyThreshold: args.fuzzyThreshold || 0.3
        }
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `# Search Results for: "${args.query}" in project "${args.projectName}"\n\nNo results found matching your query.`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `# Search Results for: "${args.query}" in project "${args.projectName}"\n\n` +
                  results.map((result, i) => 
                    `## Result ${i + 1} (Similarity: ${result.similarity?.toFixed(3) || '1.000'})\n` +
                    `**Name:** ${result.node.name || result.node.nodeKey}\n` +
                    `**Type:** ${result.node.nodeType}\n` +
                    `**File:** ${result.node.location.filePath}\n` +
                    `**Lines:** ${result.node.location.startLine}-${result.node.location.endLine}\n` +
                    `**Match Reason:** ${result.matchReason || 'semantic similarity'}\n` +
                    (result.node.purpose ? `**Purpose:** ${result.node.purpose}\n` : '') +
                    (result.node.complexity ? `**Complexity:** ${result.node.complexity}\n` : '') +
                    '\n---\n'
                  ).join('\n')
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error searching nodes:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleGetNodeRelationships(args: {
    projectName: string;
    nodeName: string;
    relationshipType?: string;
    maxDepth?: number;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      // Find the node first
      const nodes = await this.queryEngine.findNodesByName(project.id, args.nodeName);
      if (nodes.length === 0) {
        throw new Error(`Node "${args.nodeName}" not found`);
      }

      const node = nodes[0].node;
      const relationships: any = {};

      if (args.relationshipType === 'all' || args.relationshipType === 'callers') {
        relationships.callers = await this.queryEngine.findCallers(node.id);
      }

      if (args.relationshipType === 'all' || args.relationshipType === 'callees') {
        relationships.callees = await this.queryEngine.findCallees(node.id);
      }

      if (args.relationshipType === 'all' || args.relationshipType === 'dependencies') {
        relationships.dependencies = await this.queryEngine.findDependencies(node.id, {
          maxDepth: args.maxDepth || 3
        });
      }

      let content = `# Relationships for Node: ${args.nodeName}\n\n`;
      content += `**Node Type:** ${node.nodeType}\n`;
      content += `**File:** ${node.location.filePath}\n`;
      content += `**Lines:** ${node.location.startLine}-${node.location.endLine}\n\n`;

      if (relationships.callers) {
        content += `## 📞 Callers (${relationships.callers.length})\n`;
        content += relationships.callers.map((caller: any) => 
          `- ${caller.name} (${caller.nodeType}) in ${caller.location.filePath}`
        ).join('\n') + '\n\n';
      }

      if (relationships.callees) {
        content += `## 🎯 Callees (${relationships.callees.length})\n`;
        content += relationships.callees.map((callee: any) => 
          `- ${callee.name} (${callee.nodeType}) in ${callee.location.filePath}`
        ).join('\n') + '\n\n';
      }

      if (relationships.dependencies) {
        content += `## 🔗 Dependencies (${relationships.dependencies.length})\n`;
        content += relationships.dependencies.map((dep: any) => 
          `- ${dep.name} (${dep.nodeType}) in ${dep.location.filePath}`
        ).join('\n') + '\n\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: content
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error getting relationships:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleAnalyzeImpact(args: {
    projectName: string;
    nodeName: string;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      // Find the node first
      const nodes = await this.queryEngine.findNodesByName(project.id, args.nodeName);
      if (nodes.length === 0) {
        throw new Error(`Node "${args.nodeName}" not found`);
      }

      const node = nodes[0].node;
      const impact = await this.queryEngine.analyzeImpact(node.id);

      return {
        content: [
          {
            type: 'text',
            text: `# Impact Analysis for Node: ${args.nodeName}\n\n` +
                  `**Target Node:** ${impact.targetNode.name} (${impact.targetNode.nodeType})\n` +
                  `**File:** ${impact.targetNode.location.filePath}\n` +
                  `**Risk Level:** ${impact.riskLevel.toUpperCase()}\n\n` +
                  `## 📊 Impact Summary\n` +
                  `- **Directly Affected:** ${impact.directlyAffected.length} nodes\n` +
                  `- **Indirectly Affected:** ${impact.indirectlyAffected.length} nodes\n` +
                  `- **Total Impact:** ${impact.directlyAffected.length + impact.indirectlyAffected.length} nodes\n` +
                  `- **Affected Files:** ${impact.affectedFiles.length}\n\n` +
                  `## 📁 Affected Files\n` +
                  impact.affectedFiles.map(file => `- ${file}`).join('\n') + '\n\n' +
                  `## 🎯 Directly Affected Nodes\n` +
                  impact.directlyAffected.slice(0, 10).map((node: any) => 
                    `- ${node.name} (${node.nodeType}) in ${node.location.filePath}`
                  ).join('\n') +
                  (impact.directlyAffected.length > 10 ? `\n... and ${impact.directlyAffected.length - 10} more` : '')
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error analyzing impact:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleFindBottlenecks(args: {
    projectName: string;
    limit?: number;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      const bottlenecks = await this.queryEngine.findBottlenecks(project.id);
      const limit = args.limit || 10;
      const topBottlenecks = bottlenecks.slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: `# Bottlenecks in Project: ${args.projectName}\n\n` +
                  `Found ${bottlenecks.length} potential bottlenecks (showing top ${topBottlenecks.length})\n\n` +
                  topBottlenecks.map((bottleneck, i) => 
                    `## ${i + 1}. ${bottleneck.node.name}\n` +
                    `- **Type:** ${bottleneck.node.nodeType}\n` +
                    `- **File:** ${bottleneck.node.location.filePath}\n` +
                    `- **Centrality Score:** ${bottleneck.centrality.toFixed(2)}\n` +
                    `- **Total Connections:** ${bottleneck.totalConnections}\n` +
                    `- **Complexity:** ${bottleneck.node.complexity || 'N/A'}\n` +
                    (bottleneck.node.purpose ? `- **Purpose:** ${bottleneck.node.purpose}\n` : '') +
                    '\n---\n'
                  ).join('\n')
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error finding bottlenecks:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleFindCircularDependencies(args: {
    projectName: string;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      const cycles = await this.queryEngine.findCircularDependencies(project.id);

      if (cycles.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `# Circular Dependencies in Project: ${args.projectName}\n\n✅ **No circular dependencies found!** Your project has a clean dependency graph.`
            }
          ]
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `# Circular Dependencies in Project: ${args.projectName}\n\n` +
                  `⚠️ Found ${cycles.length} circular dependency cycles:\n\n` +
                  cycles.map((cycle, i) => 
                    `## Cycle ${i + 1} (${cycle.severity.toUpperCase()} severity)\n` +
                    `**Length:** ${cycle.cycleLength} nodes\n` +
                    `**Nodes involved:**\n` +
                    cycle.nodes.map((node: any) => 
                      `- ${node.name} (${node.nodeType}) in ${node.location.filePath}`
                    ).join('\n') + '\n\n---\n'
                  ).join('\n')
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error finding circular dependencies:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }

  private async handleUpdateGraphIncremental(args: {
    projectName: string;
    changes: Array<{
      filePath: string;
      changeType: 'added' | 'modified' | 'deleted';
      oldContent?: string;
      newContent?: string;
    }>;
  }) {
    try {
      const { data: project } = await this.supabase
        .from('projects')
        .select('id, path')
        .eq('name', args.projectName)
        .single();

      if (!project) {
        throw new Error(`Project "${args.projectName}" not found`);
      }

      const context = {
        projectId: project.id,
        versionId: '', // Will be created by updater
        rootPath: project.path,
        includePatterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx'],
        excludePatterns: ['node_modules/**', 'dist/**', 'build/**'],
        languages: ['typescript', 'javascript']
      };

      const result = await this.updater.updateFromFileChanges(
        project.id,
        args.changes,
        context
      );

      if (result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `# Incremental Graph Update for Project: ${args.projectName}\n\n` +
                    `✅ **Update Results:**\n` +
                    `- Operations applied: ${result.operationsApplied}\n` +
                    `- Nodes affected: ${result.nodesAffected}\n` +
                    `- Edges affected: ${result.edgesAffected}\n` +
                    `- Execution time: ${result.executionTimeMs}ms\n` +
                    `- New version: ${result.versionId}\n\n` +
                    `📁 **Files processed:**\n` +
                    args.changes.map(change => 
                      `- ${change.changeType.toUpperCase()}: ${change.filePath}`
                    ).join('\n')
            }
          ]
        };
      } else {
        throw new Error(`Incremental update failed: ${result.errors?.join(', ') || 'Unknown error'}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ **Error updating graph:** ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  }
}