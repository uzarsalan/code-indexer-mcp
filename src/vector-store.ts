import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CodeChunk, SearchResult, Project, IndexingOptions } from './types.js';
import { supabaseConfig } from './config.js';

export class VectorStore {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
  }

  async initializeDatabase(): Promise<void> {
    const { error } = await this.supabase.rpc('create_code_chunks_table');
    if (error && !error.message.includes('already exists')) {
      throw new Error(`Failed to initialize database: ${error.message}`);
    }
  }

  // Project management methods
  async createProject(name: string, path: string, description?: string, indexingOptions?: IndexingOptions): Promise<Project> {
    const { data, error } = await this.supabase
      .from('projects')
      .insert({
        name,
        path,
        description,
        indexing_options: indexingOptions || {}
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }

    return {
      id: data.id,
      name: data.name,
      path: data.path,
      description: data.description,
      indexingOptions: data.indexing_options,
      lastIndexed: data.last_indexed ? new Date(data.last_indexed) : undefined,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    };
  }

  async getProject(projectId: string): Promise<Project | null> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get project: ${error.message}`);
    }

    return {
      id: data.id,
      name: data.name,
      path: data.path,
      description: data.description,
      indexingOptions: data.indexing_options,
      lastIndexed: data.last_indexed ? new Date(data.last_indexed) : undefined,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    };
  }

  async getProjectByName(name: string): Promise<Project | null> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .eq('name', name)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to get project by name: ${error.message}`);
    }

    return {
      id: data.id,
      name: data.name,
      path: data.path,
      description: data.description,
      indexingOptions: data.indexing_options,
      lastIndexed: data.last_indexed ? new Date(data.last_indexed) : undefined,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    };
  }

  async listProjects(): Promise<Project[]> {
    const { data, error } = await this.supabase
      .from('projects')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list projects: ${error.message}`);
    }

    return data.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      description: row.description,
      indexingOptions: row.indexing_options,
      lastIndexed: row.last_indexed ? new Date(row.last_indexed) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async updateProject(projectId: string, updates: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Project> {
    const updateData: any = {};
    if (updates.name) updateData.name = updates.name;
    if (updates.path) updateData.path = updates.path;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.indexingOptions) updateData.indexing_options = updates.indexingOptions;
    if (updates.lastIndexed) updateData.last_indexed = updates.lastIndexed.toISOString();

    const { data, error } = await this.supabase
      .from('projects')
      .update(updateData)
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update project: ${error.message}`);
    }

    return {
      id: data.id,
      name: data.name,
      path: data.path,
      description: data.description,
      indexingOptions: data.indexing_options,
      lastIndexed: data.last_indexed ? new Date(data.last_indexed) : undefined,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at)
    };
  }

  async deleteProject(projectId: string): Promise<void> {
    const { error } = await this.supabase
      .from('projects')
      .delete()
      .eq('id', projectId);

    if (error) {
      throw new Error(`Failed to delete project: ${error.message}`);
    }
  }

  async storeChunks(chunks: CodeChunk[]): Promise<void> {
    const batchSize = 1000;
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      
      const rows = batch.map(chunk => ({
        id: chunk.id,
        project_id: chunk.projectId,
        file_path: chunk.filePath,
        relative_path: chunk.relativePath,
        content: chunk.content,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        language: chunk.language,
        embedding: chunk.embedding
      }));

      const { error } = await this.supabase
        .from('code_chunks')
        .upsert(rows);

      if (error) {
        throw new Error(`Failed to store chunks: ${error.message}`);
      }

      console.log(`Stored batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
    }
  }

  async searchSimilar(queryEmbedding: number[], limit: number = 10, threshold: number = 0.7, projectId?: string): Promise<SearchResult[]> {
    const { data, error } = await this.supabase.rpc('search_code_chunks', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit,
      project_id_filter: projectId || null
    });

    if (error) {
      throw new Error(`Failed to search chunks: ${error.message}`);
    }

    return data.map((row: any) => ({
      chunk: {
        id: row.id,
        projectId: row.project_id,
        filePath: row.file_path,
        relativePath: row.relative_path,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        language: row.language,
        embedding: row.embedding
      },
      similarity: row.similarity
    }));
  }

  async getChunksByFile(filePath: string, projectId?: string): Promise<CodeChunk[]> {
    let query = this.supabase
      .from('code_chunks')
      .select('*')
      .eq('file_path', filePath);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get chunks for file: ${error.message}`);
    }

    return data.map(row => ({
      id: row.id,
      projectId: row.project_id,
      filePath: row.file_path,
      relativePath: row.relative_path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
      embedding: row.embedding
    }));
  }

  async getChunksByProject(projectId: string): Promise<CodeChunk[]> {
    const { data, error } = await this.supabase
      .from('code_chunks')
      .select('*')
      .eq('project_id', projectId);

    if (error) {
      throw new Error(`Failed to get chunks for project: ${error.message}`);
    }

    return data.map(row => ({
      id: row.id,
      projectId: row.project_id,
      filePath: row.file_path,
      relativePath: row.relative_path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      language: row.language,
      embedding: row.embedding
    }));
  }

  async deleteChunksByFile(filePath: string, projectId?: string): Promise<void> {
    let query = this.supabase
      .from('code_chunks')
      .delete()
      .eq('file_path', filePath);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { error } = await query;

    if (error) {
      throw new Error(`Failed to delete chunks for file: ${error.message}`);
    }
  }

  async deleteChunksByProject(projectId: string): Promise<void> {
    const { error } = await this.supabase
      .from('code_chunks')
      .delete()
      .eq('project_id', projectId);

    if (error) {
      throw new Error(`Failed to delete chunks for project: ${error.message}`);
    }
  }

  async getAllFiles(projectId?: string): Promise<string[]> {
    let query = this.supabase
      .from('code_chunks')
      .select('file_path');

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get all files: ${error.message}`);
    }

    const uniqueFiles = [...new Set(data.map(row => row.file_path))];
    return uniqueFiles;
  }

  async getStats(projectId?: string): Promise<{ totalChunks: number; totalFiles: number }> {
    let chunksQuery = this.supabase.from('code_chunks').select('id', { count: 'exact' });
    let filesQuery = this.supabase.from('code_chunks').select('file_path');

    if (projectId) {
      chunksQuery = chunksQuery.eq('project_id', projectId);
      filesQuery = filesQuery.eq('project_id', projectId);
    }

    const [chunksResult, filesResult] = await Promise.all([
      chunksQuery,
      filesQuery
    ]);

    if (chunksResult.error) {
      throw new Error(`Failed to get chunk count: ${chunksResult.error.message}`);
    }

    if (filesResult.error) {
      throw new Error(`Failed to get file count: ${filesResult.error.message}`);
    }

    const uniqueFiles = [...new Set(filesResult.data.map(row => row.file_path))];

    return {
      totalChunks: chunksResult.count || 0,
      totalFiles: uniqueFiles.length
    };
  }
}