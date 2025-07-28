-- Code Property Graph Database Schema
-- Migration: 001_create_code_property_graph.sql

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Projects table (already exists, but ensure compatibility)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR NOT NULL UNIQUE,
  path VARCHAR NOT NULL,
  description TEXT,
  indexing_options JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Graph versions for incremental updates
CREATE TABLE graph_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  parent_version_id UUID REFERENCES graph_versions(id),
  checksum VARCHAR(64) NOT NULL,
  operations_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  
  UNIQUE(project_id, version_number)
);

-- Graph nodes - core entities in the code
CREATE TABLE graph_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES graph_versions(id) ON DELETE CASCADE,
  
  -- Node identification
  node_key VARCHAR NOT NULL, -- unique identifier within project (e.g., "src/auth.ts:loginUser")
  node_type VARCHAR NOT NULL CHECK (node_type IN (
    'FUNCTION', 'CLASS', 'VARIABLE', 'MODULE', 'PARAMETER', 
    'RETURN', 'CALL_SITE', 'IMPORT', 'EXPORT', 'INTERFACE', 
    'TYPE', 'NAMESPACE', 'BLOCK'
  )),
  
  -- Location information
  file_path VARCHAR NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER DEFAULT 0,
  end_column INTEGER DEFAULT 0,
  
  -- Node properties
  name VARCHAR,
  signature TEXT,
  language VARCHAR NOT NULL,
  visibility VARCHAR CHECK (visibility IN ('public', 'private', 'protected')),
  is_async BOOLEAN DEFAULT FALSE,
  is_static BOOLEAN DEFAULT FALSE,
  is_abstract BOOLEAN DEFAULT FALSE,
  
  -- Semantic information
  complexity INTEGER DEFAULT 1,
  parameters JSONB DEFAULT '[]',
  return_type VARCHAR,
  docstring TEXT,
  purpose TEXT, -- AI-generated description
  
  -- Technical metadata
  hash VARCHAR(64) NOT NULL, -- content hash for change detection
  dependencies JSONB DEFAULT '[]', -- array of imported/used identifiers
  exports JSONB DEFAULT '[]', -- what this node exports
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Constraints
  UNIQUE(project_id, node_key, version_id)
);

-- Graph edges - relationships between nodes
CREATE TABLE graph_edges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES graph_versions(id) ON DELETE CASCADE,
  
  -- Edge endpoints
  source_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  
  -- Edge type and properties
  edge_type VARCHAR NOT NULL CHECK (edge_type IN (
    'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'DATA_FLOW', 
    'CONTROL_FLOW', 'CONTAINS', 'USES', 'DEFINES', 'REFERENCES'
  )),
  
  -- Edge metadata
  weight DECIMAL DEFAULT 1.0,
  call_type VARCHAR CHECK (call_type IN ('direct', 'indirect', 'dynamic')),
  is_conditional BOOLEAN DEFAULT FALSE,
  is_loop_dependent BOOLEAN DEFAULT FALSE,
  is_async_context BOOLEAN DEFAULT FALSE,
  
  -- Additional properties as JSON
  properties JSONB DEFAULT '{}',
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate edges
  UNIQUE(source_node_id, target_node_id, edge_type, version_id)
);

-- Update operations log for incremental updates
CREATE TABLE graph_update_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES graph_versions(id) ON DELETE CASCADE,
  
  -- Operation details
  operation_type VARCHAR NOT NULL CHECK (operation_type IN (
    'ADD_NODE', 'UPDATE_NODE', 'DELETE_NODE', 
    'ADD_EDGE', 'UPDATE_EDGE', 'DELETE_EDGE'
  )),
  
  -- Target references
  node_id UUID REFERENCES graph_nodes(id),
  edge_id UUID REFERENCES graph_edges(id),
  
  -- Operation data
  operation_data JSONB NOT NULL,
  rollback_data JSONB, -- data needed for rollback
  
  -- Metadata
  file_path VARCHAR,
  change_reason VARCHAR,
  execution_time_ms INTEGER,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_graph_nodes_project_type ON graph_nodes(project_id, node_type);
CREATE INDEX idx_graph_nodes_file_path ON graph_nodes(project_id, file_path);
CREATE INDEX idx_graph_nodes_name ON graph_nodes(project_id, name) WHERE name IS NOT NULL;
CREATE INDEX idx_graph_nodes_hash ON graph_nodes(hash);
CREATE INDEX idx_graph_nodes_version ON graph_nodes(version_id);

CREATE INDEX idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX idx_graph_edges_target ON graph_edges(target_node_id);
CREATE INDEX idx_graph_edges_type ON graph_edges(project_id, edge_type);
CREATE INDEX idx_graph_edges_version ON graph_edges(version_id);

CREATE INDEX idx_graph_versions_project ON graph_versions(project_id, version_number DESC);

-- GIN indexes for JSONB columns
CREATE INDEX idx_graph_nodes_parameters ON graph_nodes USING GIN(parameters);
CREATE INDEX idx_graph_nodes_dependencies ON graph_nodes USING GIN(dependencies);
CREATE INDEX idx_graph_edges_properties ON graph_edges USING GIN(properties);

-- Full-text search indexes
CREATE INDEX idx_graph_nodes_search ON graph_nodes USING GIN(
  to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(docstring, '') || ' ' || COALESCE(purpose, ''))
);

-- Functions for graph operations

-- Get current version for a project
CREATE OR REPLACE FUNCTION get_current_version(p_project_id UUID)
RETURNS UUID AS $$
DECLARE
  current_version_id UUID;
BEGIN
  SELECT id INTO current_version_id
  FROM graph_versions
  WHERE project_id = p_project_id
  ORDER BY version_number DESC
  LIMIT 1;
  
  RETURN current_version_id;
END;
$$ LANGUAGE plpgsql;

-- Create new version
CREATE OR REPLACE FUNCTION create_new_version(
  p_project_id UUID,
  p_parent_version_id UUID DEFAULT NULL,
  p_checksum VARCHAR DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  new_version_id UUID;
  new_version_number INTEGER;
BEGIN
  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO new_version_number
  FROM graph_versions
  WHERE project_id = p_project_id;
  
  -- Create new version
  INSERT INTO graph_versions (project_id, version_number, parent_version_id, checksum)
  VALUES (p_project_id, new_version_number, p_parent_version_id, p_checksum)
  RETURNING id INTO new_version_id;
  
  RETURN new_version_id;
END;
$$ LANGUAGE plpgsql;

-- Find nodes by pattern
CREATE OR REPLACE FUNCTION find_nodes_by_pattern(
  p_project_id UUID,
  p_pattern VARCHAR,
  p_node_type VARCHAR DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
  node_id UUID,
  node_key VARCHAR,
  node_type VARCHAR,
  name VARCHAR,
  file_path VARCHAR,
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    n.id,
    n.node_key,
    n.node_type,
    n.name,
    n.file_path,
    similarity(n.name, p_pattern) as sim
  FROM graph_nodes n
  WHERE n.project_id = p_project_id
    AND n.version_id = get_current_version(p_project_id)
    AND (p_node_type IS NULL OR n.node_type = p_node_type)
    AND (n.name % p_pattern OR n.node_key % p_pattern)
  ORDER BY sim DESC, n.name
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Get node with all edges
CREATE OR REPLACE FUNCTION get_node_with_edges(p_node_id UUID)
RETURNS TABLE(
  node_data JSONB,
  incoming_edges JSONB,
  outgoing_edges JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    row_to_json(n)::jsonb as node_data,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'source', e.source_node_id,
          'target', e.target_node_id,
          'type', e.edge_type,
          'properties', e.properties
        )
      )
      FROM graph_edges e 
      WHERE e.target_node_id = p_node_id), '[]'::jsonb
    ) as incoming_edges,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'source', e.source_node_id,
          'target', e.target_node_id,
          'type', e.edge_type,
          'properties', e.properties
        )
      )
      FROM graph_edges e 
      WHERE e.source_node_id = p_node_id), '[]'::jsonb
    ) as outgoing_edges
  FROM graph_nodes n
  WHERE n.id = p_node_id;
END;
$$ LANGUAGE plpgsql;

-- Find circular dependencies
CREATE OR REPLACE FUNCTION find_circular_dependencies(
  p_project_id UUID,
  p_max_depth INTEGER DEFAULT 10
)
RETURNS TABLE(
  cycle_nodes UUID[],
  cycle_length INTEGER,
  edge_types VARCHAR[]
) AS $$
WITH RECURSIVE dependency_paths AS (
  -- Base case: start from each node
  SELECT 
    e.source_node_id as start_node,
    e.target_node_id as current_node,
    ARRAY[e.source_node_id] as path,
    ARRAY[e.edge_type] as edge_types,
    1 as depth
  FROM graph_edges e
  JOIN graph_nodes n ON e.source_node_id = n.id
  WHERE n.project_id = p_project_id
    AND n.version_id = get_current_version(p_project_id)
    AND e.edge_type IN ('CALLS', 'IMPORTS', 'EXTENDS', 'USES')
  
  UNION ALL
  
  -- Recursive case: extend paths
  SELECT 
    dp.start_node,
    e.target_node_id,
    dp.path || e.target_node_id,
    dp.edge_types || e.edge_type,
    dp.depth + 1
  FROM dependency_paths dp
  JOIN graph_edges e ON dp.current_node = e.source_node_id
  WHERE dp.depth < p_max_depth
    AND NOT (e.target_node_id = ANY(dp.path)) -- Avoid infinite loops in recursion
)
SELECT 
  dp.path || dp.current_node as cycle_nodes,
  array_length(dp.path || dp.current_node, 1) as cycle_length,
  dp.edge_types
FROM dependency_paths dp
WHERE dp.current_node = dp.start_node -- Found a cycle
  AND dp.depth > 1 -- Ignore self-loops of length 1
ORDER BY cycle_length;
$$ LANGUAGE sql;

-- Update node timestamps automatically
CREATE OR REPLACE FUNCTION update_node_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_graph_nodes_timestamp
  BEFORE UPDATE ON graph_nodes
  FOR EACH ROW EXECUTE FUNCTION update_node_timestamp();

-- Graph statistics view
CREATE VIEW graph_statistics AS
SELECT 
  p.id as project_id,
  p.name as project_name,
  gv.version_number,
  COUNT(DISTINCT gn.id) as total_nodes,
  COUNT(DISTINCT ge.id) as total_edges,
  COUNT(DISTINCT gn.file_path) as total_files,
  COUNT(DISTINCT CASE WHEN gn.node_type = 'FUNCTION' THEN gn.id END) as function_count,
  COUNT(DISTINCT CASE WHEN gn.node_type = 'CLASS' THEN gn.id END) as class_count,
  COUNT(DISTINCT CASE WHEN gn.node_type = 'MODULE' THEN gn.id END) as module_count,
  AVG(gn.complexity) as avg_complexity,
  gv.created_at as version_created
FROM projects p
LEFT JOIN graph_versions gv ON p.id = gv.project_id
LEFT JOIN graph_nodes gn ON gv.id = gn.version_id  
LEFT JOIN graph_edges ge ON gv.id = ge.version_id
GROUP BY p.id, p.name, gv.id, gv.version_number, gv.created_at;

-- Comments for documentation
COMMENT ON TABLE graph_nodes IS 'Stores all nodes in the code property graph including functions, classes, variables, etc.';
COMMENT ON TABLE graph_edges IS 'Stores relationships between nodes such as function calls, imports, inheritance, etc.';
COMMENT ON TABLE graph_versions IS 'Tracks different versions of the graph for incremental updates and rollback support';
COMMENT ON TABLE graph_update_operations IS 'Logs all update operations for debugging and rollback purposes';

COMMENT ON COLUMN graph_nodes.node_key IS 'Unique identifier for the node within the project (e.g., file:line:name)';
COMMENT ON COLUMN graph_nodes.hash IS 'Content hash used for change detection in incremental updates';
COMMENT ON COLUMN graph_nodes.purpose IS 'AI-generated description of what this code element does';
COMMENT ON COLUMN graph_edges.weight IS 'Numeric weight representing the strength or importance of this relationship';