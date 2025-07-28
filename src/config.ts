import { OpenAIConfig, SupabaseConfig, IndexingOptions } from './types.js';

export const openaiConfig: OpenAIConfig = {
  apiKey: process.env.OPENAI_API_KEY || '',
  model: 'text-embedding-3-small'
};

export const supabaseConfig: SupabaseConfig = {
  url: process.env.SUPABASE_URL || '',
  anonKey: process.env.SUPABASE_ANON_KEY || ''
};

export const defaultIndexingOptions: IndexingOptions = {
  chunkSize: 1000,
  chunkOverlap: 200,
  excludePatterns: [
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '*.log',
    '*.lock',
    '*.map'
  ],
  includeExtensions: [
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
    '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.cs', '.html', '.css',
    '.scss', '.less', '.vue', '.svelte', '.json', '.yml', '.yaml', '.md'
  ]
};