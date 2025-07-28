#!/usr/bin/env node

/**
 * Launch script for Code Property Graph Visualization
 */

import { GraphVisualizationServer } from './server.js';

const DEFAULT_PORT = 3000;

function main() {
  const port = process.env.GRAPH_VIZ_PORT ? parseInt(process.env.GRAPH_VIZ_PORT) : DEFAULT_PORT;
  
  console.log('🎨 Starting Code Property Graph Visualization Server...');
  console.log('====================================================');
  
  const server = new GraphVisualizationServer(port);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    process.exit(0);
  });
  
  // Start the server
  server.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };