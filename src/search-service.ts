import { EmbeddingService } from './embeddings';
import { VectorStore } from './vector-store';
import { SearchResult } from './types';

export class SearchService {
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStore;

  constructor() {
    this.embeddingService = new EmbeddingService();
    this.vectorStore = new VectorStore();
  }

  async searchCode(
    query: string, 
    limit: number = 10, 
    threshold: number = 0.7,
    language?: string,
    projectId?: string
  ): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    let results = await this.vectorStore.searchSimilar(queryEmbedding, limit * 2, threshold, projectId);

    if (language) {
      results = results.filter(result => result.chunk.language === language);
    }

    return results.slice(0, limit);
  }

  async searchByFile(filePath: string, query: string, limit: number = 5, projectId?: string): Promise<SearchResult[]> {
    const chunks = await this.vectorStore.getChunksByFile(filePath, projectId);
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);

    const results: SearchResult[] = chunks
      .filter(chunk => chunk.embedding)
      .map(chunk => ({
        chunk,
        similarity: this.embeddingService.calculateSimilarity(
          queryEmbedding,
          chunk.embedding!
        )
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return results;
  }

  async getCodeContext(filePath: string, startLine: number, contextLines: number = 10, projectId?: string): Promise<string> {
    const chunks = await this.vectorStore.getChunksByFile(filePath, projectId);
    
    const relevantChunks = chunks.filter(chunk => 
      chunk.startLine <= startLine + contextLines && 
      chunk.endLine >= startLine - contextLines
    );

    if (relevantChunks.length === 0) {
      return 'No context found for the specified location';
    }

    relevantChunks.sort((a, b) => a.startLine - b.startLine);
    
    return relevantChunks
      .map(chunk => `Lines ${chunk.startLine}-${chunk.endLine}:\n${chunk.content}`)
      .join('\n\n---\n\n');
  }

  async findSimilarCode(filePath: string, startLine: number, endLine: number, limit: number = 5, projectId?: string): Promise<SearchResult[]> {
    const chunks = await this.vectorStore.getChunksByFile(filePath, projectId);
    const targetChunk = chunks.find(chunk => 
      chunk.startLine <= startLine && chunk.endLine >= endLine
    );

    if (!targetChunk || !targetChunk.embedding) {
      return [];
    }

    const allChunks = await this.vectorStore.searchSimilar(targetChunk.embedding, limit + 10, 0.5, projectId);
    
    return allChunks
      .filter(result => result.chunk.filePath !== filePath)
      .slice(0, limit);
  }
}