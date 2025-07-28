/**
 * Graph Visualization Server
 * Express server for serving the Code Property Graph visualization
 */

import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { GraphStorageEngine } from '../graph/graph-storage.js';
import { GraphQueryEngine } from '../graph/graph-query-engine.js';
import { supabaseConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class GraphVisualizationServer {
  private app: express.Application;
  private storage: GraphStorageEngine;
  private queryEngine: GraphQueryEngine;
  private port: number;

  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    
    // Initialize graph components
    const supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    this.storage = new GraphStorageEngine(supabase);
    this.queryEngine = new GraphQueryEngine(this.storage);
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(join(__dirname, '../../public')));
  }

  private setupRoutes(): void {
    // Serve the main visualization page
    this.app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '../../public/graph-viewer.html'));
    });

    // API Routes
    this.app.get('/api/projects', this.getProjects.bind(this));
    this.app.get('/api/projects/:projectId/graph', this.getProjectGraph.bind(this));
    this.app.get('/api/projects/:projectId/stats', this.getProjectStats.bind(this));
    this.app.get('/api/projects/:projectId/search', this.searchNodes.bind(this));
    this.app.get('/api/nodes/:nodeId/details', this.getNodeDetails.bind(this));
    this.app.get('/api/nodes/:nodeId/connections', this.getNodeConnections.bind(this));
  }

  private async getProjects(req: express.Request, res: express.Response): Promise<void> {
    try {
      // Get all projects with basic stats
      const { data: projects, error } = await this.storage['supabase']
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      // Enhance with graph statistics
      const projectsWithStats = await Promise.all(
        projects.map(async (project) => {
          try {
            const stats = await this.storage.getGraphStatistics(project.id);
            return {
              ...project,
              stats: {
                totalNodes: stats.totalNodes,
                totalEdges: stats.totalEdges,
                totalFiles: stats.totalFiles,
                lastIndexed: stats.versionCreated
              }
            };
          } catch (error) {
            return {
              ...project,
              stats: {
                totalNodes: 0,
                totalEdges: 0,
                totalFiles: 0,
                lastIndexed: null
              }
            };
          }
        })
      );

      res.json({ success: true, data: projectsWithStats });
    } catch (error) {
      console.error('Error fetching projects:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch projects' 
      });
    }
  }

  private async getProjectGraph(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { projectId } = req.params;
      const { limit = '100', nodeType, filePath } = req.query;

      // Get nodes
      const nodesResult = await this.storage.queryNodes({
        projectId,
        nodeType: nodeType as any,
        filePath: filePath as string,
        limit: parseInt(limit as string)
      });

      // Get edges for these nodes
      const nodeIds = nodesResult.data.map(node => node.id);
      const edges = [];

      for (const nodeId of nodeIds) {
        const edgeResult = await this.storage.queryEdges({
          projectId,
          sourceNodeId: nodeId,
          limit: 50
        });
        edges.push(...edgeResult.data);
      }

      // Format for visualization (Cytoscape.js format)
      const graphData = {
        nodes: nodesResult.data.map(node => ({
          data: {
            id: node.id,
            label: node.name || node.nodeKey,
            type: node.nodeType,
            file: node.location.filePath,
            complexity: node.complexity || 1,
            purpose: node.purpose,
            signature: node.signature,
            // Visual properties
            size: Math.max(10, (node.complexity || 1) * 3),
            color: this.getNodeColor(node.nodeType)
          }
        })),
        edges: edges
          .filter(edge => nodeIds.includes(edge.targetNodeId)) // Only edges between visible nodes
          .map(edge => ({
            data: {
              id: edge.id,
              source: edge.sourceNodeId,
              target: edge.targetNodeId,
              type: edge.edgeType,
              weight: edge.weight || 1,
              color: this.getEdgeColor(edge.edgeType)
            }
          }))
      };

      res.json({ 
        success: true, 
        data: graphData,
        meta: {
          totalNodes: nodesResult.totalCount,
          visibleNodes: graphData.nodes.length,
          visibleEdges: graphData.edges.length
        }
      });
    } catch (error) {
      console.error('Error fetching project graph:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch project graph' 
      });
    }
  }

  private async getProjectStats(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { projectId } = req.params;
      const stats = await this.storage.getGraphStatistics(projectId);

      // Get additional metrics
      const complexity = await this.queryEngine.findBottlenecks(projectId);
      const cycles = await this.queryEngine.findCircularDependencies(projectId);

      res.json({
        success: true,
        data: {
          ...stats,
          topComplexityNodes: complexity.slice(0, 10),
          circularDependencies: cycles.length,
          healthScore: this.calculateHealthScore(stats, cycles.length)
        }
      });
    } catch (error) {
      console.error('Error fetching project stats:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch project statistics' 
      });
    }
  }

  private async searchNodes(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { projectId } = req.params;
      const { q: query, type, limit = '20' } = req.query;

      if (!query) {
        res.status(400).json({ 
          success: false, 
          error: 'Query parameter is required' 
        });
        return;
      }

      const results = await this.queryEngine.searchNodes(
        projectId,
        query as string,
        {
          nodeTypes: type ? [type as any] : undefined,
          limit: parseInt(limit as string),
          fuzzyThreshold: 0.3
        }
      );

      res.json({
        success: true,
        data: results.map(result => ({
          node: result.node,
          similarity: result.similarity,
          matchReason: result.matchReason
        }))
      });
    } catch (error) {
      console.error('Error searching nodes:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to search nodes' 
      });
    }
  }

  private async getNodeDetails(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { nodeId } = req.params;
      
      const node = await this.storage.getNode(nodeId);
      if (!node) {
        res.status(404).json({ 
          success: false, 
          error: 'Node not found' 
        });
        return;
      }

      // Get impact analysis
      const impact = await this.queryEngine.analyzeImpact(nodeId);

      res.json({
        success: true,
        data: {
          node,
          impact: {
            riskLevel: impact.riskLevel,
            directlyAffected: impact.directlyAffected.length,
            indirectlyAffected: impact.indirectlyAffected.length,
            affectedFiles: impact.affectedFiles
          }
        }
      });
    } catch (error) {
      console.error('Error fetching node details:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch node details' 
      });
    }
  }

  private async getNodeConnections(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { nodeId } = req.params;
      
      const connections = await this.storage.getNodeWithConnections(nodeId);
      if (!connections) {
        res.status(404).json({ 
          success: false, 
          error: 'Node not found' 
        });
        return;
      }

      res.json({
        success: true,
        data: {
          node: connections.node,
          incomingEdges: connections.incomingEdges,
          outgoingEdges: connections.outgoingEdges,
          summary: {
            incoming: connections.incomingEdges.length,
            outgoing: connections.outgoingEdges.length,
            total: connections.incomingEdges.length + connections.outgoingEdges.length
          }
        }
      });
    } catch (error) {
      console.error('Error fetching node connections:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch node connections' 
      });
    }
  }

  private getNodeColor(nodeType: string): string {
    const colors: Record<string, string> = {
      'FUNCTION': '#4CAF50',      // Green
      'CLASS': '#2196F3',         // Blue  
      'VARIABLE': '#FF9800',      // Orange
      'MODULE': '#9C27B0',        // Purple
      'INTERFACE': '#00BCD4',     // Cyan
      'TYPE': '#795548',          // Brown
      'IMPORT': '#607D8B',        // Blue Grey
      'EXPORT': '#FFC107'         // Amber
    };
    return colors[nodeType] || '#757575'; // Grey default
  }

  private getEdgeColor(edgeType: string): string {
    const colors: Record<string, string> = {
      'CALLS': '#FF5722',         // Deep Orange
      'IMPORTS': '#3F51B5',       // Indigo
      'EXTENDS': '#E91E63',       // Pink
      'IMPLEMENTS': '#009688',    // Teal
      'USES': '#8BC34A',          // Light Green
      'CONTAINS': '#673AB7',      // Deep Purple
      'DATA_FLOW': '#CDDC39',     // Lime
      'CONTROL_FLOW': '#FF9800'   // Orange
    };
    return colors[edgeType] || '#9E9E9E'; // Grey default
  }

  private calculateHealthScore(stats: any, cycles: number): number {
    let score = 100;
    
    // Penalize high complexity
    if (stats.averageComplexity > 10) score -= 20;
    else if (stats.averageComplexity > 5) score -= 10;
    
    // Penalize circular dependencies
    score -= cycles * 5;
    
    // Penalize large files (too many nodes per file)
    const nodesPerFile = stats.totalFiles > 0 ? stats.totalNodes / stats.totalFiles : 0;
    if (nodesPerFile > 20) score -= 15;
    else if (nodesPerFile > 10) score -= 5;
    
    return Math.max(0, Math.min(100, score));
  }

  public start(): void {
    this.app.listen(this.port, () => {
      console.log(`🎨 Graph Visualization Server started on http://localhost:${this.port}`);
      console.log(`📊 View your code graphs at: http://localhost:${this.port}`);
    });
  }

  public getApp(): express.Application {
    return this.app;
  }
}

// Export for use in other modules
export default GraphVisualizationServer;