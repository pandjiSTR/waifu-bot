import pino from 'pino';

const logger = pino({ name: 'search', level: process.env.LOG_LEVEL || 'warn' });

// Base URL for Ollama Cloud web search/fetch APIs.
// Cloud-only: must be https://ollama.com, not a custom OLLAMA_HOST.
// Overridable via OLLAMA_WEB_BASE for testing or alternate endpoints.
const WEB_BASE = process.env.OLLAMA_WEB_BASE || 'https://ollama.com';

/**
 * Perform a web search via the Ollama Cloud web_search API.
 *
 * POST ${WEB_BASE}/api/web_search with Authorization: Bearer <API_KEY>.
 * Returns a formatted context string with numbered results, each containing
 * title, URL, and ~300 chars of content. On any error / non-200 / empty
 * results, returns '' (never throws).
 *
 * @param {string} query
 * @param {{maxResults?:number}} [opts]
 * @returns {Promise<string>} formatted results string or ''
 */
export async function webSearch(query, opts = {}) {
  const maxResults = opts.maxResults || 5;
  const apiKey = process.env.OLLAMA_API_KEY;

  if (!apiKey) {
    logger.warn('OLLAMA_API_KEY not set — web search unavailable');
    return '';
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    return '';
  }

  try {
    const url = `${WEB_BASE}/api/web_search?ts=${Date.now()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: query.trim(), max_results: maxResults }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'web_search returned non-200');
      return '';
    }

    const data = await response.json();

    // Handle both capital-R Results and lowercase results.
    const results = data?.Results || data?.results || [];

    if (!Array.isArray(results) || results.length === 0) {
      return '';
    }

    const lines = results.slice(0, maxResults).map((r, i) => {
      const title = r.Title || r.title || '(no title)';
      const url = r.URL || r.url || '';
      let content = r.Content || r.content || '';
      if (content.length > 300) {
        content = content.slice(0, 300) + '...';
      }
      return `${i + 1}. ${title} (${url})\n${content}`;
    });

    return lines.join('\n\n') + '\n';
  } catch (err) {
    logger.warn({ err }, 'webSearch failed');
    return '';
  }
}

/**
 * Fetch the full text content of a URL via the Ollama Cloud web_fetch API.
 *
 * POST ${WEB_BASE}/api/web_fetch with Authorization: Bearer <API_KEY>.
 * Returns the page title + content truncated to ~2000 chars, or '' on error.
 *
 * @param {string} url
 * @returns {Promise<string>} page content or ''
 */
export async function webFetch(url) {
  const apiKey = process.env.OLLAMA_API_KEY;

  if (!apiKey) {
    logger.warn('OLLAMA_API_KEY not set — web fetch unavailable');
    return '';
  }

  if (!url || typeof url !== 'string' || !url.trim()) {
    return '';
  }

  try {
    const fetchUrl = `${WEB_BASE}/api/web_fetch?ts=${Date.now()}`;
    const response = await fetch(fetchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: url.trim() }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'web_fetch returned non-200');
      return '';
    }

    const data = await response.json();
    const title = data?.Title || data?.title || '';
    let content = data?.Content || data?.content || '';

    if (content.length > 2000) {
      content = content.slice(0, 2000) + '...';
    }

    if (!content && !title) return '';

    return title ? `${title}\n${content}` : content;
  } catch (err) {
    logger.warn({ err }, 'webFetch failed');
    return '';
  }
}

/**
 * Extract the search query from the FIRST `[SEARCH: ...]` token in text.
 *
 * Returns the query string (everything after the colon, trimmed), or null
 * if no `[SEARCH: ...]` token is found. Only the first token is extracted.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractSearchQuery(text) {
  if (!text) return null;

  const match = text.match(/\[SEARCH:\s*([^\]]+)\]/i);
  if (!match) return null;

  const query = match[1].trim();
  return query || null;
}

/**
 * Remove all `[SEARCH: ...]` occurrences from a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSearchTokens(text) {
  if (!text) return text || '';
  return text
    .replace(/\[SEARCH:\s*[^\]]*\]/gi, '')
    .replace(/ +/g, ' ')
    .trim();
}
