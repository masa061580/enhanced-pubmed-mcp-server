#!/usr/bin/env node

/**
 * Enhanced PubMed MCP Server - CLI Executable
 * 
 * This script allows the MCP server to be executed via:
 * - npx enhanced-pubmed-mcp-server
 * - npx -y enhanced-pubmed-mcp-server
 */

const path = require('path');
const { spawn } = require('child_process');

// Get the actual server file path
const serverPath = path.join(__dirname, '..', 'pubmed-node.js');

// Parse command line arguments
const args = process.argv.slice(2);

// Check for help or version flags
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🔬 Enhanced PubMed MCP Server

Usage:
  npx enhanced-pubmed-mcp-server [options]
  npx -y enhanced-pubmed-mcp-server

Options:
  --help, -h     Show this help message
  --version, -v  Show version information

Claude Desktop Configuration:
{
  "mcpServers": {
    "pubmed": {
      "command": "npx",
      "args": ["-y", "enhanced-pubmed-mcp-server"]
    }
  }
}

Features:
- Enhanced PubMed search with complete abstracts
- PMC full-text search support
- MeSH terms and keywords extraction
- SQLite database for search history
- No Python dependencies required

Repository: https://github.com/your-repo/enhanced-pubmed-mcp-server
  `);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const packageJson = require('../package.json');
  console.log(`Enhanced PubMed MCP Server v${packageJson.version}`);
  process.exit(0);
}

// Start the MCP server
console.error('🚀 Starting Enhanced PubMed MCP Server...');
console.error(`📍 Server: ${serverPath}`);
console.error('─'.repeat(50));

// Spawn the main server process
const serverProcess = spawn('node', [serverPath, ...args], {
  stdio: 'inherit',
  shell: false
});

// Handle process events
serverProcess.on('error', (error) => {
  console.error(`❌ Failed to start MCP server: ${error.message}`);
  process.exit(1);
});

serverProcess.on('close', (code) => {
  if (code !== 0) {
    console.error(`\n❌ MCP server exited with code ${code}`);
    process.exit(code);
  } else {
    console.error('\n✅ Enhanced PubMed MCP Server stopped gracefully');
  }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\n🛑 Shutting down Enhanced PubMed MCP Server...');
  serverProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.error('\n🛑 Terminating Enhanced PubMed MCP Server...');
  serverProcess.kill('SIGTERM');
});