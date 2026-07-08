// Tests for src/search.js — pure logic only (webSearch, webFetch, extractSearchQuery, stripSearchTokens).
// No real Ollama connections. All fetch calls are mocked.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// ───────────────────────── webSearch ─────────────────────────

test('webSearch returns formatted results from Results (capital R)', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      Results: [
        { Title: 'Cuaca Jakarta', URL: 'https://example.com/1', Content: 'Hari ini cerah berawan dengan suhu 32°C.' },
        { Title: 'BMKG', URL: 'https://example.com/2', Content: 'Prakiraan cuaca wilayah DKI Jakarta.' },
      ],
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  process.env.OLLAMA_API_KEY = 'test-key';
  const mod = await import('../src/search.js?ws=1');

  const result = await mod.webSearch('cuaca jakarta', { maxResults: 2 });

  assert.ok(result.includes('1. Cuaca Jakarta'));
  assert.ok(result.includes('https://example.com/1'));
  assert.ok(result.includes('Hari ini cerah'));
  assert.ok(result.includes('2. BMKG'));
  assert.strictEqual(globalThis.fetch.mock.calls.length, 1);

  // Verify the request body
  const callArgs = globalThis.fetch.mock.calls[0].arguments;
  assert.ok(callArgs[0].includes('/api/web_search'));
  assert.strictEqual(callArgs[1].method, 'POST');
  assert.strictEqual(callArgs[1].headers['Authorization'], 'Bearer test-key');
  const body = JSON.parse(callArgs[1].body);
  assert.strictEqual(body.query, 'cuaca jakarta');
  assert.strictEqual(body.max_results, 2);

  globalThis.fetch = originalFetch;
});

test('webSearch handles lowercase results array', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      results: [
        { title: 'News', url: 'https://news.example.com', content: 'Some content here.' },
      ],
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?ws2=1');
  const result = await mod.webSearch('test', { maxResults: 1 });

  assert.ok(result.includes('1. News'));
  assert.ok(result.includes('https://news.example.com'));

  globalThis.fetch = originalFetch;
});

test('webSearch returns empty string on non-200 response', async () => {
  const fakeResponse = {
    ok: false,
    status: 500,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?ws3=1');
  const result = await mod.webSearch('test');

  assert.strictEqual(result, '');

  globalThis.fetch = originalFetch;
});

test('webSearch returns empty string on empty results', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ Results: [] }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?ws4=1');
  const result = await mod.webSearch('test');

  assert.strictEqual(result, '');

  globalThis.fetch = originalFetch;
});

test('webSearch returns empty string when no API key', async () => {
  delete process.env.OLLAMA_API_KEY;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(() => { throw new Error('should not be called'); });

  const mod = await import('../src/search.js?ws5=1');
  const result = await mod.webSearch('test');

  assert.strictEqual(result, '');
  assert.strictEqual(globalThis.fetch.mock.calls.length, 0);

  globalThis.fetch = originalFetch;
  process.env.OLLAMA_API_KEY = 'test-key'; // restore for other tests
});

test('webSearch returns empty string on fetch error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => { throw new Error('network error'); });

  const mod = await import('../src/search.js?ws6=1');
  const result = await mod.webSearch('test');

  assert.strictEqual(result, '');

  globalThis.fetch = originalFetch;
});

test('webSearch returns empty string for empty query', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(() => { throw new Error('should not be called'); });

  const mod = await import('../src/search.js?ws7=1');
  assert.strictEqual(await mod.webSearch(''), '');
  assert.strictEqual(await mod.webSearch(null), '');
  assert.strictEqual(await mod.webSearch('   '), '');

  globalThis.fetch = originalFetch;
});

// ───────────────────────── webFetch ─────────────────────────

test('webFetch returns page content', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      Title: 'Example Page',
      Content: 'This is the full text content of the page. '.repeat(50),
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?wf1=1');
  const result = await mod.webFetch('https://example.com');

  // Should be truncated to ~2000 chars
  assert.ok(result.startsWith('Example Page\nThis is the full text'));
  assert.ok(result.endsWith('...'));
  assert.ok(result.length <= 2100);

  globalThis.fetch = originalFetch;
});

test('webFetch returns empty string on error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => { throw new Error('fetch error'); });

  const mod = await import('../src/search.js?wf2=1');
  const result = await mod.webFetch('https://example.com');

  assert.strictEqual(result, '');

  globalThis.fetch = originalFetch;
});

test('webFetch returns empty string for invalid URL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(() => { throw new Error('should not be called'); });

  const mod = await import('../src/search.js?wf3=1');
  assert.strictEqual(await mod.webFetch(''), '');
  assert.strictEqual(await mod.webFetch(null), '');

  globalThis.fetch = originalFetch;
});

// ───────────────────────── extractSearchQuery ─────────────────────────

test('extractSearchQuery parses [SEARCH: query] token', async () => {
  const mod = await import('../src/search.js?esq1=1');

  assert.strictEqual(mod.extractSearchQuery('[SEARCH: cuaca hari ini]'), 'cuaca hari ini');
  assert.strictEqual(mod.extractSearchQuery('Halo [SEARCH: harga bitcoin] test'), 'harga bitcoin');
  assert.strictEqual(mod.extractSearchQuery('[SEARCH:   dengan spasi  ]'), 'dengan spasi');
});

test('extractSearchQuery returns null when no token', async () => {
  const mod = await import('../src/search.js?esq2=1');

  assert.strictEqual(mod.extractSearchQuery('halo apa kabar'), null);
  assert.strictEqual(mod.extractSearchQuery(''), null);
  assert.strictEqual(mod.extractSearchQuery(null), null);
});

test('extractSearchQuery only returns the first token', async () => {
  const mod = await import('../src/search.js?esq3=1');

  assert.strictEqual(
    mod.extractSearchQuery('[SEARCH: first] dan [SEARCH: second]'),
    'first',
  );
});

// ───────────────────────── stripSearchTokens ─────────────────────────

// T6: webFetch with mock returning content
test('webFetch returns content when fetch succeeds', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({
      Title: 'Mock Page',
      Content: 'This is mocked page content for testing webFetch augmentation.',
    }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?wft6=1');
  const result = await mod.webFetch('https://example.com/test');

  assert.ok(result.includes('Mock Page'));
  assert.ok(result.includes('mocked page content'));

  globalThis.fetch = originalFetch;
});

test('webFetch returns empty string when fetch returns empty content', async () => {
  const fakeResponse = {
    ok: true,
    json: async () => ({ Title: '', Content: '' }),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => fakeResponse);

  const mod = await import('../src/search.js?wft6e=1');
  const result = await mod.webFetch('https://example.com/empty');

  assert.strictEqual(result, '');

  globalThis.fetch = originalFetch;
});

test('stripSearchTokens removes all [SEARCH: ...] occurrences', async () => {
  const mod = await import('../src/search.js?sst1=1');

  assert.strictEqual(
    mod.stripSearchTokens('[SEARCH: cuaca] Hari ini cerah.'),
    'Hari ini cerah.',
  );
  assert.strictEqual(
    mod.stripSearchTokens('Apa [SEARCH: harga] dan [SEARCH: bitcoin]?'),
    'Apa dan ?',
  );
  assert.strictEqual(mod.stripSearchTokens('Tidak ada token.'), 'Tidak ada token.');
  assert.strictEqual(mod.stripSearchTokens(''), '');
  assert.strictEqual(mod.stripSearchTokens(null), '');
});
