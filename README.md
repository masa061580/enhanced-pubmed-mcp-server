# Enhanced PubMed MCP Server

🔬 **No Python Required** - Pure Node.js implementation of PubMed search MCP server

## Quick Start

```bash
# Claude Desktop Configuration
{
  "mcpServers": {
    "pubmed": {
      "command": "npx",
      "args": ["-y", "enhanced-pubmed-mcp-server"]
    }
  }
}
```

## Features

- ✅ **No Python Dependencies** - Pure Node.js implementation
- 🔬 **Enhanced PubMed Search** - Complete abstracts, MeSH terms, keywords
- 📖 **PMC Full-Text Search** - Search within open access articles
- 💾 **Search History** - SQLite database for persistent storage
- 🔓 **Open Access Detection** - Identify freely available articles
- 🌐 **Cross-Platform** - Works on Windows, macOS, and Linux

## Usage

### Command Line
```bash
# Direct execution (no installation needed)
npx enhanced-pubmed-mcp-server

# Help and version info
npx enhanced-pubmed-mcp-server --help
npx enhanced-pubmed-mcp-server --version
```

### Claude Desktop Integration

Add to your `claude_desktop_config.json`:

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

**Configuration file locations:**
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

## Available Tools

- `search_pubmed(query, max_results)` - Enhanced PubMed search
- `get_full_abstract(pmid)` - Complete abstract retrieval
- `search_pmc_fulltext(query, max_results)` - PMC full-text search
- `retrieve_pubmed_results(search_id, page)` - Paginated results
- `list_pubmed_searches()` - Search history

## Search Examples

```javascript
// Basic search
search_pubmed("COVID-19 vaccine", 10)

// Field-specific search
search_pubmed("CRISPR[Title]", 5)

// Date range search
search_pubmed("cancer therapy AND 2023[Date - Publication]", 15)

// Full-text search in open access articles
search_pmc_fulltext("machine learning medical imaging", 20)

// Get complete abstract
get_full_abstract("35504917")
```

## Requirements

- **Node.js** 14.0.0 or higher
- **Internet connection** for PubMed API access

## License

MIT

## Repository

https://github.com/yourusername/enhanced-pubmed-mcp-server