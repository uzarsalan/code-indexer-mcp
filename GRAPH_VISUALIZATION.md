# 🎨 Code Property Graph Visualization

Browser-based interactive visualization for the Code Property Graph system. Explore your codebase structure, dependencies, and relationships through an intuitive web interface.

## Features

### 🌐 Web Interface
- **Modern UI**: Clean, responsive design with sidebar controls
- **Real-time Data**: Live connection to your indexed projects
- **Multiple Layouts**: Force-directed, hierarchical, circular, and grid layouts
- **Interactive Elements**: Click, hover, zoom, and pan controls

### 🔍 Search & Discovery
- **Fuzzy Search**: Find nodes by name or purpose
- **Type Filtering**: Filter by node types (Functions, Classes, Variables, Modules)
- **Live Results**: Real-time search with instant visual feedback
- **Smart Navigation**: Click search results to center and highlight nodes

### 📊 Analytics Dashboard
- **Project Statistics**: Total nodes, edges, files, and health scores
- **Performance Metrics**: Graph complexity and bottleneck analysis
- **Impact Analysis**: See how changes affect other parts of your code
- **Circular Dependencies**: Identify and visualize dependency cycles

### 🎯 Node Details
- **Rich Information**: View signatures, purposes, complexity metrics
- **Connection Analysis**: See incoming and outgoing relationships
- **Risk Assessment**: Understand impact levels for modifications
- **File Context**: Direct links to source file locations

## Quick Start

### 1. Launch the Visualization Server

```bash
# Development mode (with hot reload)
npm run viz:dev

# Production mode
npm run viz:build

# Or directly with tsx
npm run viz
```

The server will start on `http://localhost:3000` by default.

### 2. Access the Web Interface

Open your browser and navigate to:
```
http://localhost:3000
```

### 3. Select a Project

1. Choose a project from the dropdown in the header
2. The graph will automatically load and render
3. Use the controls to filter and explore your code

## Interface Guide

### Header Controls
- **Project Selector**: Switch between indexed projects
- **Node Type Filter**: Show only specific types of code elements
- **Limit Control**: Control how many nodes to display
- **Refresh Button**: Reload the current project data

### Sidebar Sections

#### Project Statistics
- **Nodes**: Total number of code elements
- **Edges**: Total relationships between elements
- **Files**: Number of source files indexed
- **Health**: Overall code health score (0-100%)

#### Search
- **Search Box**: Type to find nodes by name or functionality
- **Results List**: Click results to navigate to nodes
- **Auto-complete**: Smart suggestions as you type

#### Node Details (when selected)
- **Basic Info**: Name, type, file location
- **Complexity**: Cyclomatic complexity metrics
- **Impact Analysis**: Risk levels and affected components
- **Signature**: Function/method signatures when available

### Graph Visualization

#### Node Types & Colors
- 🟢 **Functions** (Green): Methods and functions
- 🔵 **Classes** (Blue): Class definitions
- 🟠 **Variables** (Orange): Variable declarations
- 🟣 **Modules** (Purple): Module/package definitions
- 🩵 **Interfaces** (Cyan): Interface definitions
- 🤎 **Types** (Brown): Type definitions
- 🔘 **Imports** (Blue Grey): Import statements
- 🟡 **Exports** (Amber): Export statements

#### Edge Types & Colors
- 🟠 **Calls** (Deep Orange): Function/method calls
- 🟦 **Imports** (Indigo): Import relationships
- 🟪 **Extends** (Pink): Class inheritance
- 🩵 **Implements** (Teal): Interface implementation
- 🟢 **Uses** (Light Green): Variable usage
- 🟣 **Contains** (Deep Purple): Containment relationships
- 🟡 **Data Flow** (Lime): Data dependencies
- 🟠 **Control Flow** (Orange): Control flow relationships

#### Layout Options
- **Force-directed** (default): Natural clustering based on relationships
- **Hierarchical**: Top-down tree structure
- **Circular**: Arranged in concentric circles
- **Grid**: Regular grid arrangement

#### Interactions
- **Click Node**: Show detailed information in sidebar
- **Hover Node**: Display tooltip with basic info
- **Drag**: Pan around the graph
- **Scroll**: Zoom in and out
- **Background Click**: Deselect all nodes

## API Endpoints

The visualization server exposes a REST API:

### Projects
- `GET /api/projects` - List all projects with statistics
- `GET /api/projects/:id/graph` - Get graph data for visualization
- `GET /api/projects/:id/stats` - Get detailed project statistics

### Search
- `GET /api/projects/:id/search?q=query` - Search nodes within project

### Nodes
- `GET /api/nodes/:id/details` - Get detailed node information
- `GET /api/nodes/:id/connections` - Get node relationships

## Configuration

### Environment Variables
```bash
# Server port (default: 3000)
GRAPH_VIZ_PORT=3000

# Supabase configuration (inherited from main config)
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
```

### Customization

#### Colors
Edit the color mappings in `src/visualization/server.ts`:
```typescript
private getNodeColor(nodeType: string): string {
  const colors: Record<string, string> = {
    'FUNCTION': '#4CAF50',  // Change function color
    'CLASS': '#2196F3',     // Change class color
    // ... more colors
  };
}
```

#### Layout Settings
Modify layout parameters in `public/graph-viewer.html`:
```javascript
const layoutOptions = {
  'cose-bilkent': {
    nodeRepulsion: 4500,      // Node separation
    idealEdgeLength: 50,      // Preferred edge length
    edgeElasticity: 0.45      // Edge flexibility
  }
};
```

## Performance

### Optimization Tips
1. **Limit Nodes**: Use the limit control for large projects (recommended: 100-500)
2. **Filter Types**: Show only relevant node types to reduce complexity
3. **Progressive Loading**: Start with smaller limits and increase as needed
4. **Layout Selection**: Use hierarchical layout for better performance on large graphs

### Memory Usage
- **Browser**: ~1-2MB per 100 nodes displayed
- **Server**: ~10-50MB depending on project size
- **Database**: Queries are optimized with proper indexing

## Troubleshooting

### Common Issues

#### Server Won't Start
```bash
# Check if port is in use
lsof -i :3000

# Use different port
GRAPH_VIZ_PORT=3001 npm run viz:dev
```

#### No Projects Appear
1. Ensure projects are indexed in the database
2. Check Supabase connection configuration
3. Verify database migrations are applied

#### Graph Doesn't Load
1. Check browser developer console for errors
2. Verify project has nodes in the database
3. Try refreshing with the refresh button

#### Poor Performance
1. Reduce the node limit (try 50-100 nodes)
2. Filter by specific node types
3. Use grid or circular layout for large graphs
4. Clear browser cache and reload

### Debug Mode
Enable debug logging by adding to your `.env`:
```bash
DEBUG=graph-viz:*
LOG_LEVEL=debug
```

## Advanced Usage

### Custom Queries
Create custom graph views by modifying the API endpoints or adding new ones in `src/visualization/server.ts`.

### Integration
The visualization can be embedded in other applications:
```html
<iframe src="http://localhost:3000" width="100%" height="600px"></iframe>
```

### Export Options
While not implemented yet, future versions will support:
- PNG/SVG export of graph visualizations
- JSON export of graph data
- CSV export of node/edge lists

## Contributing

To extend the visualization:

1. **Add New Node Types**: Update color mappings and type filters
2. **New Layouts**: Integrate additional Cytoscape.js layout algorithms
3. **Enhanced Analytics**: Add more graph analysis features
4. **Export Features**: Implement graph export functionality

See the main project README for development setup and contribution guidelines.

---

🎯 **Happy Graph Exploration!** Use this tool to understand your codebase structure, identify bottlenecks, and make informed refactoring decisions.