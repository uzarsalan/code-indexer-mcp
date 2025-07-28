-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  description TEXT,
  indexing_options JSONB DEFAULT '{}',
  last_indexed TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create the code_chunks table
CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_project_id ON code_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file_path ON code_chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_relative_path ON code_chunks(relative_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_language ON code_chunks(language);
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding ON code_chunks USING ivfflat (embedding vector_cosine_ops);

-- Function to search for similar code chunks
CREATE OR REPLACE FUNCTION search_code_chunks(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  project_id_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  id text,
  project_id uuid,
  file_path text,
  relative_path text,
  content text,
  start_line int,
  end_line int,
  language text,
  embedding vector(1536),
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cc.id,
    cc.project_id,
    cc.file_path,
    cc.relative_path,
    cc.content,
    cc.start_line,
    cc.end_line,
    cc.language,
    cc.embedding,
    1 - (cc.embedding <=> query_embedding) AS similarity
  FROM code_chunks cc
  WHERE 1 - (cc.embedding <=> query_embedding) > match_threshold
    AND (project_id_filter IS NULL OR cc.project_id = project_id_filter)
  ORDER BY cc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function to initialize the table (for RPC call)
CREATE OR REPLACE FUNCTION create_code_chunks_table()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- This function exists to be called via RPC to ensure table creation
  -- The actual table creation is handled above
  NULL;
END;
$$;