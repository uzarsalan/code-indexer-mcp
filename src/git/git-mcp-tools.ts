/**
 * Git-Aware MCP Tools
 * Additional MCP tools for Git-specific code indexing and search
 */

import { GitAwareIndexer } from './git-indexer.js';
import { BranchConfigManager, BranchConfigBuilder } from './branch-config.js';
import { VectorStore } from '../vector-store.js';
import { SearchService } from '../search-service.js';

/**
 * Extended MCP tools for Git functionality
 */
export const GIT_MCP_TOOLS = [
  {
    name: 'configure_git_repository',
    description: 'Configure a Git repository for branch-aware indexing',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the existing project'
        },
        repositoryPath: {
          type: 'string',
          description: 'Local path to the Git repository'
        },
        remoteUrl: {
          type: 'string',
          description: 'Remote Git repository URL (optional)'
        },
        branchTemplate: {
          type: 'string',
          enum: ['monorepo', 'gitflow', 'github-flow', 'minimal'],
          description: 'Branch configuration template to use'
        }
      },
      required: ['projectName', 'repositoryPath']
    }
  },
  
  {
    name: 'configure_branch_indexing',
    description: 'Configure indexing policies for specific branches',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        branchRules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: 'Regex pattern for branch names'
              },
              enabled: {
                type: 'boolean',
                description: 'Whether to index branches matching this pattern'
              },
              priority: {
                type: 'number',
                description: 'Indexing priority (0-100)'
              },
              strategy: {
                type: 'string',
                enum: ['full-history', 'incremental-diff', 'snapshot', 'hotspot'],
                description: 'Indexing strategy to use'
              },
              maxCommits: {
                type: 'number',
                description: 'Maximum number of commits to index'
              },
              maxAgeDays: {
                type: 'number',
                description: 'Maximum age of commits to index (in days)'
              }
            },
            required: ['pattern', 'enabled']
          }
        }
      },
      required: ['projectName', 'branchRules']
    }
  },

  {
    name: 'index_git_branch',
    description: 'Index a specific Git branch with commits and history',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        branchName: {
          type: 'string',
          description: 'Name of the branch to index'
        },
        strategy: {
          type: 'string',
          enum: ['full-history', 'incremental-diff', 'snapshot', 'hotspot'],
          description: 'Indexing strategy to use (optional)'
        },
        maxCommits: {
          type: 'number',
          description: 'Maximum number of commits to process (optional)'
        },
        since: {
          type: 'string',
          description: 'ISO date string - only index commits since this date (optional)'
        }
      },
      required: ['projectName', 'branchName']
    }
  },

  {
    name: 'search_git_code',
    description: 'Search code with Git context (commits, branches, authors)',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for finding relevant code'
        },
        projectName: {
          type: 'string',
          description: 'Project name to search within (optional)'
        },
        branchName: {
          type: 'string',
          description: 'Branch name to search within (optional)'
        },
        authorEmail: {
          type: 'string',
          description: 'Filter by author email (optional)'
        },
        since: {
          type: 'string',
          description: 'ISO date string - only search commits since this date (optional)'
        },
        until: {
          type: 'string',
          description: 'ISO date string - only search commits until this date (optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold (0-1, default: 0.7)',
          default: 0.7
        }
      },
      required: ['query']
    }
  },

  {
    name: 'get_code_history',
    description: 'Get the evolution history of a specific file or code section',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        filePath: {
          type: 'string',
          description: 'Path to the file (relative to repository root)'
        },
        branchName: {
          type: 'string',
          description: 'Branch name to analyze (optional, defaults to main branch)'
        },
        maxCommits: {
          type: 'number',
          description: 'Maximum number of commits to show (default: 20)',
          default: 20
        }
      },
      required: ['projectName', 'filePath']
    }
  },

  {
    name: 'compare_branches',
    description: 'Compare code differences between two branches',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        sourceBranch: {
          type: 'string',
          description: 'Source branch name'
        },
        targetBranch: {
          type: 'string',
          description: 'Target branch name'
        },
        filePattern: {
          type: 'string',
          description: 'Optional file pattern to filter comparison (glob pattern)'
        }
      },
      required: ['projectName', 'sourceBranch', 'targetBranch']
    }
  },

  {
    name: 'find_commit_by_code',
    description: 'Find commits that introduced or modified specific code patterns',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        codeQuery: {
          type: 'string',
          description: 'Code pattern or text to search for in commit diffs'
        },
        branchName: {
          type: 'string',
          description: 'Branch name to search (optional)'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of commits to return (default: 10)',
          default: 10
        }
      },
      required: ['projectName', 'codeQuery']
    }
  },

  {
    name: 'get_git_repository_stats',
    description: 'Get comprehensive statistics about Git repository indexing',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        branchName: {
          type: 'string',
          description: 'Specific branch to get stats for (optional)'
        }
      },
      required: ['projectName']
    }
  },

  {
    name: 'sync_git_repository',
    description: 'Sync repository with remote and index new commits',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project'
        },
        fetchRemote: {
          type: 'boolean',
          description: 'Whether to fetch from remote before syncing (default: true)',
          default: true
        },
        indexNewCommits: {
          type: 'boolean',
          description: 'Whether to automatically index new commits (default: true)',
          default: true
        }
      },
      required: ['projectName']
    }
  }
];

/**
 * Git MCP Tool Handlers
 */
export class GitMCPToolHandlers {
  private gitIndexer: GitAwareIndexer;
  private branchConfig: BranchConfigManager;
  private vectorStore: VectorStore;
  private searchService: SearchService;

  constructor(
    gitIndexer: GitAwareIndexer,
    branchConfig: BranchConfigManager,
    vectorStore: VectorStore,
    searchService: SearchService
  ) {
    this.gitIndexer = gitIndexer;
    this.branchConfig = branchConfig;
    this.vectorStore = vectorStore;
    this.searchService = searchService;
  }

  async handleConfigureGitRepository(args: {
    projectName: string;
    repositoryPath: string;
    remoteUrl?: string;
    branchTemplate?: 'monorepo' | 'gitflow' | 'github-flow' | 'minimal';
  }) {
    const { projectName, repositoryPath, remoteUrl, branchTemplate = 'github-flow' } = args;

    // Get the project
    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    // Create Git repository record
    const { data: gitRepo, error } = await this.vectorStore.getSupabaseClient()
      .from('git_repositories')
      .insert({
        project_id: project.id,
        remote_url: remoteUrl,
        local_path: repositoryPath,
        default_branch: 'main'
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create Git repository: ${error.message}`);
    }

    // Create branch configuration from template
    const config = BranchConfigBuilder
      .for(gitRepo.id)
      .withTemplate(branchTemplate)
      .build();

    // Save branch rules to database
    for (const rule of config.rules) {
      await this.vectorStore.getSupabaseClient()
        .from('git_branches')
        .insert({
          repository_id: gitRepo.id,
          branch_name: rule.pattern,
          is_indexed: rule.policy.enabled,
          index_policy: rule.policy,
          priority: rule.policy.priority
        });
    }

    return {
      content: [
        {
          type: 'text',
          text: `Successfully configured Git repository for project: ${projectName}\n\n**Repository Details:**\n- Path: ${repositoryPath}\n- Remote: ${remoteUrl || 'Not specified'}\n- Template: ${branchTemplate}\n- Branch Rules: ${config.rules.length}\n\nUse \`index_git_branch\` to start indexing specific branches.`
        }
      ]
    };
  }

  async handleConfigureBranchIndexing(args: {
    projectName: string;
    branchRules: Array<{
      pattern: string;
      enabled: boolean;
      priority?: number;
      strategy?: string;
      maxCommits?: number;
      maxAgeDays?: number;
    }>;
  }) {
    const { projectName, branchRules } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    const { data: repo } = await this.vectorStore.getSupabaseClient()
      .from('git_repositories')
      .select('id')
      .eq('project_id', project.id)
      .single();

    if (!repo) {
      throw new Error(`No Git repository configured for project '${projectName}'`);
    }

    // Update or create branch rules
    for (const rule of branchRules) {
      const policy = {
        enabled: rule.enabled,
        priority: rule.priority || 50,
        autoIndex: rule.enabled,
        webhookEnabled: rule.enabled,
        indexDepth: rule.maxCommits || 100,
        maxAge: rule.maxAgeDays,
        strategy: rule.strategy || 'incremental-diff'
      };

      await this.vectorStore.getSupabaseClient()
        .from('git_branches')
        .upsert({
          repository_id: repo.id,
          branch_name: rule.pattern,
          is_indexed: rule.enabled,
          index_policy: policy,
          priority: rule.priority || 50
        }, {
          onConflict: 'repository_id,branch_name'
        });
    }

    return {
      content: [
        {
          type: 'text',
          text: `Successfully configured ${branchRules.length} branch indexing rules for project: ${projectName}\n\n**Updated Rules:**\n${branchRules.map((rule, i) => 
            `${i + 1}. Pattern: \`${rule.pattern}\` - ${rule.enabled ? 'Enabled' : 'Disabled'} (Priority: ${rule.priority || 50})`
          ).join('\n')}`
        }
      ]
    };
  }

  async handleIndexGitBranch(args: {
    projectName: string;
    branchName: string;
    strategy?: string;
    maxCommits?: number;
    since?: string;
  }) {
    const { projectName, branchName, strategy, maxCommits, since } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    const { data: repo } = await this.vectorStore.getSupabaseClient()
      .from('git_repositories')
      .select('*')
      .eq('project_id', project.id)
      .single();

    if (!repo) {
      throw new Error(`No Git repository configured for project '${projectName}'`);
    }

    // Prepare indexing options
    const options: any = {};
    if (strategy) options.strategy = strategy;
    if (maxCommits) options.maxCommits = maxCommits;
    if (since) options.since = new Date(since);

    // Progress tracking
    let totalCommits = 0;
    let processedCommits = 0;
    options.progressCallback = (progress: any) => {
      totalCommits = progress.totalCommits;
      processedCommits = progress.currentCommit;
      console.log(`Indexing progress: ${processedCommits}/${totalCommits} commits`);
    };

    try {
      // Index the branch
      const chunks = await this.gitIndexer.indexBranch(
        repo.local_path,
        project.id,
        branchName,
        options
      );

      // Store chunks in vector database
      if (chunks.length > 0) {
        // Generate embeddings for chunks
        const chunksWithEmbeddings = await this.vectorStore.embedChunks(chunks);
        await this.vectorStore.storeChunks(chunksWithEmbeddings);
      }

      // Update branch indexing status
      await this.vectorStore.getSupabaseClient()
        .from('git_branches')
        .upsert({
          repository_id: repo.id,
          branch_name: branchName,
          is_indexed: true,
          last_indexed_commit: chunks[0]?.gitContext?.commitHash,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'repository_id,branch_name'
        });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully indexed Git branch: ${branchName}\n\n**Indexing Results:**\n- Project: ${projectName}\n- Branch: ${branchName}\n- Strategy: ${strategy || 'auto-selected'}\n- Commits Processed: ${processedCommits}\n- Code Chunks Created: ${chunks.length}\n- Repository Path: ${repo.local_path}`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to index branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async handleSearchGitCode(args: {
    query: string;
    projectName?: string;
    branchName?: string;
    authorEmail?: string;
    since?: string;
    until?: string;
    limit?: number;
    threshold?: number;
  }) {
    const {
      query,
      projectName,
      branchName,
      authorEmail,
      since,
      until,
      limit = 10,
      threshold = 0.7
    } = args;

    // Get project ID if specified
    let projectId: string | undefined;
    if (projectName) {
      const project = await this.vectorStore.getProjectByName(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      projectId = project.id;
    }

    // Perform temporal search
    const queryEmbedding = await this.vectorStore.generateEmbedding(query);
    
    const { data, error } = await this.vectorStore.getSupabaseClient().rpc('search_code_chunks_temporal', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit,
      project_id_filter: projectId || null,
      branch_filter: branchName || null,
      date_from: since ? new Date(since).toISOString() : null,
      date_to: until ? new Date(until).toISOString() : null,
      author_filter: authorEmail || null
    });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    const results = data || [];
    
    const resultText = results.length > 0
      ? results.map((result: any, index: number) => {
          return `## Result ${index + 1} (Similarity: ${result.similarity.toFixed(3)})
**File:** ${result.relative_path}
**Branch:** ${result.branch_name}
**Commit:** ${result.commit_hash?.substring(0, 8)}
**Author:** ${result.author_email}
**Date:** ${new Date(result.commit_date).toLocaleDateString()}
**Lines:** ${result.start_line}-${result.end_line}

\`\`\`${result.language}
${result.content}
\`\`\`

**Commit Message:** ${result.commit_message?.substring(0, 100)}...`;
        }).join('\n\n---\n\n')
      : 'No results found matching your query with the specified Git filters.';

    const filterText = [
      projectName ? `Project: ${projectName}` : '',
      branchName ? `Branch: ${branchName}` : '',
      authorEmail ? `Author: ${authorEmail}` : '',
      since ? `Since: ${since}` : '',
      until ? `Until: ${until}` : ''
    ].filter(Boolean).join(', ');

    return {
      content: [
        {
          type: 'text',
          text: `# Git-Aware Search Results for: "${query}"\n${filterText ? `**Filters:** ${filterText}\n` : ''}\n${resultText}`
        }
      ]
    };
  }

  async handleGetCodeHistory(args: {
    projectName: string;
    filePath: string;
    branchName?: string;
    maxCommits?: number;
  }) {
    const { projectName, filePath, branchName, maxCommits = 20 } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    const { data: repo } = await this.vectorStore.getSupabaseClient()
      .from('git_repositories')
      .select('id')
      .eq('project_id', project.id)
      .single();

    if (!repo) {
      throw new Error(`No Git repository configured for project '${projectName}'`);
    }

    // Get file evolution from database
    const { data, error } = await this.vectorStore.getSupabaseClient().rpc('get_file_evolution', {
      repo_id: repo.id,
      file_path_param: filePath,
      branch_name_param: branchName || null,
      limit_count: maxCommits
    });

    if (error) {
      throw new Error(`Failed to get file history: ${error.message}`);
    }

    const history = data || [];
    
    if (history.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No history found for file: ${filePath}`
          }
        ]
      };
    }

    const historyText = history.map((entry: any, index: number) => {
      return `## Commit ${index + 1}: ${entry.commit_hash.substring(0, 8)}
**Date:** ${new Date(entry.commit_date).toLocaleDateString()}
**Author:** ${entry.author_name}
**Change:** ${entry.change_type} (+${entry.lines_added}/-${entry.lines_removed})
**Message:** ${entry.commit_message}

${entry.chunk_content ? `\`\`\`\n${entry.chunk_content.substring(0, 500)}${entry.chunk_content.length > 500 ? '...' : ''}\n\`\`\`` : '_No content available_'}`;
    }).join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Code History for: ${filePath}\n**Project:** ${projectName}\n**Branch:** ${branchName || 'all branches'}\n\n${historyText}`
        }
      ]
    };
  }

  async handleCompareBranches(args: {
    projectName: string;
    sourceBranch: string;
    targetBranch: string;
    filePattern?: string;
  }) {
    const { projectName, sourceBranch, targetBranch, filePattern } = args;

    const project = await this.vectorStore.getProjectByName(projectName);
    if (!project) {
      throw new Error(`Project '${projectName}' not found`);
    }

    const { data: repo } = await this.vectorStore.getSupabaseClient()
      .from('git_repositories')
      .select('id')
      .eq('project_id', project.id)
      .single();

    if (!repo) {
      throw new Error(`No Git repository configured for project '${projectName}'`);
    }

    // Compare branches using database function
    const { data, error } = await this.vectorStore.getSupabaseClient().rpc('compare_branches', {
      repo_id: repo.id,
      source_branch: sourceBranch,
      target_branch: targetBranch
    });

    if (error) {
      throw new Error(`Branch comparison failed: ${error.message}`);
    }

    let comparison = data || [];

    // Apply file pattern filter if specified
    if (filePattern) {
      const regex = new RegExp(filePattern.replace(/\*/g, '.*'));
      comparison = comparison.filter((item: any) => regex.test(item.file_path));
    }

    if (comparison.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No differences found between branches ${sourceBranch} and ${targetBranch}${filePattern ? ` (filtered by: ${filePattern})` : ''}`
          }
        ]
      };
    }

    const comparisonText = comparison
      .slice(0, 20) // Limit to top 20 differences
      .map((item: any, index: number) => {
        const status = item.chunks_in_source === 0 ? 'ADDED' :
                     item.chunks_in_target === 0 ? 'DELETED' : 'MODIFIED';
        
        return `${index + 1}. **${item.file_path}** [${status}]
   - ${sourceBranch}: ${item.chunks_in_source} chunks
   - ${targetBranch}: ${item.chunks_in_target} chunks
   - Difference: ${Math.abs(item.chunks_different)} chunks`;
      }).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Branch Comparison: ${sourceBranch} vs ${targetBranch}\n**Project:** ${projectName}\n${filePattern ? `**File Filter:** ${filePattern}\n` : ''}\n**Files with Differences:** ${comparison.length}\n\n${comparisonText}${comparison.length > 20 ? `\n\n... and ${comparison.length - 20} more files` : ''}`
        }
      ]
    };
  }
}