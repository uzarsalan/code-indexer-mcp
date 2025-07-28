#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { CodeIndexer } from './indexer.js';
import { EmbeddingService } from './embeddings.js';
import { VectorStore } from './vector-store.js';
import { SearchService } from './search-service.js';
import { defaultIndexingOptions } from './config.js';

class CodeIndexerMCPServer {
  private server: Server;
  private indexer: CodeIndexer;
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;
  private searchService: SearchService;

  constructor() {
    this.server = new Server(
      {
        name: 'code-indexer-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.indexer = new CodeIndexer(defaultIndexingOptions);
    this.embeddingService = new EmbeddingService();
    this.vectorStore = new VectorStore();
    this.searchService = new SearchService();

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'create_project',
            description: 'Create a new project for code indexing',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Unique name for the project',
                },
                path: {
                  type: 'string',
                  description: 'Path to the project directory',
                },
                description: {
                  type: 'string',
                  description: 'Optional description of the project',
                },
              },
              required: ['name', 'path'],
            },
          },
          {
            name: 'list_projects',
            description: 'List all configured projects',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'index_project',
            description: 'Index a project for semantic search',
            inputSchema: {
              type: 'object',
              properties: {
                projectName: {
                  type: 'string',
                  description: 'Name of the project to index',
                },
              },
              required: ['projectName'],
            },
          },
          {
            name: 'search_code',
            description: 'Search for code using semantic similarity',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for finding relevant code',
                },
                projectName: {
                  type: 'string',
                  description: 'Project name to search within (optional)',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 10)',
                  default: 10,
                },
                threshold: {
                  type: 'number',
                  description: 'Similarity threshold (0-1, default: 0.7)',
                  default: 0.7,
                },
                language: {
                  type: 'string',
                  description: 'Filter by programming language (optional)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'get_code_context',
            description: 'Get code context around a specific line in a file',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the file',
                },
                line: {
                  type: 'number',
                  description: 'Line number to get context for',
                },
                projectName: {
                  type: 'string',
                  description: 'Project name (optional)',
                },
                contextLines: {
                  type: 'number',
                  description: 'Number of lines of context to include (default: 10)',
                  default: 10,
                },
              },
              required: ['filePath', 'line'],
            },
          },
          {
            name: 'find_similar_code',
            description: 'Find code similar to a specific code block',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the file containing the reference code',
                },
                startLine: {
                  type: 'number',
                  description: 'Start line of the reference code block',
                },
                endLine: {
                  type: 'number',
                  description: 'End line of the reference code block',
                },
                projectName: {
                  type: 'string',
                  description: 'Project name (optional)',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 5)',
                  default: 5,
                },
              },
              required: ['filePath', 'startLine', 'endLine'],
            },
          },
          {
            name: 'get_index_stats',
            description: 'Get statistics about the indexed codebase',
            inputSchema: {
              type: 'object',
              properties: {
                projectName: {
                  type: 'string',
                  description: 'Project name to get stats for (optional)',
                },
              },
            },
          },
          {
            name: 'delete_project',
            description: 'Delete a project and all its indexed data',
            inputSchema: {
              type: 'object',
              properties: {
                projectName: {
                  type: 'string',
                  description: 'Name of the project to delete',
                },
              },
              required: ['projectName'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'create_project':
            return await this.handleCreateProject(args as {
              name: string;
              path: string;
              description?: string;
            });

          case 'list_projects':
            return await this.handleListProjects();

          case 'index_project':
            return await this.handleIndexProject(args as { projectName: string });

          case 'search_code':
            return await this.handleSearchCode(args as {
              query: string;
              projectName?: string;
              limit?: number;
              threshold?: number;
              language?: string;
            });

          case 'get_code_context':
            return await this.handleGetCodeContext(args as {
              filePath: string;
              line: number;
              projectName?: string;
              contextLines?: number;
            });

          case 'find_similar_code':
            return await this.handleFindSimilarCode(args as {
              filePath: string;
              startLine: number;
              endLine: number;
              projectName?: string;
              limit?: number;
            });

          case 'get_index_stats':
            return await this.handleGetIndexStats(args as {
              projectName?: string;
            });

          case 'delete_project':
            return await this.handleDeleteProject(args as {
              projectName: string;
            });

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing tool: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleCreateProject(args: {
    name: string;
    path: string;
    description?: string;
  }) {
    const { name, path, description } = args;

    await this.vectorStore.initializeDatabase();

    const project = await this.vectorStore.createProject(
      name, 
      path, 
      description, 
      defaultIndexingOptions
    );

    return {
      content: [
        {
          type: 'text',
          text: `Successfully created project: ${name}\n\n**Project Details:**\n- ID: ${project.id}\n- Path: ${project.path}\n- Description: ${project.description || 'No description'}\n- Created: ${project.createdAt.toISOString()}`,
        },
      ],
    };
  }

  private async handleListProjects() {
    const projects = await this.vectorStore.listProjects();

    if (projects.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No projects configured. Use `create_project` to add a project.',
          },
        ],
      };
    }

    const projectList = projects
      .map((project, index) => {
        const lastIndexed = project.lastIndexed 
          ? project.lastIndexed.toISOString()
          : 'Never';
        
        return `## ${index + 1}. ${project.name}
**Path:** ${project.path}
**Description:** ${project.description || 'No description'}
**Last Indexed:** ${lastIndexed}
**Created:** ${project.createdAt.toISOString()}`;
      })
      .join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Configured Projects (${projects.length})\n\n${projectList}`,
        },
      ],
    };
  }

  private async handleIndexProject(args: { projectName: string }) {
    const { projectName } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    const chunks = await this.indexer.indexDirectory(project.path, project.id);
    console.log(`Found ${chunks.length} code chunks for project ${projectName}`);

    const chunksWithEmbeddings = await this.embeddingService.embedCodeChunks(chunks);
    console.log('Generated embeddings for all chunks');

    await this.vectorStore.storeChunks(chunksWithEmbeddings);
    console.log('Stored all chunks in vector database');

    await this.vectorStore.updateProject(project.id, {
      lastIndexed: new Date()
    });

    const stats = await this.vectorStore.getStats(project.id);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully indexed project: ${projectName}\n\n**Stats:**\n- Processed ${chunks.length} code chunks\n- Total chunks in project: ${stats.totalChunks}\n- Total files in project: ${stats.totalFiles}\n- Project path: ${project.path}`,
        },
      ],
    };
  }

  private async handleSearchCode(args: {
    query: string;
    projectName?: string;
    limit?: number;
    threshold?: number;
    language?: string;
  }) {
    const { query, projectName, limit = 10, threshold = 0.7, language } = args;

    let projectId: string | undefined;
    if (projectName) {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      projectId = project.id;
    }

    const results = await this.searchService.searchCode(query, limit, threshold, language, projectId);

    const resultText = results.length > 0
      ? results
          .map((result, index) => {
            return `## Result ${index + 1} (Similarity: ${result.similarity.toFixed(3)})
**File:** ${result.chunk.relativePath || result.chunk.filePath}
**Language:** ${result.chunk.language}
**Lines:** ${result.chunk.startLine}-${result.chunk.endLine}

\`\`\`${result.chunk.language}
${result.chunk.content}
\`\`\``;
          })
          .join('\n\n---\n\n')
      : 'No results found matching your query.';

    const projectText = projectName ? ` in project "${projectName}"` : '';
    return {
      content: [
        {
          type: 'text',
          text: `# Search Results for: "${query}"${projectText}\n\n${resultText}`,
        },
      ],
    };
  }

  private async handleGetCodeContext(args: {
    filePath: string;
    line: number;
    projectName?: string;
    contextLines?: number;
  }) {
    const { filePath, line, projectName, contextLines = 10 } = args;

    let projectId: string | undefined;
    if (projectName) {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      projectId = project.id;
    }

    const context = await this.searchService.getCodeContext(filePath, line, contextLines, projectId);

    const projectText = projectName ? ` (Project: ${projectName})` : '';
    return {
      content: [
        {
          type: 'text',
          text: `# Code Context for ${filePath}:${line}${projectText}\n\n\`\`\`\n${context}\n\`\`\``,
        },
      ],
    };
  }

  private async handleFindSimilarCode(args: {
    filePath: string;
    startLine: number;
    endLine: number;
    projectName?: string;
    limit?: number;
  }) {
    const { filePath, startLine, endLine, projectName, limit = 5 } = args;

    let projectId: string | undefined;
    if (projectName) {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      projectId = project.id;
    }

    const results = await this.searchService.findSimilarCode(filePath, startLine, endLine, limit, projectId);

    const resultText = results.length > 0
      ? results
          .map((result, index) => {
            return `## Similar Code ${index + 1} (Similarity: ${result.similarity.toFixed(3)})
**File:** ${result.chunk.relativePath || result.chunk.filePath}
**Language:** ${result.chunk.language}
**Lines:** ${result.chunk.startLine}-${result.chunk.endLine}

\`\`\`${result.chunk.language}
${result.chunk.content}
\`\`\``;
          })
          .join('\n\n---\n\n')
      : 'No similar code found.';

    const projectText = projectName ? ` (Project: ${projectName})` : '';
    return {
      content: [
        {
          type: 'text',
          text: `# Similar Code to ${filePath}:${startLine}-${endLine}${projectText}\n\n${resultText}`,
        },
      ],
    };
  }

  private async handleGetIndexStats(args: { projectName?: string }) {
    const { projectName } = args;

    let projectId: string | undefined;
    if (projectName) {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      projectId = project.id;
    }

    const stats = await this.vectorStore.getStats(projectId);

    const title = projectName ? `Index Statistics for Project: ${projectName}` : 'Global Index Statistics';
    return {
      content: [
        {
          type: 'text',
          text: `# ${title}\n\n- **Total Code Chunks:** ${stats.totalChunks}\n- **Total Files:** ${stats.totalFiles}`,
        },
      ],
    };
  }

  private async handleDeleteProject(args: { projectName: string }) {
    const { projectName } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    await this.vectorStore.deleteProject(project.id);

    return {
      content: [
        {
          type: 'text',
          text: `Successfully deleted project: ${projectName}\n\nAll associated code chunks and embeddings have been removed from the database.`,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Code Indexer MCP Server running on stdio');
  }
}

const server = new CodeIndexerMCPServer();
server.run().catch(console.error);