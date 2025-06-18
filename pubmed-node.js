#!/usr/bin/env node

/**
 * Enhanced PubMed Search MCP Server - Node.js Implementation
 * 
 * Pure Node.js version without Python dependencies
 * Features:
 * - Complete abstract retrieval using efetch
 * - PMC (PubMed Central) search for full-text articles
 * - SQLite database for search results storage
 * - MeSH terms and keywords extraction
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { parseString } = require('xml2js');
const path = require('path');
const fs = require('fs');

// Constants
const NCBI_API_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const USER_AGENT = 'enhanced-pubmed-mcp-server-node/1.0';
const DB_PATH = path.join(__dirname, 'enhanced_pubmed_searches.db');
const DEFAULT_MAX_RESULTS = 10;
const MAX_SEARCH_RESULTS = 500;
const API_TIMEOUT = 30000;
const RATE_LIMIT_DELAY = 340; // 3 requests per second

class PubMedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PubMedError';
  }
}

// Initialize SQLite database
function initDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(new PubMedError(`Failed to initialize database: ${err.message}`));
        return;
      }

      // Create tables
      db.serialize(() => {
        // Searches table
        db.run(`
          CREATE TABLE IF NOT EXISTS searches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            search_type TEXT NOT NULL DEFAULT 'pubmed',
            timestamp TEXT NOT NULL,
            result_count INTEGER NOT NULL,
            total_found INTEGER NOT NULL
          )
        `);

        // Articles table
        db.run(`
          CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            search_id INTEGER NOT NULL,
            pmid TEXT NOT NULL,
            pmcid TEXT,
            title TEXT NOT NULL,
            authors TEXT NOT NULL,
            journal TEXT NOT NULL,
            pub_date TEXT NOT NULL,
            doi TEXT,
            abstract TEXT,
            keywords TEXT,
            mesh_terms TEXT,
            is_open_access BOOLEAN DEFAULT 0,
            pmc_available BOOLEAN DEFAULT 0,
            FOREIGN KEY (search_id) REFERENCES searches (id),
            UNIQUE (search_id, pmid)
          )
        `);

        // Create indexes
        db.run('CREATE INDEX IF NOT EXISTS idx_articles_search_id ON articles(search_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_articles_pmid ON articles(pmid)');
        db.run('CREATE INDEX IF NOT EXISTS idx_articles_pmcid ON articles(pmcid)');
      });

      db.close((err) => {
        if (err) {
          reject(new PubMedError(`Failed to close database: ${err.message}`));
        } else {
          console.log('✅ Enhanced database initialized successfully');
          resolve();
        }
      });
    });
  });
}

// Rate limiting utility
let lastRequestTime = 0;
async function rateLimitedRequest() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
}

// Make NCBI API request
async function makeNcbiRequest(endpoint, params) {
  await rateLimitedRequest();
  
  const url = `${NCBI_API_BASE}${endpoint}`;
  const headers = { 'User-Agent': USER_AGENT };
  
  try {
    const response = await axios.get(url, {
      params,
      headers,
      timeout: API_TIMEOUT
    });
    
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      throw new PubMedError('Request timed out. Please try again.');
    } else if (error.response) {
      throw new PubMedError(`API request failed with status ${error.response.status}`);
    } else {
      throw new PubMedError(`Failed to fetch data from NCBI: ${error.message}`);
    }
  }
}

// Parse PubMed XML to extract article information
function parsePubMedXml(xmlContent) {
  return new Promise((resolve, reject) => {
    parseString(xmlContent, (err, result) => {
      if (err) {
        reject(new PubMedError(`Failed to parse XML: ${err.message}`));
        return;
      }

      const articles = [];
      
      try {
        const pubmedArticles = result?.PubmedArticleSet?.PubmedArticle || [];
        
        for (const articleElem of pubmedArticles) {
          const article = articleElem.PubmedData?.[0]?.ArticleIdList?.[0]?.ArticleId || [];
          const medlineCitation = articleElem.MedlineCitation?.[0];
          
          if (!medlineCitation) continue;
          
          const articleData = {};
          
          // Extract PMID
          const pmidElem = medlineCitation.PMID?.[0];
          if (pmidElem) {
            articleData.uid = pmidElem._ || pmidElem;
          }
          
          // Extract title
          const titleElem = medlineCitation.Article?.[0]?.ArticleTitle?.[0];
          if (titleElem) {
            articleData.title = typeof titleElem === 'string' ? titleElem : titleElem._ || 'No title available';
          }
          
          // Extract abstract
          const abstractElem = medlineCitation.Article?.[0]?.Abstract?.[0];
          if (abstractElem && abstractElem.AbstractText) {
            const abstractParts = [];
            for (const abstractText of abstractElem.AbstractText) {
              if (typeof abstractText === 'string') {
                abstractParts.push(abstractText);
              } else if (abstractText._) {
                const label = abstractText.$.Label || '';
                abstractParts.push(label ? `${label}: ${abstractText._}` : abstractText._);
              }
            }
            articleData.abstract = abstractParts.join(' ') || 'No abstract available';
          } else {
            articleData.abstract = 'No abstract available';
          }
          
          // Extract authors
          const authorList = medlineCitation.Article?.[0]?.AuthorList?.[0]?.Author || [];
          const authors = [];
          for (const author of authorList) {
            const lastName = author.LastName?.[0];
            const foreName = author.ForeName?.[0];
            if (lastName && foreName) {
              authors.push(`${foreName} ${lastName}`);
            } else if (lastName) {
              authors.push(lastName);
            }
          }
          articleData.authors = authors.map(name => ({ name }));
          
          // Extract journal info
          const journal = medlineCitation.Article?.[0]?.Journal?.[0];
          if (journal?.Title?.[0]) {
            articleData.fulljournalname = journal.Title[0];
          }
          
          // Extract publication date
          const pubDate = journal?.JournalIssue?.[0]?.PubDate?.[0];
          if (pubDate) {
            const year = pubDate.Year?.[0];
            const month = pubDate.Month?.[0];
            const day = pubDate.Day?.[0];
            const dateParts = [year, month, day].filter(Boolean);
            articleData.pubdate = dateParts.join(' ') || 'No date available';
          }
          
          // Extract DOI and other IDs
          for (const id of article) {
            if (id.$.IdType === 'doi') {
              articleData.elocationid = `doi:${id._}`;
            } else if (id.$.IdType === 'pmc') {
              articleData.pmcid = id._;
              articleData.pmc_available = true;
            }
          }
          
          // Extract MeSH terms
          const meshList = medlineCitation.MeshHeadingList?.[0]?.MeshHeading || [];
          const meshTerms = [];
          for (const mesh of meshList) {
            const descriptorName = mesh.DescriptorName?.[0];
            if (descriptorName) {
              meshTerms.push(typeof descriptorName === 'string' ? descriptorName : descriptorName._);
            }
          }
          articleData.mesh_terms = meshTerms;
          
          // Extract keywords
          const keywordList = medlineCitation.KeywordList?.[0]?.Keyword || [];
          const keywords = [];
          for (const keyword of keywordList) {
            if (typeof keyword === 'string') {
              keywords.push(keyword);
            } else if (keyword._) {
              keywords.push(keyword._);
            }
          }
          articleData.keywords = keywords;
          
          articles.push(articleData);
        }
      } catch (parseError) {
        reject(new PubMedError(`Error extracting article data: ${parseError.message}`));
        return;
      }
      
      resolve(articles);
    });
  });
}

// Fetch detailed articles using efetch
async function fetchDetailedArticles(pmidList) {
  if (!pmidList || pmidList.length === 0) return [];
  
  const chunkSize = 200;
  const allArticles = [];
  
  for (let i = 0; i < pmidList.length; i += chunkSize) {
    const chunk = pmidList.slice(i, i + chunkSize);
    
    try {
      const efetchParams = {
        db: 'pubmed',
        id: chunk.join(','),
        retmode: 'xml',
        rettype: 'abstract'
      };
      
      const xmlContent = await makeNcbiRequest('efetch.fcgi', efetchParams);
      const articles = await parsePubMedXml(xmlContent);
      allArticles.push(...articles);
    } catch (error) {
      console.error(`Error fetching chunk ${i}-${i + chunk.length}: ${error.message}`);
      // Continue with next chunk instead of failing completely
    }
  }
  
  return allArticles;
}

// Extract and normalize article information
function extractEnhancedArticleInfo(article) {
  const title = article.title || 'No title available';
  
  // Format authors
  const authors = article.authors || [];
  const authorNames = authors.map(author => 
    typeof author === 'object' ? author.name : author
  ).join(', ') || 'No authors listed';
  
  const pubDate = article.pubdate || 'No date available';
  const journal = article.fulljournalname || article.source || 'Unknown journal';
  const pmid = String(article.uid || 'No PMID');
  const pmcid = article.pmcid || '';
  
  let doi = article.elocationid || '';
  if (doi.startsWith('doi:')) {
    doi = doi.substring(4);
  }
  
  const abstract = article.abstract || 'No abstract available';
  
  const keywords = Array.isArray(article.keywords) 
    ? article.keywords.join(', ') 
    : String(article.keywords || '');
    
  const meshTerms = Array.isArray(article.mesh_terms) 
    ? article.mesh_terms.join(', ') 
    : String(article.mesh_terms || '');
  
  const pmcAvailable = Boolean(pmcid) || article.pmc_available || false;
  const isOpenAccess = article.is_pmc || pmcAvailable;
  
  return {
    pmid,
    pmcid,
    title,
    authors: authorNames,
    journal,
    pub_date: pubDate,
    doi,
    abstract,
    keywords,
    mesh_terms: meshTerms,
    is_open_access: isOpenAccess,
    pmc_available: pmcAvailable
  };
}

// Format article for display
function formatEnhancedArticle(article, isDbArticle = false) {
  const articleInfo = isDbArticle ? article : extractEnhancedArticleInfo(article);
  
  const {
    title = 'No title available',
    authors = 'No authors listed',
    pub_date = 'No date available',
    journal = 'Unknown journal',
    pmid = 'No PMID',
    pmcid = '',
    doi = '',
    abstract = 'No abstract available',
    keywords = '',
    mesh_terms = '',
    is_open_access = false,
    pmc_available = false
  } = articleInfo;
  
  // Truncate abstract if too long
  const displayAbstract = abstract.length > 800 ? abstract.substring(0, 800) + '...' : abstract;
  
  let result = `
**Title:** ${title}
**Authors:** ${authors}
**Journal:** ${journal} (${pub_date})
**PMID:** ${pmid}${pmcid ? ` | **PMCID:** ${pmcid}` : ''}${doi ? ` | **DOI:** ${doi}` : ''}
**Abstract:** ${displayAbstract}`;

  // Add access information
  if (pmc_available && pmcid) {
    result += `\n🔓 **Full Text Available:** https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`;
  }
  if (is_open_access) {
    result += `\n✅ **Open Access**`;
  }
  
  result += `\n**PubMed Link:** https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

  if (keywords) {
    result += `\n**Keywords:** ${keywords}`;
  }
  
  if (mesh_terms) {
    result += `\n**MeSH Terms:** ${mesh_terms}`;
  }
  
  return result + '\n---';
}

// Create and configure the MCP server
const server = new Server(
  {
    name: 'enhanced-pubmed-mcp-server-node',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_pubmed',
        description: 'Enhanced PubMed search with complete abstract retrieval and PMC integration',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match against papers'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results (default: 10, max: 500)',
              default: DEFAULT_MAX_RESULTS
            }
          },
          required: ['query']
        }
      },
      {
        name: 'get_full_abstract',
        description: 'Get the complete abstract for a specific PMID',
        inputSchema: {
          type: 'object',
          properties: {
            pmid: {
              type: ['string', 'number'],
              description: 'PubMed ID of the article'
            }
          },
          required: ['pmid']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_pubmed':
        return await handleSearchPubmed(args.query, args.max_results);
      case 'get_full_abstract':
        return await handleGetFullAbstract(args.pmid);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error.message}`);
  }
});

// Handle PubMed search
async function handleSearchPubmed(query, maxResults = DEFAULT_MAX_RESULTS) {
  if (!query || !query.trim()) {
    return {
      content: [{ type: 'text', text: '❌ Please provide a search query.' }]
    };
  }
  
  query = query.trim();
  maxResults = Math.max(1, Math.min(maxResults, MAX_SEARCH_RESULTS));
  
  try {
    // Search PubMed
    const searchParams = {
      db: 'pubmed',
      term: query,
      retmax: maxResults,
      retmode: 'json',
      sort: 'relevance'
    };
    
    const searchResult = await makeNcbiRequest('esearch.fcgi', searchParams);
    
    if (!searchResult || !searchResult.esearchresult) {
      return {
        content: [{ type: 'text', text: `🔍 No results found for query: **${query}**` }]
      };
    }
    
    const esearchResult = searchResult.esearchresult;
    const totalCount = parseInt(esearchResult.count || '0');
    const idList = esearchResult.idlist || [];
    
    if (totalCount === 0) {
      return {
        content: [{ type: 'text', text: `🔍 No results found for query: **${query}**` }]
      };
    }
    
    // Fetch detailed article information
    const articles = await fetchDetailedArticles(idList.slice(0, maxResults));
    
    if (!articles || articles.length === 0) {
      return {
        content: [{ type: 'text', text: `❌ No article details could be retrieved for query: **${query}**` }]
      };
    }
    
    // Format results
    const formattedArticles = articles.map(article => formatEnhancedArticle(article));
    
    // Create header
    let header = `🔬 **Enhanced PubMed Search - Found ${totalCount.toLocaleString()} result${totalCount !== 1 ? 's' : ''} for:** *${query}*\n`;
    if (totalCount > maxResults) {
      header += `📄 **Showing first ${articles.length} results**\n`;
    }
    
    // Count open access articles
    const openAccessCount = articles.filter(article => 
      extractEnhancedArticleInfo(article).pmc_available
    ).length;
    
    if (openAccessCount > 0) {
      header += `🔓 **${openAccessCount} full-text article${openAccessCount !== 1 ? 's' : ''} available in PMC**\n`;
    }
    
    // Add disclaimer
    const disclaimer = '\n📋 **Disclaimer:** These results are for informational purposes only and should not be considered medical advice. Consult a healthcare professional for medical concerns.';
    
    const resultText = header + '\n' + formattedArticles.join('\n') + disclaimer;
    
    return {
      content: [{ type: 'text', text: resultText }]
    };
    
  } catch (error) {
    const errorMessage = error instanceof PubMedError 
      ? `❌ PubMed Error: ${error.message}`
      : `❌ An unexpected error occurred: ${error.message}`;
    
    return {
      content: [{ type: 'text', text: errorMessage }]
    };
  }
}

// Handle get full abstract
async function handleGetFullAbstract(pmid) {
  if (!pmid) {
    return {
      content: [{ type: 'text', text: '❌ Please provide a valid PMID.' }]
    };
  }
  
  // Convert to string and clean up the PMID
  let pmidStr = String(pmid).trim();
  
  // Remove quotes if present
  if ((pmidStr.startsWith('"') && pmidStr.endsWith('"')) ||
      (pmidStr.startsWith("'") && pmidStr.endsWith("'"))) {
    pmidStr = pmidStr.slice(1, -1);
  }
  
  // Validate PMID (should be numeric)
  if (!/^\d+$/.test(pmidStr)) {
    return {
      content: [{ type: 'text', text: `❌ Invalid PMID format: ${pmid}. PMID should be a number.` }]
    };
  }
  
  try {
    // Use efetch to get detailed abstract
    const articles = await fetchDetailedArticles([pmidStr]);
    
    if (!articles || articles.length === 0) {
      return {
        content: [{ type: 'text', text: `❌ No article found for PMID: ${pmidStr}` }]
      };
    }
    
    const article = articles[0];
    const articleInfo = extractEnhancedArticleInfo(article);
    
    const {
      title = 'No title available',
      authors = 'No authors listed',
      journal = 'Unknown journal',
      pub_date = 'No date available',
      abstract = 'No abstract available',
      keywords = '',
      mesh_terms = ''
    } = articleInfo;
    
    let result = `
**📄 Complete Abstract for PMID: ${pmidStr}**

**Title:** ${title}
**Authors:** ${authors}
**Journal:** ${journal} (${pub_date})

**Abstract:**
${abstract}

**PubMed Link:** https://pubmed.ncbi.nlm.nih.gov/${pmidStr}/`;

    if (keywords) {
      result += `\n**Keywords:** ${keywords}`;
    }
    
    if (mesh_terms) {
      result += `\n**MeSH Terms:** ${mesh_terms}`;
    }
    
    return {
      content: [{ type: 'text', text: result }]
    };
    
  } catch (error) {
    const errorMessage = error instanceof PubMedError 
      ? `❌ PubMed Error: ${error.message}`
      : `❌ An unexpected error occurred: ${error.message}`;
    
    return {
      content: [{ type: 'text', text: errorMessage }]
    };
  }
}

// Initialize and start the server
async function main() {
  try {
    // Initialize database
    await initDatabase();
    
    // Create transport and start server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    console.error('🚀 Enhanced PubMed MCP Server (Node.js) started successfully');
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\n🛑 Shutting down Enhanced PubMed MCP Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\n🛑 Terminating Enhanced PubMed MCP Server...');
  process.exit(0);
});

// Start the server
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { server };