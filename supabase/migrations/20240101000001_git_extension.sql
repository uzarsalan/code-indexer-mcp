-- Git Extension for Code Indexer MCP
-- Extends existing schema with Git-aware functionality

-- ============================================================================
-- GIT OBJECTS SCHEMA
-- ============================================================================

-- Git repositories table (extends projects)
CREATE TABLE IF NOT EXISTS git_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_url TEXT,
  local_path TEXT NOT NULL,
  default_branch TEXT DEFAULT 'main',
  is_active BOOLEAN DEFAULT true,
  last_sync TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT unique_project_repo UNIQUE(project_id)
);

-- Branch configuration and policies
CREATE TABLE IF NOT EXISTS git_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  is_indexed BOOLEAN DEFAULT false,
  index_policy JSONB DEFAULT '{}',
  priority INTEGER DEFAULT 0, -- Higher priority = indexed first
  last_commit_hash TEXT,
  last_indexed_commit TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT unique_repo_branch UNIQUE(repository_id, branch_name)
);

-- Git commits metadata
CREATE TABLE IF NOT EXISTS git_commits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  parent_hashes TEXT[] DEFAULT '{}',
  branch_names TEXT[] DEFAULT '{}', -- Commit can be in multiple branches
  author_name TEXT,
  author_email TEXT,
  committer_name TEXT,
  committer_email TEXT,
  commit_date TIMESTAMP WITH TIME ZONE,
  message TEXT,
  stats JSONB, -- {files_changed: 5, insertions: 100, deletions: 50}
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT unique_repo_commit UNIQUE(repository_id, commit_hash)
);

-- File changes in commits (for diff analysis)
CREATE TABLE IF NOT EXISTS git_file_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id UUID NOT NULL REFERENCES git_commits(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL, -- 'added', 'modified', 'deleted', 'renamed'
  old_path TEXT, -- For renames
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  is_binary BOOLEAN DEFAULT false,
  diff_content TEXT, -- Store actual diff for small changes
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- TEMPORAL CODE CHUNKS SCHEMA  
-- ============================================================================

-- Extend code_chunks with Git context (temporal dimension)
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS commit_id UUID REFERENCES git_commits(id) ON DELETE CASCADE;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS branch_name TEXT;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS commit_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS author_email TEXT;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS diff_context JSONB; -- Context about how this chunk changed

-- Temporal snapshots for efficient queries
CREATE TABLE IF NOT EXISTS temporal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
  branch_name TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  snapshot_date TIMESTAMP WITH TIME ZONE NOT NULL,
  total_chunks INTEGER DEFAULT 0,
  total_files INTEGER DEFAULT 0,
  indexing_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT unique_branch_commit UNIQUE(repository_id, branch_name, commit_hash)
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Git-specific indexes
CREATE INDEX IF NOT EXISTS idx_git_repositories_project ON git_repositories(project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_repo ON git_branches(repository_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_indexed ON git_branches(repository_id, is_indexed);
CREATE INDEX IF NOT EXISTS idx_git_commits_repo ON git_commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_git_commits_hash ON git_commits(commit_hash);
CREATE INDEX IF NOT EXISTS idx_git_commits_date ON git_commits(commit_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_branch ON git_commits USING GIN(branch_names);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_commit ON git_file_changes(commit_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_path ON git_file_changes(file_path);

-- Enhanced code_chunks indexes for temporal queries
CREATE INDEX IF NOT EXISTS idx_code_chunks_commit ON code_chunks(commit_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_branch ON code_chunks(branch_name);
CREATE INDEX IF NOT EXISTS idx_code_chunks_temporal ON code_chunks(project_id, branch_name, commit_date DESC);
CREATE INDEX IF NOT EXISTS idx_code_chunks_author ON code_chunks(author_email);

-- Temporal snapshots indexes
CREATE INDEX IF NOT EXISTS idx_temporal_snapshots_repo_branch ON temporal_snapshots(repository_id, branch_name);
CREATE INDEX IF NOT EXISTS idx_temporal_snapshots_date ON temporal_snapshots(snapshot_date DESC);

-- ============================================================================
-- ADVANCED FUNCTIONS FOR GIT-AWARE SEARCH
-- ============================================================================

-- Search code chunks with temporal filters
CREATE OR REPLACE FUNCTION search_code_chunks_temporal(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10,
  project_id_filter uuid DEFAULT NULL,
  branch_filter text DEFAULT NULL,
  date_from timestamp with time zone DEFAULT NULL,
  date_to timestamp with time zone DEFAULT NULL,
  author_filter text DEFAULT NULL
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
  similarity float,
  -- Git context
  commit_hash text,
  branch_name text,
  commit_date timestamp with time zone,
  author_email text,
  commit_message text
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
    1 - (cc.embedding <=> query_embedding) AS similarity,
    -- Git context from joins
    gc.commit_hash,
    cc.branch_name,
    cc.commit_date,
    cc.author_email,
    gc.message as commit_message
  FROM code_chunks cc
  LEFT JOIN git_commits gc ON cc.commit_id = gc.id
  WHERE 1 - (cc.embedding <=> query_embedding) > match_threshold
    AND (project_id_filter IS NULL OR cc.project_id = project_id_filter)
    AND (branch_filter IS NULL OR cc.branch_name = branch_filter)
    AND (date_from IS NULL OR cc.commit_date >= date_from)
    AND (date_to IS NULL OR cc.commit_date <= date_to)
    AND (author_filter IS NULL OR cc.author_email = author_filter)
  ORDER BY cc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Get code evolution for a specific file
CREATE OR REPLACE FUNCTION get_file_evolution(
  repo_id uuid,
  file_path_param text,
  branch_name_param text DEFAULT NULL,
  limit_count int DEFAULT 50
)
RETURNS TABLE (
  commit_hash text,
  commit_date timestamp with time zone,
  author_name text,
  commit_message text,
  change_type text,
  lines_added int,
  lines_removed int,
  chunk_content text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    gc.commit_hash,
    gc.commit_date,
    gc.author_name,
    gc.message as commit_message,
    gfc.change_type,
    gfc.lines_added,
    gfc.lines_removed,
    cc.content as chunk_content
  FROM git_commits gc
  JOIN git_file_changes gfc ON gc.id = gfc.commit_id
  LEFT JOIN code_chunks cc ON gc.id = cc.commit_id AND cc.relative_path = file_path_param
  WHERE gc.repository_id = repo_id
    AND gfc.file_path = file_path_param
    AND (branch_name_param IS NULL OR branch_name_param = ANY(gc.branch_names))
  ORDER BY gc.commit_date DESC
  LIMIT limit_count;
END;
$$;

-- Get branch comparison stats
CREATE OR REPLACE FUNCTION compare_branches(
  repo_id uuid,
  source_branch text,
  target_branch text
)
RETURNS TABLE (
  file_path text,
  chunks_in_source int,
  chunks_in_target int,
  chunks_different int,
  last_modified_source timestamp with time zone,
  last_modified_target timestamp with time zone
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(source.relative_path, target.relative_path) as file_path,
    COALESCE(source.chunk_count, 0) as chunks_in_source,
    COALESCE(target.chunk_count, 0) as chunks_in_target,
    COALESCE(ABS(source.chunk_count - target.chunk_count), 0) as chunks_different,
    source.last_modified as last_modified_source,
    target.last_modified as last_modified_target
  FROM (
    SELECT 
      relative_path,
      COUNT(*) as chunk_count,
      MAX(commit_date) as last_modified
    FROM code_chunks cc
    JOIN git_commits gc ON cc.commit_id = gc.id
    WHERE gc.repository_id = repo_id AND cc.branch_name = source_branch
    GROUP BY relative_path
  ) source
  FULL OUTER JOIN (
    SELECT 
      relative_path,
      COUNT(*) as chunk_count,
      MAX(commit_date) as last_modified
    FROM code_chunks cc
    JOIN git_commits gc ON cc.commit_id = gc.id
    WHERE gc.repository_id = repo_id AND cc.branch_name = target_branch
    GROUP BY relative_path
  ) target ON source.relative_path = target.relative_path
  ORDER BY chunks_different DESC;
END;
$$;

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC UPDATES
-- ============================================================================

-- Update branch last_commit_hash when new commits are added
CREATE OR REPLACE FUNCTION update_branch_last_commit()
RETURNS TRIGGER AS $$
BEGIN
  -- Update all branches that contain this commit
  UPDATE git_branches 
  SET 
    last_commit_hash = NEW.commit_hash,
    updated_at = NOW()
  WHERE repository_id = NEW.repository_id 
    AND branch_name = ANY(NEW.branch_names);
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_branch_last_commit ON git_commits;
CREATE TRIGGER trigger_update_branch_last_commit
  AFTER INSERT ON git_commits
  FOR EACH ROW
  EXECUTE FUNCTION update_branch_last_commit();

-- Auto-update temporal snapshots
CREATE OR REPLACE FUNCTION update_temporal_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO temporal_snapshots (repository_id, branch_name, commit_hash, snapshot_date, indexing_status)
  VALUES (
    (SELECT repository_id FROM git_commits WHERE id = NEW.commit_id),
    NEW.branch_name,
    (SELECT commit_hash FROM git_commits WHERE id = NEW.commit_id),
    NOW(),
    'processing'
  )
  ON CONFLICT (repository_id, branch_name, commit_hash) 
  DO UPDATE SET
    total_chunks = temporal_snapshots.total_chunks + 1,
    updated_at = NOW();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_temporal_snapshot ON code_chunks;
CREATE TRIGGER trigger_update_temporal_snapshot
  AFTER INSERT ON code_chunks
  FOR EACH ROW
  WHEN (NEW.commit_id IS NOT NULL)
  EXECUTE FUNCTION update_temporal_snapshot();

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Active branches view
CREATE OR REPLACE VIEW active_branches AS
SELECT 
  gb.*,
  gr.project_id,
  gr.remote_url,
  p.name as project_name
FROM git_branches gb
JOIN git_repositories gr ON gb.repository_id = gr.id
JOIN projects p ON gr.project_id = p.id
WHERE gb.is_indexed = true AND gr.is_active = true;

-- Latest commits per branch
CREATE OR REPLACE VIEW latest_branch_commits AS
SELECT DISTINCT ON (gc.repository_id, branch_name)
  gc.repository_id,
  branch_name,
  gc.commit_hash,
  gc.commit_date,
  gc.author_name,
  gc.message
FROM git_commits gc,
UNNEST(gc.branch_names) AS branch_name
ORDER BY gc.repository_id, branch_name, gc.commit_date DESC;

-- Repository statistics
CREATE OR REPLACE VIEW repository_stats AS
SELECT 
  gr.id as repository_id,
  gr.project_id,
  p.name as project_name,
  COUNT(DISTINCT gb.id) as total_branches,
  COUNT(DISTINCT CASE WHEN gb.is_indexed THEN gb.id END) as indexed_branches,
  COUNT(DISTINCT gc.id) as total_commits,
  COUNT(DISTINCT cc.id) as total_chunks,
  MAX(gc.commit_date) as latest_commit_date
FROM git_repositories gr
JOIN projects p ON gr.project_id = p.id
LEFT JOIN git_branches gb ON gr.id = gb.repository_id
LEFT JOIN git_commits gc ON gr.id = gc.repository_id
LEFT JOIN code_chunks cc ON gc.id = cc.commit_id
GROUP BY gr.id, gr.project_id, p.name;