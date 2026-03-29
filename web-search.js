import log from './logger.js';

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || 'BSAfyrTAKB7j64CFcDUWx_dFmk7vEL5';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const TIMEOUT_MS = 8000;

/**
 * Search the web via Brave Search API.
 * @param {string} query - Search query
 * @param {number} count - Number of results (default 5)
 * @returns {Promise<{results: Array<{title: string, url: string, description: string}>, query: string}>}
 */
export async function searchWeb(query, count = 5) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { results: [], query: query || '' };
  }

  try {
    const params = new URLSearchParams({ q: query.trim(), count: String(count) });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${BRAVE_ENDPOINT}?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      log.info('web_search_error', { status: res.status, query });
      return { results: [], query };
    }

    const data = await res.json();
    const results = (data.web?.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      description: r.description || '',
    }));

    log.info('web_search_success', { query, resultCount: results.length });
    return { results, query };
  } catch (err) {
    if (err.name === 'AbortError') {
      log.info('web_search_timeout', { query });
    } else {
      log.info('web_search_error', { query, error: err.message });
    }
    return { results: [], query };
  }
}
