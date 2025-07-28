import { SearchService } from '../src/search-service';
import { EmbeddingService } from '../src/embeddings';
import { VectorStore } from '../src/vector-store';
import { CodeChunk, SearchResult } from '../src/types';

jest.mock('../src/embeddings');
jest.mock('../src/vector-store');

const MockedEmbeddingService = EmbeddingService as jest.MockedClass<typeof EmbeddingService>;
const MockedVectorStore = VectorStore as jest.MockedClass<typeof VectorStore>;

describe('SearchService', () => {
  let searchService: SearchService;
  let mockEmbeddingService: jest.Mocked<EmbeddingService>;
  let mockVectorStore: jest.Mocked<VectorStore>;

  beforeEach(() => {
    mockEmbeddingService = new MockedEmbeddingService() as jest.Mocked<EmbeddingService>;
    mockVectorStore = new MockedVectorStore() as jest.Mocked<VectorStore>;
    
    searchService = new SearchService();
    (searchService as any).embeddingService = mockEmbeddingService;
    (searchService as any).vectorStore = mockVectorStore;
  });

  describe('searchCode', () => {
    const mockQueryEmbedding = [0.1, 0.2, 0.3];
    const mockSearchResults: SearchResult[] = [
      {
        chunk: {
          id: 'chunk1',
          projectId: 'proj1',
          filePath: '/test/file1.js',
          relativePath: 'file1.js',
          content: 'function test() {}',
          startLine: 1,
          endLine: 3,
          language: 'javascript',
          embedding: [0.1, 0.2, 0.3]
        },
        similarity: 0.95
      },
      {
        chunk: {
          id: 'chunk2',
          projectId: 'proj1',
          filePath: '/test/file2.py',
          relativePath: 'file2.py',
          content: 'def test(): pass',
          startLine: 1,
          endLine: 2,
          language: 'python',
          embedding: [0.2, 0.3, 0.4]
        },
        similarity: 0.85
      }
    ];

    beforeEach(() => {
      mockEmbeddingService.generateEmbedding.mockResolvedValue(mockQueryEmbedding);
      mockVectorStore.searchSimilar.mockResolvedValue(mockSearchResults);
    });

    it('should search for code and return results', async () => {
      const results = await searchService.searchCode('test function', 10, 0.7);

      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('test function');
      expect(mockVectorStore.searchSimilar).toHaveBeenCalledWith(mockQueryEmbedding, 20, 0.7, undefined);
      expect(results).toEqual(mockSearchResults);
    });

    it('should filter results by language when specified', async () => {
      const results = await searchService.searchCode('test function', 10, 0.7, 'javascript');

      expect(results).toHaveLength(1);
      expect(results[0].chunk.language).toBe('javascript');
    });

    it('should limit results to specified count', async () => {
      const results = await searchService.searchCode('test function', 1, 0.7);

      expect(results).toHaveLength(1);
    });

    it('should pass projectId to vector store when provided', async () => {
      await searchService.searchCode('test function', 10, 0.7, undefined, 'project-123');

      expect(mockVectorStore.searchSimilar).toHaveBeenCalledWith(
        mockQueryEmbedding, 
        20, 
        0.7, 
        'project-123'
      );
    });
  });

  describe('searchByFile', () => {
    const mockChunks: CodeChunk[] = [
      {
        id: 'chunk1',
        projectId: 'proj1',
        filePath: '/test/file1.js',
        relativePath: 'file1.js',
        content: 'function test() {}',
        startLine: 1,
        endLine: 3,
        language: 'javascript',
        embedding: [0.1, 0.2, 0.3]
      },
      {
        id: 'chunk2',
        projectId: 'proj1',
        filePath: '/test/file1.js',
        relativePath: 'file1.js',
        content: 'function helper() {}',
        startLine: 5,
        endLine: 7,
        language: 'javascript',
        embedding: [0.4, 0.5, 0.6]
      }
    ];

    beforeEach(() => {
      mockVectorStore.getChunksByFile.mockResolvedValue(mockChunks);
      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      mockEmbeddingService.calculateSimilarity.mockReturnValueOnce(0.9).mockReturnValueOnce(0.7);
    });

    it('should search within a specific file', async () => {
      const results = await searchService.searchByFile('/test/file1.js', 'test function', 5);

      expect(mockVectorStore.getChunksByFile).toHaveBeenCalledWith('/test/file1.js', undefined);
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalledWith('test function');
      expect(results).toHaveLength(2);
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('should filter out chunks without embeddings', async () => {
      const chunksWithoutEmbedding = [
        { ...mockChunks[0], embedding: undefined },
        mockChunks[1]
      ];
      mockVectorStore.getChunksByFile.mockResolvedValue(chunksWithoutEmbedding);
      mockEmbeddingService.calculateSimilarity.mockReturnValueOnce(0.8);

      const results = await searchService.searchByFile('/test/file1.js', 'test function', 5);

      expect(results).toHaveLength(1);
    });
  });

  describe('getCodeContext', () => {
    const mockChunks: CodeChunk[] = [
      {
        id: 'chunk1',
        projectId: 'proj1',
        filePath: '/test/file1.js',
        relativePath: 'file1.js',
        content: 'function test() {\n  console.log("start");\n}',
        startLine: 1,
        endLine: 3,
        language: 'javascript'
      },
      {
        id: 'chunk2',
        projectId: 'proj1',
        filePath: '/test/file1.js',
        relativePath: 'file1.js',
        content: 'function helper() {\n  return true;\n}',
        startLine: 5,
        endLine: 7,
        language: 'javascript'
      }
    ];

    beforeEach(() => {
      mockVectorStore.getChunksByFile.mockResolvedValue(mockChunks);
    });

    it('should return code context around specified line', async () => {
      const context = await searchService.getCodeContext('/test/file1.js', 2, 10);

      expect(context).toContain('Lines 1-3:');
      expect(context).toContain('function test()');
      expect(context).toContain('function helper()'); // Line 2 + 10 context should reach line 12, includes lines 5-7
    });

    it('should return message when no context found', async () => {
      const context = await searchService.getCodeContext('/test/file1.js', 100, 5);

      expect(context).toBe('No context found for the specified location');
    });

    it('should sort chunks by start line', async () => {
      const unsortedChunks = [mockChunks[1], mockChunks[0]]; // Reverse order
      mockVectorStore.getChunksByFile.mockResolvedValue(unsortedChunks);

      const context = await searchService.getCodeContext('/test/file1.js', 4, 10);

      const lines = context.split('\n');
      const firstChunkIndex = lines.findIndex(line => line.includes('Lines 1-3:'));
      const secondChunkIndex = lines.findIndex(line => line.includes('Lines 5-7:'));
      
      expect(firstChunkIndex).toBeLessThan(secondChunkIndex);
    });
  });

  describe('findSimilarCode', () => {
    const mockChunks: CodeChunk[] = [
      {
        id: 'chunk1',
        projectId: 'proj1',
        filePath: '/test/source.js',
        relativePath: 'source.js',
        content: 'function target() {}',
        startLine: 1,
        endLine: 3,
        language: 'javascript',
        embedding: [0.1, 0.2, 0.3]
      }
    ];

    const mockSimilarResults: SearchResult[] = [
      {
        chunk: {
          id: 'similar1',
          projectId: 'proj1',
          filePath: '/test/other.js',
          relativePath: 'other.js',
          content: 'function similar() {}',
          startLine: 1,
          endLine: 3,
          language: 'javascript',
          embedding: [0.2, 0.3, 0.4]
        },
        similarity: 0.88
      },
      {
        chunk: {
          id: 'similar2',
          projectId: 'proj1',
          filePath: '/test/source.js', // Same file - should be filtered out
          relativePath: 'source.js',
          content: 'function another() {}',
          startLine: 5,
          endLine: 7,
          language: 'javascript',
          embedding: [0.3, 0.4, 0.5]
        },
        similarity: 0.85
      }
    ];

    beforeEach(() => {
      mockVectorStore.getChunksByFile.mockResolvedValue(mockChunks);
      mockVectorStore.searchSimilar.mockResolvedValue(mockSimilarResults);
    });

    it('should find similar code blocks', async () => {
      const results = await searchService.findSimilarCode('/test/source.js', 1, 3, 5);

      expect(mockVectorStore.getChunksByFile).toHaveBeenCalledWith('/test/source.js', undefined);
      expect(mockVectorStore.searchSimilar).toHaveBeenCalledWith([0.1, 0.2, 0.3], 15, 0.5, undefined);
      expect(results).toHaveLength(1); // Should exclude same file
      expect(results[0].chunk.filePath).toBe('/test/other.js');
    });

    it('should return empty array when target chunk not found', async () => {
      mockVectorStore.getChunksByFile.mockResolvedValue([]);

      const results = await searchService.findSimilarCode('/test/source.js', 1, 3, 5);

      expect(results).toEqual([]);
    });

    it('should return empty array when target chunk has no embedding', async () => {
      const chunkWithoutEmbedding = { ...mockChunks[0], embedding: undefined };
      mockVectorStore.getChunksByFile.mockResolvedValue([chunkWithoutEmbedding]);

      const results = await searchService.findSimilarCode('/test/source.js', 1, 3, 5);

      expect(results).toEqual([]);
    });

    it('should find chunk that contains the specified line range', async () => {
      const chunksWithDifferentRanges: CodeChunk[] = [
        {
          ...mockChunks[0],
          startLine: 1,
          endLine: 10, // Contains lines 2-5
        },
        {
          ...mockChunks[0],
          id: 'chunk2',
          startLine: 15,
          endLine: 20, // Does not contain lines 2-5
        }
      ];
      mockVectorStore.getChunksByFile.mockResolvedValue(chunksWithDifferentRanges);

      await searchService.findSimilarCode('/test/source.js', 2, 5, 5);

      // Should use the first chunk that contains the range
      expect(mockVectorStore.searchSimilar).toHaveBeenCalledWith([0.1, 0.2, 0.3], 15, 0.5, undefined);
    });
  });
});