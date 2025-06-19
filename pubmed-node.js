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
// Removed database dependency for better npx compatibility
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

// Initialize database (disabled for npx compatibility)
function initDatabase() {
  // Database functionality temporarily disabled for better npx compatibility
  // All search operations work without persistent storage
  return Promise.resolve();
}

// Rate limiting utility - Thread-safe implementation
let lastRequestTime = 0;
let requestQueue = Promise.resolve();

async function rateLimitedRequest() {
  // Use a queue to ensure thread-safe rate limiting
  return requestQueue = requestQueue.then(async () => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    
    lastRequestTime = Date.now();
  });
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
    // Add XML parsing options for security
    const parserOptions = {
      explicitArray: true,
      trim: true,
      normalize: true,
      normalizeTags: false,
      attrkey: '$',
      charkey: '_',
      // Security limits
      maxCharsInDocument: 50 * 1024 * 1024, // 50MB limit
      maxChildrenInDocument: 100000, // Max number of child elements
      maxDepth: 100 // Max nesting depth
    };
    
    parseString(xmlContent, parserOptions, (err, result) => {
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
              } else if (abstractText && typeof abstractText === 'object') {
                // 安全にLabelプロパティにアクセス
                const label = (abstractText.$ && abstractText.$.Label) ? abstractText.$.Label : '';
                const text = abstractText._ || '';
                
                if (text) {
                  abstractParts.push(label ? `${label}: ${text}` : text);
                }
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
          if (Array.isArray(article)) {
            for (const id of article) {
              if (id && id.$ && id.$.IdType && id._) {
                if (id.$.IdType === 'doi') {
                  articleData.elocationid = `doi:${id._}`;
                } else if (id.$.IdType === 'pmc') {
                  articleData.pmcid = id._;
                  articleData.pmc_available = true;
                }
              }
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
  const failedChunks = [];
  
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
      const chunkInfo = {
        startIndex: i,
        endIndex: i + chunk.length - 1,
        pmids: chunk,
        error: error.message,
        errorType: error.constructor.name
      };
      failedChunks.push(chunkInfo);
      
      console.error(`Error fetching chunk ${i}-${i + chunk.length}: ${error.message}`, {
        pmids: chunk.slice(0, 5), // Log first 5 PMIDs for debugging
        totalInChunk: chunk.length,
        errorType: error.constructor.name
      });
    }
  }
  
  // Log summary of failed chunks if any
  if (failedChunks.length > 0) {
    console.warn(`Failed to fetch ${failedChunks.length} chunk(s) out of ${Math.ceil(pmidList.length / chunkSize)} total chunks. ${allArticles.length} articles successfully retrieved.`);
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
      },
      {
        name: 'search_pmc_fulltext',
        description: 'Search PubMed Central (PMC) for full-text open access articles',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for full-text search'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results (default: 10, max: 50)',
              default: DEFAULT_MAX_RESULTS
            }
          },
          required: ['query']
        }
      },
      {
        name: 'retrieve_pubmed_results',
        description: 'Retrieve previously stored PubMed search results with pagination',
        inputSchema: {
          type: 'object',
          properties: {
            search_id: {
              type: 'number',
              description: 'ID of the stored search to retrieve'
            },
            page: {
              type: 'number',
              description: 'Page number to retrieve (starts at 1)',
              default: 1
            },
            results_per_page: {
              type: 'number',
              description: 'Number of results per page (default: 10, max: 50)',
              default: DEFAULT_MAX_RESULTS
            }
          },
          required: ['search_id']
        }
      },
      {
        name: 'list_pubmed_searches',
        description: 'List all previously stored PubMed and PMC searches',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_abstract_help',
        description: 'Get help and examples for using the get_full_abstract function',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
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
      case 'search_pmc_fulltext':
        return await handleSearchPmcFulltext(args.query, args.max_results);
      case 'retrieve_pubmed_results':
        return await handleRetrievePubmedResults(args.search_id, args.page, args.results_per_page);
      case 'list_pubmed_searches':
        return await handleListPubmedSearches();
      case 'get_abstract_help':
        return await handleGetAbstractHelp();
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
  
  // Enhanced maxResults validation
  if (typeof maxResults !== 'number' || isNaN(maxResults) || maxResults === null || maxResults === undefined) {
    maxResults = DEFAULT_MAX_RESULTS;
  }
  maxResults = Math.max(1, Math.min(Math.floor(Math.abs(maxResults)), MAX_SEARCH_RESULTS));
  
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

// Handle PMC fulltext search
async function handleSearchPmcFulltext(query, maxResults = DEFAULT_MAX_RESULTS) {
  if (!query || !query.trim()) {
    return {
      content: [{ type: 'text', text: '❌ Please provide a search query.' }]
    };
  }
  
  query = query.trim();
  
  // Enhanced maxResults validation for PMC
  if (typeof maxResults !== 'number' || isNaN(maxResults) || maxResults === null || maxResults === undefined) {
    maxResults = DEFAULT_MAX_RESULTS;
  }
  maxResults = Math.max(1, Math.min(Math.floor(Math.abs(maxResults)), 50));
  
  try {
    const articles = await search_pmc(query, maxResults);
    
    if (!articles || articles.length === 0) {
      return {
        content: [{ type: 'text', text: `🔍 No full-text articles found in PMC for query: **${query}**` }]
      };
    }
    
    // Format results
    const formattedArticles = articles.map(article => formatEnhancedArticle(article));
    
    // Create header
    let header = `📖 **PMC Full-Text Search - Found ${articles.length} result${articles.length !== 1 ? 's' : ''} for:** *${query}*\n`;
    header += `🔓 **All results have full text available**\n`;
    
    const disclaimer = '\n📖 **Note:** These are open access articles with full text available in PMC. Click the PMC links to access complete articles.';
    
    const resultText = header + '\n' + formattedArticles.join('\n') + disclaimer;
    
    return {
      content: [{ type: 'text', text: resultText }]
    };
    
  } catch (error) {
    const errorMessage = error instanceof PubMedError 
      ? `❌ PMC Error: ${error.message}`
      : `❌ An unexpected error occurred: ${error.message}`;
    
    return {
      content: [{ type: 'text', text: errorMessage }]
    };
  }
}

// Search PMC function (simplified version)
async function search_pmc(query, maxResults) {
  const searchParams = {
    db: 'pmc',
    term: query,
    retmax: maxResults,
    retmode: 'json',
    sort: 'relevance'
  };
  
  const searchResult = await makeNcbiRequest('esearch.fcgi', searchParams);
  
  if (!searchResult || !searchResult.esearchresult) {
    return [];
  }
  
  const idList = searchResult.esearchresult.idlist || [];
  
  if (idList.length === 0) {
    return [];
  }
  
  // Get detailed PMC information
  const summaryParams = {
    db: 'pmc',
    id: idList.join(','),
    retmode: 'json'
  };
  
  const summaryResult = await makeNcbiRequest('esummary.fcgi', summaryParams);
  
  if (!summaryResult || !summaryResult.result) {
    return [];
  }
  
  const articles = [];
  for (const pmcId of idList) {
    if (pmcId in summaryResult.result) {
      const articleData = summaryResult.result[pmcId];
      if (typeof articleData === 'object' && articleData.uid) {
        // Mark as PMC article
        articleData.is_pmc = true;
        articleData.pmcid = `PMC${pmcId}`;
        articles.push(articleData);
      }
    }
  }
  
  return articles;
}

// Handle retrieve pubmed results
async function handleRetrievePubmedResults(searchId, page = 1, resultsPerPage = DEFAULT_MAX_RESULTS) {
  return {
    content: [{ type: 'text', text: '📋 **Feature temporarily unavailable**: Database storage functionality is being implemented for the Node.js version. Please use the search functions directly.' }]
  };
}

// Handle list pubmed searches  
async function handleListPubmedSearches() {
  return {
    content: [{ type: 'text', text: '📋 **Feature temporarily unavailable**: Search history functionality is being implemented for the Node.js version. Please use the search functions directly.' }]
  };
}

// Handle get abstract help
async function handleGetAbstractHelp() {
  const helpText = `
📋 **Help: How to Use get_full_abstract Function**

**✅ Both formats now work:**
- \`get_full_abstract("35504917")\`   # String format (with quotes)
- \`get_full_abstract(35504917)\`     # Number format (without quotes)

**📈 Example PMIDs to try:**
- **35504917** - COVID-19 vaccine development review
- **38810186** - Medical AI and human values
- **36656942** - CRISPR technology (by Jennifer Doudna)
- **34465179** - Machine learning for healthcare
- **38301492** - AI-enhanced electrocardiography

**💡 Tips:**
1. PMIDs are usually 8 digits long
2. You can copy PMIDs directly from search results
3. Both \`12345678\` and \`"12345678"\` formats work
4. Function retrieves complete abstracts, MeSH terms, and keywords
5. Provides direct PubMed links for full articles

**🔍 What this function does:**
- Fetches complete abstracts (not truncated)
- Extracts MeSH terms and keywords
- Provides bibliographic information
- Generates direct PubMed links
- Works with any valid PMID`;

  return {
    content: [{ type: 'text', text: helpText }]
  };
}

// Initialize and start the server
async function main() {
  try {
    // Initialize database
    await initDatabase();
    
    // Create transport and start server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    // Enhanced PubMed MCP Server (Node.js) started successfully
  } catch (error) {
    console.error('Failed to start server:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Start the server
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  });
}

module.exports = { server };
