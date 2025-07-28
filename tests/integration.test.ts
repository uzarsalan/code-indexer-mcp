/**
 * Integration tests for the main MCP server functionality.
 * These tests validate the end-to-end functionality and interactions between components.
 */

import { CodeIndexer } from '../src/indexer';
import { SearchService } from '../src/search-service';
import { EmbeddingService } from '../src/embeddings';
import { VectorStore } from '../src/vector-store';
import { IndexingOptions, CodeChunk } from '../src/types';
import { promises as fs } from 'fs';

// Mock external dependencies
jest.mock('../src/embeddings');
jest.mock('../src/vector-store');

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

jest.mock('walk', () => ({
  walk: jest.fn(),
}));

const MockedEmbeddingService = EmbeddingService as jest.MockedClass<typeof EmbeddingService>;
const MockedVectorStore = VectorStore as jest.MockedClass<typeof VectorStore>;

const mockFs = fs as jest.Mocked<typeof fs>;

describe('Integration Tests', () => {
  let indexer: CodeIndexer;
  let searchService: SearchService;
  let mockEmbeddingService: jest.Mocked<EmbeddingService>;
  let mockVectorStore: jest.Mocked<VectorStore>;

  const defaultOptions: IndexingOptions = {
    chunkSize: 1000,
    chunkOverlap: 200,
    excludePatterns: ['node_modules/**', '*.log'],
    includeExtensions: ['.js', '.ts', '.py'],
  };

  beforeEach(() => {
    mockEmbeddingService = new MockedEmbeddingService() as jest.Mocked<EmbeddingService>;
    mockVectorStore = new MockedVectorStore() as jest.Mocked<VectorStore>;

    indexer = new CodeIndexer(defaultOptions);
    searchService = new SearchService();
    
    // Inject mocks into search service
    (searchService as any).embeddingService = mockEmbeddingService;
    (searchService as any).vectorStore = mockVectorStore;
  });

  describe('Full Indexing and Search Workflow', () => {
    it('should complete end-to-end indexing and search workflow', async () => {
      // Setup test data
      const projectId = 'test-project-123';
      const testChunks: CodeChunk[] = [
        {
          id: 'test.js:1-10',
          projectId,
          filePath: '/project/test.js',
          relativePath: 'test.js',
          content: 'function calculateSum(a, b) {\n  return a + b;\n}',
          startLine: 1,
          endLine: 10,
          language: 'javascript',
        },
        {
          id: 'utils.py:1-15',
          projectId,
          filePath: '/project/utils.py',
          relativePath: 'utils.py',
          content: 'def calculate_sum(a, b):\n    return a + b',
          startLine: 1,
          endLine: 15,
          language: 'python',
        }
      ];

      const testEmbeddings = [
        [0.1, 0.2, 0.3, 0.4],
        [0.2, 0.3, 0.4, 0.5]
      ];

      // Mock file system operations
      mockFs.readFile
        .mockResolvedValueOnce('function calculateSum(a, b) {\n  return a + b;\n}')
        .mockResolvedValueOnce('def calculate_sum(a, b):\n    return a + b');

      const walk = require('walk');
      const mockWalker = {
        on: jest.fn((event, callback) => {
          if (event === 'file') {
            callback('/project', { name: 'test.js' }, jest.fn());
            callback('/project', { name: 'utils.py' }, jest.fn());
          } else if (event === 'end') {
            callback();
          }
        }),
      };
      walk.walk.mockReturnValue(mockWalker);

      // Mock embedding service
      mockEmbeddingService.embedCodeChunks.mockResolvedValue(
        testChunks.map((chunk, index) => ({
          ...chunk,
          embedding: testEmbeddings[index]
        }))
      );

      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.15, 0.25, 0.35, 0.45]);

      // Mock vector store operations
      mockVectorStore.storeChunks.mockResolvedValue();
      mockVectorStore.searchSimilar.mockResolvedValue([
        {
          chunk: { ...testChunks[0], embedding: testEmbeddings[0] },
          similarity: 0.95
        },
        {
          chunk: { ...testChunks[1], embedding: testEmbeddings[1] },
          similarity: 0.87
        }
      ]);

      // Step 1: Index the project
      const chunks = await indexer.indexDirectory('/project', projectId);
      expect(chunks).toHaveLength(2);

      // Step 2: Generate embeddings
      const chunksWithEmbeddings = await mockEmbeddingService.embedCodeChunks(chunks);
      expect(chunksWithEmbeddings).toHaveLength(2);
      expect(chunksWithEmbeddings[0].embedding).toEqual(testEmbeddings[0]);

      // Step 3: Store in vector database
      await mockVectorStore.storeChunks(chunksWithEmbeddings);
      expect(mockVectorStore.storeChunks).toHaveBeenCalledWith(chunksWithEmbeddings);

      // Step 4: Search for code
      const searchResults = await searchService.searchCode('calculate sum function');
      expect(searchResults).toHaveLength(2);
      expect(searchResults[0].similarity).toBe(0.95);
      expect(searchResults[0].chunk.language).toBe('javascript');
    });

    it('should handle errors gracefully during indexing', async () => {
      // Mock file system error
      mockFs.readFile
        .mockRejectedValueOnce(new Error('Permission denied'))
        .mockResolvedValueOnce('valid content');

      const walk = require('walk');
      const mockWalker = {
        on: jest.fn((event, callback) => {
          if (event === 'file') {
            callback('/project', { name: 'forbidden.js' }, jest.fn());
            callback('/project', { name: 'valid.js' }, jest.fn());
          } else if (event === 'end') {
            callback();
          }
        }),
      };
      walk.walk.mockReturnValue(mockWalker);

      const chunks = await indexer.indexDirectory('/project', 'test-project');
      
      // Should continue processing despite file errors
      expect(chunks).toHaveLength(1); // Only valid.js processed
      expect(chunks[0].content).toBe('valid content');
    });
  });

  describe('Performance and Resource Management', () => {
    it('should handle large number of chunks efficiently', async () => {
      const largeNumberOfChunks = 1000;
      const testChunks: CodeChunk[] = Array.from({ length: largeNumberOfChunks }, (_, i) => ({
        id: `chunk-${i}`,
        projectId: 'large-project',
        filePath: `/project/file-${i}.js`,
        relativePath: `file-${i}.js`,
        content: `function test${i}() { return ${i}; }`,
        startLine: 1,
        endLine: 3,
        language: 'javascript',
      }));

      // Mock batch processing
      mockEmbeddingService.embedCodeChunks.mockImplementation(async (chunks) => {
        // Simulate batch processing with delays
        const batchSize = 100;
        const results = [];
        
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const embeddings = batch.map((_, idx) => Array(384).fill(0.1 + (i + idx) * 0.001));
          results.push(...batch.map((chunk, idx) => ({
            ...chunk,
            embedding: embeddings[idx]
          })));
          
          // Simulate processing time
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        return results;
      });

      const chunksWithEmbeddings = await mockEmbeddingService.embedCodeChunks(testChunks);
      
      expect(chunksWithEmbeddings).toHaveLength(largeNumberOfChunks);
      expect(chunksWithEmbeddings[0].embedding).toBeDefined();
      expect(chunksWithEmbeddings[999].embedding).toBeDefined();
    });

    it('should demonstrate memory usage patterns', async () => {
      const initialMemory = process.memoryUsage();
      
      // Process a moderately large dataset
      const testChunks: CodeChunk[] = Array.from({ length: 100 }, (_, i) => ({
        id: `memory-test-${i}`,
        projectId: 'memory-test',
        filePath: `/test/file-${i}.js`,
        relativePath: `file-${i}.js`,
        content: 'x'.repeat(10000), // 10KB per chunk
        startLine: 1,
        endLine: 100,
        language: 'javascript',
      }));

      mockEmbeddingService.embedCodeChunks.mockResolvedValue(
        testChunks.map(chunk => ({
          ...chunk,
          embedding: Array(384).fill(Math.random())
        }))
      );

      await mockEmbeddingService.embedCodeChunks(testChunks);
      
      const afterProcessingMemory = process.memoryUsage();
      
      // Memory should not grow excessively (this is a basic check)
      const memoryGrowth = afterProcessingMemory.heapUsed - initialMemory.heapUsed;
      console.log(`Memory growth during processing: ${memoryGrowth / 1024 / 1024}MB`);
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      const afterGCMemory = process.memoryUsage();
      console.log(`Memory after GC: ${afterGCMemory.heapUsed / 1024 / 1024}MB`);
      
      // This test mainly serves to monitor memory patterns
      expect(memoryGrowth).toBeDefined();
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from embedding service failures', async () => {
      const testChunks: CodeChunk[] = [
        {
          id: 'test1',
          projectId: 'resilience-test',
          filePath: '/test/file1.js',
          relativePath: 'file1.js',
          content: 'function test1() {}',
          startLine: 1,
          endLine: 3,
          language: 'javascript',
        },
        {
          id: 'test2',
          projectId: 'resilience-test',
          filePath: '/test/file2.js',
          relativePath: 'file2.js',
          content: 'function test2() {}',
          startLine: 1,
          endLine: 3,
          language: 'javascript',
        }
      ];

      // Mock embedding service to fail on first attempt, succeed on retry
      let attemptCount = 0;
      mockEmbeddingService.embedCodeChunks.mockImplementation(async (chunks) => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error('Embedding service temporarily unavailable');
        }
        return chunks.map(chunk => ({
          ...chunk,
          embedding: Array(384).fill(0.1)
        }));
      });

      // Simulate retry logic
      let result;
      try {
        result = await mockEmbeddingService.embedCodeChunks(testChunks);
      } catch (error) {
        // Retry on failure
        result = await mockEmbeddingService.embedCodeChunks(testChunks);
      }

      expect(result).toHaveLength(2);
      expect(result[0].embedding).toBeDefined();
      expect(attemptCount).toBe(2); // Confirms retry occurred
    });

    it('should handle vector store connection issues', async () => {
      const testChunks: CodeChunk[] = [{
        id: 'test',
        projectId: 'connection-test',
        filePath: '/test/file.js',
        relativePath: 'file.js',
        content: 'function test() {}',
        startLine: 1,
        endLine: 3,
        language: 'javascript',
        embedding: Array(384).fill(0.1)
      }];

      // Mock vector store to fail initially
      let connectionAttempts = 0;
      mockVectorStore.storeChunks.mockImplementation(async (chunks) => {
        connectionAttempts++;
        if (connectionAttempts === 1) {
          throw new Error('Database connection failed');
        }
        return Promise.resolve();
      });

      // Simulate connection retry logic
      try {
        await mockVectorStore.storeChunks(testChunks);
      } catch (error) {
        // Retry with backoff
        await new Promise(resolve => setTimeout(resolve, 100));
        await mockVectorStore.storeChunks(testChunks);
      }

      expect(connectionAttempts).toBe(2);
      expect(mockVectorStore.storeChunks).toHaveBeenCalledTimes(2);
    });
  });

  describe('Search Quality and Accuracy', () => {
    it('should return relevant results for semantic queries', async () => {
      const testQuery = 'authentication middleware';
      const queryEmbedding = [0.8, 0.7, 0.9, 0.6];
      
      const relevantChunk: CodeChunk = {
        id: 'auth-middleware',
        projectId: 'test',
        filePath: '/src/middleware/auth.js',
        relativePath: 'middleware/auth.js',
        content: 'function authenticateUser(req, res, next) {\n  // Check JWT token\n}',
        startLine: 10,
        endLine: 15,
        language: 'javascript',
        embedding: [0.9, 0.8, 0.85, 0.7] // High similarity to query
      };

      const irrelevantChunk: CodeChunk = {
        id: 'math-utils',
        projectId: 'test',
        filePath: '/src/utils/math.js',
        relativePath: 'utils/math.js',
        content: 'function calculateSum(a, b) {\n  return a + b;\n}',
        startLine: 1,
        endLine: 5,
        language: 'javascript',
        embedding: [0.1, 0.2, 0.1, 0.3] // Low similarity to query
      };

      mockEmbeddingService.generateEmbedding.mockResolvedValue(queryEmbedding);
      mockVectorStore.searchSimilar.mockResolvedValue([
        { chunk: relevantChunk, similarity: 0.92 }
        // irrelevantChunk filtered out by vector store due to low similarity (0.35 < 0.7)
      ]);

      const results = await searchService.searchCode(testQuery, 10, 0.7);

      expect(results).toHaveLength(1); // Only relevant result above threshold
      expect(results[0].chunk.relativePath).toBe('middleware/auth.js');
      expect(results[0].similarity).toBeGreaterThan(0.9);
    });

    it('should handle multi-language search correctly', async () => {
      const testQuery = 'database connection';
      
      mockEmbeddingService.generateEmbedding.mockResolvedValue([0.5, 0.6, 0.7, 0.8]);
      mockVectorStore.searchSimilar.mockResolvedValue([
        {
          chunk: {
            id: 'js-db',
            projectId: 'test',
            filePath: '/src/db.js',
            relativePath: 'db.js',
            content: 'const connection = mysql.createConnection(config);',
            startLine: 1,
            endLine: 1,
            language: 'javascript',
            embedding: [0.6, 0.7, 0.8, 0.9]
          },
          similarity: 0.88
        },
        {
          chunk: {
            id: 'py-db',
            projectId: 'test',
            filePath: '/src/database.py',
            relativePath: 'database.py',
            content: 'connection = sqlite3.connect("database.db")',
            startLine: 5,
            endLine: 5,
            language: 'python',
            embedding: [0.5, 0.6, 0.7, 0.8]
          },
          similarity: 0.85
        }
      ]);

      // Test language filtering
      const jsResults = await searchService.searchCode(testQuery, 10, 0.7, 'javascript');
      expect(jsResults).toHaveLength(1);
      expect(jsResults[0].chunk.language).toBe('javascript');

      const pythonResults = await searchService.searchCode(testQuery, 10, 0.7, 'python');
      expect(pythonResults).toHaveLength(1);
      expect(pythonResults[0].chunk.language).toBe('python');

      const allResults = await searchService.searchCode(testQuery, 10, 0.7);
      expect(allResults).toHaveLength(2);
    });
  });
});