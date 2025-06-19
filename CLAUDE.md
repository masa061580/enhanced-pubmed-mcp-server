# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Enhanced PubMed MCP Server - A pure Node.js implementation of a Model Context Protocol (MCP) server for PubMed and PMC searches. No Python dependencies required.

## Development Commands

### Basic Operations
- `npm start` / `npm run dev` / `npm run server` - Start the MCP server
- `npm test` - Basic dependency check
- `npm run test-npx` - Test npx execution with version check

### Testing the Server
- `npx enhanced-pubmed-mcp-server --help` - Show help information
- `npx enhanced-pubmed-mcp-server --version` - Show version information
- `node pubmed-node.js` - Run server directly

## Architecture

### Core Components
- **`pubmed-node.js`** - Main MCP server implementation with all business logic
- **`bin/enhanced-pubmed-mcp.js`** - CLI wrapper for npx execution
- **`package.json`** - Node.js package configuration with bin entries

### MCP Tools Available
1. `search_pubmed(query, max_results)` - Enhanced PubMed search with complete abstracts
2. `get_full_abstract(pmid)` - Retrieve complete abstract for specific PMID
3. `search_pmc_fulltext(query, max_results)` - PMC full-text search
4. `retrieve_pubmed_results(search_id, page)` - Paginated results (disabled in current version)
5. `list_pubmed_searches()` - Search history (disabled in current version)
6. `get_abstract_help()` - Help for abstract function

### Key Technical Details
- Uses `@modelcontextprotocol/sdk` for MCP implementation
- NCBI E-utilities API integration via `axios`
- XML parsing with `xml2js` for PubMed responses
- Rate limiting: 3 requests per second (340ms delay)
- Maximum results: 500 for PubMed, 50 for PMC
- No database persistence (SQLite functionality disabled for npx compatibility)

### Data Flow
1. Search requests go through `esearch.fcgi` for PMIDs
2. Detailed abstracts fetched via `efetch.fcgi` 
3. PMC searches use separate `pmc` database
4. Results formatted with enhanced metadata (MeSH terms, keywords, DOI, PMC links)

### Claude Desktop Integration
The server is designed to work with Claude Desktop via npx:
```json
{
  "mcpServers": {
    "pubmed": {
      "command": "npx",
      "args": ["-y", "enhanced-pubmed-mcp-server"]
    }
  }
}
```

### Error Handling
- Custom `PubMedError` class for API-specific errors
- Graceful handling of XML parsing failures
- Rate limiting and timeout management (30s timeout)
- Chunk processing for large result sets (200 PMIDs per chunk)