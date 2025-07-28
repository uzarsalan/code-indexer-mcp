export interface Project {
  id: string;
  name: string;
  path: string;
  description?: string;
  indexingOptions: IndexingOptions;
  lastIndexed?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CodeChunk {
  id: string;
  projectId: string;
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  embedding?: number[];
  // Semantic enhancements
  nodeType?: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'module' | 'block';
  functionName?: string;
  className?: string;
  purpose?: string;        // AI-generated description of what this code does
  dependencies?: string[]; // imports, used functions/classes
  complexity?: number;     // cyclomatic complexity score
  parameters?: string[];   // function parameters
  returnType?: string;     // return type for functions
  docstring?: string;      // extracted documentation/comments
}

export interface SearchResult {
  chunk: CodeChunk;
  similarity: number;
}

export interface IndexingOptions {
  chunkSize: number;
  chunkOverlap: number;
  excludePatterns: string[];
  includeExtensions: string[];
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export interface OpenAIConfig {
  apiKey: string;
  model: string;
}