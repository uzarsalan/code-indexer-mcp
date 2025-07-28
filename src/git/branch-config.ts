/**
 * Branch Configuration System
 * Provides flexible, policy-driven branch indexing configuration
 */

export interface BranchIndexingPolicy {
  // Basic configuration
  enabled: boolean;
  priority: number; // 0-100, higher = indexed first
  
  // Temporal configuration
  indexDepth?: number; // How many commits back to index
  maxAge?: number; // Max age in days for commits to index
  
  // Pattern matching
  includePatterns?: string[]; // Glob patterns for files to include
  excludePatterns?: string[]; // Glob patterns for files to exclude
  
  // Performance configuration
  maxChunksPerCommit?: number;
  batchSize?: number;
  
  // Trigger configuration
  autoIndex: boolean; // Auto-index on new commits
  webhookEnabled: boolean;
  
  // Advanced features
  diffOnly?: boolean; // Only index changed code chunks
  mergeCommitsOnly?: boolean; // Skip individual commits, only merge commits
  
  // Custom metadata
  tags?: string[]; // Custom tags for this branch
  description?: string;
}

export interface BranchRule {
  id: string;
  name: string;
  pattern: string; // Regex pattern for branch names
  policy: BranchIndexingPolicy;
  weight: number; // Rule priority (higher weight = higher priority)
  isActive: boolean;
}

export interface ProjectBranchConfig {
  projectId: string;
  repositoryId: string;
  
  // Default policy for all branches
  defaultPolicy: BranchIndexingPolicy;
  
  // Specific rules for branch patterns
  rules: BranchRule[];
  
  // Discovery settings
  autoDiscovery: {
    enabled: boolean;
    scanInterval: number; // minutes
    newBranchPolicy: BranchIndexingPolicy;
  };
  
  // Global limits
  globalLimits: {
    maxActiveBranches: number;
    maxTotalChunks: number;
    storageQuotaGB: number;
  };
}

/**
 * Branch Configuration Manager
 * Handles branch discovery, policy application, and configuration management
 */
export class BranchConfigManager {
  private configs = new Map<string, ProjectBranchConfig>();
  private policyCache = new Map<string, BranchIndexingPolicy>();
  
  /**
   * Get effective policy for a specific branch
   */
  getBranchPolicy(
    repositoryId: string, 
    branchName: string
  ): BranchIndexingPolicy {
    const cacheKey = `${repositoryId}:${branchName}`;
    
    if (this.policyCache.has(cacheKey)) {
      return this.policyCache.get(cacheKey)!;
    }
    
    const config = this.configs.get(repositoryId);
    if (!config) {
      return this.getDefaultPolicy();
    }
    
    // Find matching rules (sorted by weight DESC)
    const matchingRules = config.rules
      .filter(rule => rule.isActive && this.matchesBranch(rule.pattern, branchName))
      .sort((a, b) => b.weight - a.weight);
    
    // Merge policies: default <- matching rules (highest weight first)
    let effectivePolicy = { ...config.defaultPolicy };
    
    for (const rule of matchingRules) {
      effectivePolicy = this.mergePolicies(effectivePolicy, rule.policy);
    }
    
    // Cache the result
    this.policyCache.set(cacheKey, effectivePolicy);
    
    return effectivePolicy;
  }
  
  /**
   * Create configuration from common patterns
   */
  static createFromTemplate(
    repositoryId: string, 
    template: 'monorepo' | 'gitflow' | 'github-flow' | 'minimal'
  ): ProjectBranchConfig {
    const templates = {
      monorepo: {
        defaultPolicy: {
          enabled: false,
          priority: 10,
          autoIndex: false,
          webhookEnabled: true,
          indexDepth: 50
        },
        rules: [
          {
            id: 'main-branch',
            name: 'Main Branch',
            pattern: '^(main|master)$',
            policy: {
              enabled: true,
              priority: 100,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 1000,
              diffOnly: false
            },
            weight: 100,
            isActive: true
          },
          {
            id: 'feature-branches',
            name: 'Feature Branches',
            pattern: '^feature/.*',
            policy: {
              enabled: true,
              priority: 50,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 20,
              diffOnly: true,
              maxAge: 30 // Only index commits from last 30 days
            },
            weight: 50,
            isActive: true
          },
          {
            id: 'release-branches',
            name: 'Release Branches',
            pattern: '^release/.*',
            policy: {
              enabled: true,
              priority: 80,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 100,
              diffOnly: false
            },
            weight: 80,
            isActive: true
          }
        ]
      },
      
      gitflow: {
        defaultPolicy: {
          enabled: false,
          priority: 10,
          autoIndex: false,
          webhookEnabled: false
        },
        rules: [
          {
            id: 'master',
            name: 'Master Branch',
            pattern: '^master$',
            policy: {
              enabled: true,
              priority: 100,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: -1 // All commits
            },
            weight: 100,
            isActive: true
          },
          {
            id: 'develop',
            name: 'Develop Branch',
            pattern: '^develop$',
            policy: {
              enabled: true,
              priority: 90,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 500
            },
            weight: 90,
            isActive: true
          },
          {
            id: 'feature',
            name: 'Feature Branches',
            pattern: '^feature/.*',
            policy: {
              enabled: true,
              priority: 30,
              autoIndex: false,
              webhookEnabled: false,
              indexDepth: 10,
              diffOnly: true
            },
            weight: 30,
            isActive: true
          },
          {
            id: 'hotfix',
            name: 'Hotfix Branches',
            pattern: '^hotfix/.*',
            policy: {
              enabled: true,
              priority: 70,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 20
            },
            weight: 70,
            isActive: true
          }
        ]
      },
      
      'github-flow': {
        defaultPolicy: {
          enabled: false,
          priority: 10,
          autoIndex: false,
          webhookEnabled: false
        },
        rules: [
          {
            id: 'main',
            name: 'Main Branch',
            pattern: '^main$',
            policy: {
              enabled: true,
              priority: 100,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: -1
            },
            weight: 100,
            isActive: true
          },
          {
            id: 'feature-branches',
            name: 'All Feature Branches',
            pattern: '.*',
            policy: {
              enabled: true,
              priority: 50,
              autoIndex: true,
              webhookEnabled: true,
              indexDepth: 30,
              diffOnly: true,
              maxAge: 14 // Only recent branches
            },
            weight: 10,
            isActive: true
          }
        ]
      },
      
      minimal: {
        defaultPolicy: {
          enabled: true,
          priority: 50,
          autoIndex: true,
          webhookEnabled: true,
          indexDepth: 100
        },
        rules: []
      }
    };
    
    const template_config = templates[template];
    
    return {
      repositoryId,
      projectId: '', // To be filled
      defaultPolicy: template_config.defaultPolicy,
      rules: template_config.rules,
      autoDiscovery: {
        enabled: true,
        scanInterval: 60, // 1 hour
        newBranchPolicy: {
          enabled: false,
          priority: 10,
          autoIndex: false,
          webhookEnabled: false,
          indexDepth: 10
        }
      },
      globalLimits: {
        maxActiveBranches: 50,
        maxTotalChunks: 1000000,
        storageQuotaGB: 10
      }
    };
  }
  
  /**
   * Validate branch configuration
   */
  validateConfig(config: ProjectBranchConfig): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Check for conflicting rules
    const activeRules = config.rules.filter(r => r.isActive);
    for (let i = 0; i < activeRules.length; i++) {
      for (let j = i + 1; j < activeRules.length; j++) {
        if (this.rulesConflict(activeRules[i], activeRules[j])) {
          warnings.push(
            `Rules "${activeRules[i].name}" and "${activeRules[j].name}" may conflict`
          );
        }
      }
    }
    
    // Check global limits
    const totalActiveBranches = activeRules.filter(r => r.policy.enabled).length;
    if (totalActiveBranches > config.globalLimits.maxActiveBranches) {
      errors.push(
        `Too many active branches: ${totalActiveBranches} > ${config.globalLimits.maxActiveBranches}`
      );
    }
    
    // Check for invalid regex patterns
    for (const rule of config.rules) {
      try {
        new RegExp(rule.pattern);
      } catch (e) {
        errors.push(`Invalid regex pattern in rule "${rule.name}": ${rule.pattern}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  /**
   * Auto-discover branches and apply policies
   */
  async discoverAndConfigureBranches(
    repositoryId: string,
    availableBranches: string[]
  ): Promise<BranchDiscoveryResult> {
    const config = this.configs.get(repositoryId);
    if (!config || !config.autoDiscovery.enabled) {
      return { discovered: 0, configured: 0, skipped: availableBranches.length };
    }
    
    let discovered = 0;
    let configured = 0;
    let skipped = 0;
    
    for (const branchName of availableBranches) {
      const policy = this.getBranchPolicy(repositoryId, branchName);
      
      if (policy.enabled) {
        // Configure this branch for indexing
        await this.configureBranch(repositoryId, branchName, policy);
        configured++;
      } else {
        skipped++;
      }
      
      discovered++;
    }
    
    return { discovered, configured, skipped };
  }
  
  // Private helper methods
  private matchesBranch(pattern: string, branchName: string): boolean {
    try {
      const regex = new RegExp(pattern);
      return regex.test(branchName);
    } catch {
      return false;
    }
  }
  
  private mergePolicies(
    base: BranchIndexingPolicy, 
    override: BranchIndexingPolicy
  ): BranchIndexingPolicy {
    return {
      ...base,
      ...Object.fromEntries(
        Object.entries(override).filter(([_, value]) => value !== undefined)
      )
    };
  }
  
  private rulesConflict(rule1: BranchRule, rule2: BranchRule): boolean {
    // Simple conflict detection - same pattern with different weights
    return rule1.pattern === rule2.pattern && 
           Math.abs(rule1.weight - rule2.weight) < 10;
  }
  
  private getDefaultPolicy(): BranchIndexingPolicy {
    return {
      enabled: false,
      priority: 10,
      autoIndex: false,
      webhookEnabled: false,
      indexDepth: 50
    };
  }
  
  private async configureBranch(
    repositoryId: string,
    branchName: string,
    policy: BranchIndexingPolicy
  ): Promise<void> {
    // Implementation would interact with database
    // This is where the actual branch configuration is persisted
  }
}

// Supporting types
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface BranchDiscoveryResult {
  discovered: number;
  configured: number;
  skipped: number;
}

/**
 * Configuration Builder - Fluent interface for building configurations
 */
export class BranchConfigBuilder {
  private config: Partial<ProjectBranchConfig> = {};
  
  static for(repositoryId: string): BranchConfigBuilder {
    const builder = new BranchConfigBuilder();
    builder.config.repositoryId = repositoryId;
    return builder;
  }
  
  withTemplate(template: 'monorepo' | 'gitflow' | 'github-flow' | 'minimal'): this {
    const templateConfig = BranchConfigManager.createFromTemplate(
      this.config.repositoryId!, 
      template
    );
    this.config = { ...this.config, ...templateConfig };
    return this;
  }
  
  addRule(rule: Omit<BranchRule, 'id'>): this {
    if (!this.config.rules) this.config.rules = [];
    this.config.rules.push({
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });
    return this;
  }
  
  withDefaultPolicy(policy: Partial<BranchIndexingPolicy>): this {
    this.config.defaultPolicy = {
      enabled: false,
      priority: 10,
      autoIndex: false,
      webhookEnabled: false,
      ...policy
    };
    return this;
  }
  
  withGlobalLimits(limits: Partial<ProjectBranchConfig['globalLimits']>): this {
    this.config.globalLimits = {
      maxActiveBranches: 50,
      maxTotalChunks: 1000000,
      storageQuotaGB: 10,
      ...limits
    };
    return this;
  }
  
  build(): ProjectBranchConfig {
    if (!this.config.repositoryId) {
      throw new Error('Repository ID is required');
    }
    
    return this.config as ProjectBranchConfig;
  }
}

/**
 * Usage examples:
 * 
 * // Create a GitFlow configuration
 * const config = BranchConfigBuilder
 *   .for('repo-123')
 *   .withTemplate('gitflow')
 *   .withGlobalLimits({ maxActiveBranches: 20 })
 *   .build();
 * 
 * // Create custom configuration
 * const customConfig = BranchConfigBuilder
 *   .for('repo-456')
 *   .withDefaultPolicy({ enabled: false })
 *   .addRule({
 *     name: 'Main Branch',
 *     pattern: '^main$',
 *     policy: { enabled: true, priority: 100, autoIndex: true },
 *     weight: 100,
 *     isActive: true
 *   })
 *   .build();
 */