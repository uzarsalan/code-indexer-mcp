/**
 * Test Runner for Code Property Graph
 * Runs the comprehensive test suite
 */

import { runGraphTests } from './dist/graph/test-graph.js';

async function main() {
  console.log('🎯 Code Property Graph Test Runner');
  console.log('===================================\n');

  try {
    await runGraphTests();
    console.log('\n🎉 All tests passed! Graph system is working correctly.');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Tests failed:', error);
    process.exit(1);
  }
}

main();