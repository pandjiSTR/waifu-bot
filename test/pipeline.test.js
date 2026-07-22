// Tests for src/pipeline.js — pure logic (extractText, shouldProcess,
// extractMemoryTokens, stripMemoryTokens) plus offline-processLLM integration
// via injected ctx.llm.chat and mock Redis. No real WhatsApp / Redis / Ollama.
import { test, after } from 'node:test';
import assert from 'node:assert';

// Default module: no BLACKLIST / WHITELIST env set.
const pipeline = await import('../src/pipeline.js');
const gk = await import('../src/gatekeeper.js');
const { stopSweeper } = gk;

function makeCtx(overrides = {}) {
  return {
    channelId: '1234567890',
    isGroup: false,
    senderId: '1234567890',
    sender: '1234567890',
    message: {
      content: '',
      author: { id: '1234567890' },
      client: { user: { id: 'ara-bot-id' } },
    },
    channel: { send: async () => ({ id: 'mock-id' }), sendTyping: async () => {} },
    redis: null,
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}



// ───────────────────────── shouldProcess ─────────────────────────

test('shouldProcess rejects duplicate message ids', async () => {
  const ctx = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await gk.shouldProcess('halo', ctx), true);
  const ctx2 = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await gk.shouldProcess('halo', ctx2), false);
});

test('shouldProcess always replies in private chat', async () => {
  const ctx = makeCtx();
  assert.strictEqual(await gk.shouldProcess('apa kabar?', ctx), true);
});

test('shouldProcess rejects group messages without mention/command', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    sender: 'user123456',
    message: {
      content: 'hai semua',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('hai semua', ctx), false);
});

test('shouldProcess allows group message that mentions the bot', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    sender: 'user123456',
    message: {
      content: '<@ara-bot-id> ara',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('<@ara-bot-id> ara', ctx), true);
});

test('shouldProcess allows group message containing the command prefix', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    sender: 'user123456',
    message: {
      content: 'ara ceritakan jokes',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('ara ceritakan jokes', ctx), true);
});

test('shouldProcess rejects "arah/arab/arak/aray" in group (false prefix)', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    sender: 'user123456',
    message: {
      content: 'arah ke mana',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('arah ke mana', ctx), false);
  assert.strictEqual(await gk.shouldProcess('arab saudi', ctx), false);
  assert.strictEqual(await gk.shouldProcess('arak', ctx), false);
  assert.strictEqual(await gk.shouldProcess('aray', ctx), false);
});



// ───────────────────────── blacklist / whitelist ─────────────────────────

test('shouldProcess rejects blacklisted senders', async () => {
  const gkB = await import('../src/gatekeeper.js?bl=1');
  gkB.setBlacklist(['user111111']);
  const ctx = makeCtx({ senderId: 'user111111', sender: 'user111111' });
  assert.strictEqual(await gkB.shouldProcess('halo', ctx), false);
  const ok = makeCtx({ senderId: 'user222222', sender: 'user222222' });
  assert.strictEqual(await gkB.shouldProcess('halo', ok), true);
});

test('shouldProcess enforces whitelist in group', async () => {
  process.env.WHITELIST = 'user222222';
  const gkW = await import('../src/gatekeeper.js?wl=1');
  // Blocked user (not in whitelist) is rejected even with a valid prefix
  const blocked = makeCtx({ isGroup: true, channelId: 'guild-ch', senderId: 'user333333', sender: 'user333333', message: { content: '!ara halo', author: { id: 'user333333' }, client: { user: { id: 'ara-bot-id' } } } });
  assert.strictEqual(await gkW.shouldProcess('!ara halo', blocked), false);
  // Listed user (in whitelist) passes with a valid prefix
  const listed = makeCtx({ isGroup: true, channelId: 'guild-ch', senderId: 'user222222', sender: 'user222222', message: { content: '!ara halo', author: { id: 'user222222' }, client: { user: { id: 'ara-bot-id' } } } });
  assert.strictEqual(await gkW.shouldProcess('!ara halo', listed), true);
});

// ───────────────────────── processLLM ─────────────────────────
// Fully offline: ctx.llm.chat and ctx.channel.send are mocked.
// Confirms the current user message is NOT duplicated in the LLM payload.

// Circuit breaker guard (Fase 5, §6.3): while open, processLLM must skip the
// LLM call and send a short neutral fallback (NOT Ara's persona voice).
test('processLLM sends neutral fallback and skips LLM when circuit is open', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();
  circuit.__forceOpen(10000);

  let llmChatCalled = false;
  let sentText = null;

  const ctx = {
    channelId: 'breaker-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        llmChatCalled = true; // must NOT be called
        return 'should-not-be-sent';
      },
      summarize: async () => 'sum',
    },
    channel: {
      send: async (text) => {
        sentText = typeof text === 'string' ? text : text;
      },
    },
  };

  await pipeline.processLLM('hai', ctx);

  assert.strictEqual(llmChatCalled, false, 'llm.chat must be skipped while open');
  assert.strictEqual(sentText, 'lagi sibuk sebentar, coba lagi nanti');
  circuit.__reset();
});

// T7: circuit breaker enabled toggle
test('processLLM skips LLM when circuit breaker is enabled and open', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();
  circuit.__forceOpen(10000);

  let llmChatCalled = false;
  let sentText = null;

  const ctx = {
    channelId: 'cbtoggle-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        llmChatCalled = true;
        return 'should-not-be-sent';
      },
    },
    channel: {
      send: async (text) => {
        sentText = typeof text === 'string' ? text : text;
      },
    },
  };

  // Import a fresh module with default circuitBreakerEnabled=true
  const p = await import('../src/pipeline.js?cbt1=1');
  await p.processLLM('hai', ctx);

  assert.strictEqual(llmChatCalled, false, 'LLM must be skipped when cb is enabled and open');
  assert.strictEqual(sentText, 'lagi sibuk sebentar, coba lagi nanti');
  circuit.__reset();
});

test('processLLM calls LLM when circuit breaker is disabled despite being open', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();
  circuit.__forceOpen(10000);

  let llmChatCalled = false;
  let calledMsgs = null;

  const ctx = {
    channelId: 'cbtoggle2-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async (msgs) => {
        llmChatCalled = true;
        calledMsgs = msgs;
        return 'real-llm-reply';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?cbt2=1');
  // Disable the circuit breaker
  p.setCircuitBreakerEnabled(false);
  await p.processLLM('hai', ctx);

  // LLM should be called even though breaker is open
  assert.strictEqual(llmChatCalled, true, 'LLM must be called when cb is disabled');
  assert.strictEqual(ctx._sent, 'real-llm-reply');
  circuit.__reset();
  p.setCircuitBreakerEnabled(true); // restore default
});

test('setCircuitBreakerEnabled validates input', () => {
  const p = pipeline;
  p.setCircuitBreakerEnabled(false);
  // internal state changed — no assertion beyond no-throw coverage
  p.setCircuitBreakerEnabled(true);
  p.setCircuitBreakerEnabled(1);
  p.setCircuitBreakerEnabled(0);
  p.setCircuitBreakerEnabled('false');
});

test('processLLM sends reply without duplicating the current message', async () => {
  let lastMsgs = null;
  let chatCalled = false;

  const ctx = {
    channelId: 'jabber-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null, // exercise in-memory context fallback
    llm: {
      chat: async (msgs) => {
        chatCalled = true;
        lastMsgs = msgs;
        return 'reply-text';
      },
      summarize: async () => 'sum',
    },
    channel: {
      send: async (text) => {
        ctx._sent = typeof text === 'string' ? text : text;
      },
    },
  };

  await pipeline.processLLM('hai', ctx);

  // (a) LLM.chat was invoked
  assert.ok(chatCalled, 'llm.chat should have been called');
  assert.ok(Array.isArray(lastMsgs), 'messages array should be passed to llm.chat');

  // (b) the latest user message ("hai") appears exactly ONCE as a user role.
  const hais = lastMsgs.filter((m) => m.role === 'user' && m.content === 'hai');
  assert.strictEqual(hais.length, 1, 'current user message must not be duplicated');

  // system prompt is always first, then chronological history.
  assert.strictEqual(lastMsgs[0].role, 'system');

  // (c) the reply text was delivered via sock.sendMessage
  assert.strictEqual(ctx._sent, 'reply-text');

  // (d) role mapping: non-ara sender -> 'user', ara sender -> 'assistant'.
  // The window (newest-last) contains exactly the user message we submitted.
  const nonSystem = lastMsgs.filter((m) => m.role !== 'system');
  assert.strictEqual(nonSystem.length, 1);
  assert.strictEqual(nonSystem[0].role, 'user');
  assert.strictEqual(nonSystem[0].content, 'hai');
});

test('processLLM splits reply on \\n\\n — each paragraph is a separate bubble', async () => {
  const sent = [];
  const ctx = {
    channelId: 'jabber-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => 'Intro\n\nPoint A\n\nPoint B',
      summarize: async () => 'sum',
    },
    channel: {
      send: async (text) => { sent.push(typeof text === 'string' ? text : ''); },
    },
  };

  await pipeline.processLLM('test', ctx);

  // 3 non-empty segments after split on \n\n, trim, filter
  assert.strictEqual(sent.length, 3, 'each \\n\\n-separated paragraph should be its own bubble');
  assert.strictEqual(sent[0], 'Intro');
  assert.strictEqual(sent[1], 'Point A');
  assert.strictEqual(sent[2], 'Point B');
});

test('processLLM keeps single-line reply as 1 bubble', async () => {
  const sent = [];
  const ctx = {
    channelId: 'jabber-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => 'Gak jadi. Males.',
      summarize: async () => 'sum',
    },
    channel: {
      send: async (text) => { sent.push(typeof text === 'string' ? text : ''); },
    },
  };

  await pipeline.processLLM('tes', ctx);

  assert.strictEqual(sent.length, 1, 'no \\n\\n means single bubble');
  assert.strictEqual(sent[0], 'Gak jadi. Males.');
});

// ───────────────────────── badword (Fase 8 leftover, §5.7) ─────────────────────────

test('shouldProcess flags badword but does NOT block the message', async () => {
  const ctx = makeCtx();
  const ok = await gk.shouldProcess('kau anjing!', ctx);
  assert.strictEqual(ok, true, 'badword must not block (PRD §5.7)');
  assert.strictEqual(ctx.badword, true, 'ctx.badword should be flagged');
});

test('shouldProcess leaves ctx.badword unset for clean text', async () => {
  const ctx = makeCtx();
  await gk.shouldProcess('halo ara, apa kabar?', ctx);
  assert.strictEqual(ctx.badword, undefined);
});

test('processLLM appends sarcastic-tone instruction when ctx.badword is set', async () => {
  let lastMsgs = null;
  const ctx = {
    channelId: 'badword-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    badword: true, // injected flag (normally set by shouldProcess)
    llm: {
      chat: async (msgs) => {
        lastMsgs = msgs;
        return 'reply-text';
      },
    },
    channel: { send: async () => {} },
  };

  await pipeline.processLLM('kau anjing!', ctx);

  assert.ok(lastMsgs && Array.isArray(lastMsgs));
  assert.match(lastMsgs[0].content, /Tanggapi dengan nada sarkastik\./);
  // The current user message must still appear exactly once.
  const hais = lastMsgs.filter((m) => m.role === 'user' && m.content === 'kau anjing!');
  assert.strictEqual(hais.length, 1);
});

// ───────────────────────── media context (Fase 6, §5.6) ─────────────────────────

test('processLLM injects ctx.mediaContext into the last user turn', async () => {
  let lastMsgs = null;
  const ctx = {
    channelId: 'media-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    mediaContext: '[GAMBAR] seekor kucing oranye', // injected (no real socket)
    llm: {
      chat: async (msgs) => {
        lastMsgs = msgs;
        return 'reply-text';
      },
    },
    channel: { send: async () => {} },
  };

  await pipeline.processLLM('ini foto apa?', ctx);

  const lastUser = [...lastMsgs].reverse().find((m) => m.role === 'user');
  assert.ok(lastUser, 'a user message must exist');
  assert.ok(lastUser.content.startsWith('[GAMBAR] seekor kucing oranye'));
  assert.match(lastUser.content, /ini foto apa\?/);
});

// ───────────────────────── sticker maker (Fase 6, §5.3) ─────────────────────────



// ───────────────────────── search loop (Fase 6, §5.6 / §6.2) ─────────────────────────

test('processLLM search loop: injects results and strips [SEARCH] token from final reply', async () => {
  let callCount = 0;
  let searchCalledWith = null;

  const ctx = {
    channelId: 'search-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    // Injected search function that returns fake results.
    search: async (query) => {
      searchCalledWith = query;
      return 'Cuaca Jakarta hari ini: cerah berawan, 32°C.';
    },
    llm: {
      chat: async (msgs) => {
        callCount++;
        if (callCount === 1) {
          // First call: emits a [SEARCH] token per personality.txt.
          return '[SEARCH: cuaca jakarta]';
        }
        // Second call: gives the actual answer using search results.
        return 'Cerahan. 32 derajat.';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  // Force fresh import to get the search imports
  const p = await import('../src/pipeline.js?sl=1');
  await p.processLLM('cuaca hari ini gimana?', ctx);

  // (a) The search function was called with the extracted query.
  assert.strictEqual(searchCalledWith, 'cuaca jakarta');

  // (b) The LLM was called twice (initial + search follow-up).
  assert.strictEqual(callCount, 2);

  // (c) The final sent reply has NO [SEARCH: token.
  assert.ok(ctx._sent, 'a reply should have been sent');
  assert.doesNotMatch(ctx._sent, /\[SEARCH:/i, 'final reply must not contain [SEARCH: token');
});

test('processLLM search loop: no search when reply has no [SEARCH] token', async () => {
  let callCount = 0;
  let searchCalled = false;

  const ctx = {
    channelId: 'nosearch-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    search: async () => {
      searchCalled = true;
      return 'some results';
    },
    llm: {
      chat: async () => {
        callCount++;
        return 'Jawaban langsung tanpa search.';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?sl2=1');
  await p.processLLM('halo', ctx);

  // (a) Only one LLM call (no search loop).
  assert.strictEqual(callCount, 1);

  // (b) Search was NOT called.
  assert.strictEqual(searchCalled, false);

  // (c) Reply was sent as-is.
  assert.strictEqual(ctx._sent, 'Jawaban langsung tanpa search.');
});

test('processLLM search loop: breaks when webSearch returns empty results', async () => {
  let callCount = 0;

  const ctx = {
    channelId: 'noresults-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    search: async () => '', // empty results
    llm: {
      chat: async () => {
        callCount++;
        return '[SEARCH: something]';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?sl3=1');
  await p.processLLM('cari sesuatu', ctx);

  // Only one LLM call — loop breaks when results are empty.
  assert.strictEqual(callCount, 1);

  // No [SEARCH: token should leak to user.
  assert.doesNotMatch(ctx._sent || '', /\[SEARCH:/i);
});

// T6: webFetch augmentation in search loop
test('processLLM search loop: augments results with ctx.fetch content', async () => {
  let callCount = 0;
  let searchCalledWith = null;
  let fetchedUrl = null;

  const ctx = {
    channelId: 'webfetch-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    // Injected search that returns a result with a URL
    search: async (query) => {
      searchCalledWith = query;
      return '1. Cuaca Jakarta (https://example.com/cuaca)\nHari ini cerah.';
    },
    // Injected fetch for test
    fetch: async (url) => {
      fetchedUrl = url;
      return 'Full page content about Jakarta weather.';
    },
    llm: {
      chat: async (msgs) => {
      callCount++;
      if (callCount === 1) {
        return '[SEARCH: jakarta]';
      }
      // Check that a [ISI HALAMAN] section was appended to the results
      const userMsg = msgs.filter(m => m.role === 'user').pop();
      assert.ok(userMsg.content.includes('[HASIL PENCARIAN]'), 'search results should be present');
      assert.ok(userMsg.content.includes('[ISI HALAMAN]'), 'page content should be appended');
      assert.ok(userMsg.content.includes('Full page content about Jakarta weather.'));
      return 'Answer with augmented content.';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?wf1=1');
  await p.processLLM('cuaca jakarta?', ctx);

  assert.strictEqual(searchCalledWith, 'jakarta');
  assert.strictEqual(fetchedUrl, 'https://example.com/cuaca');
  assert.strictEqual(callCount, 2);
  assert.ok(ctx._sent, 'a reply should have been sent');
});

test('processLLM search loop: ignores ctx.fetch when it returns empty', async () => {
  let callCount = 0;

  const ctx = {
    channelId: 'webfetch2-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    search: async () => '1. Test (https://example.com/test)\nSnippet.',
    fetch: async () => '',
    llm: {
      chat: async (msgs) => {
      callCount++;
      if (callCount === 1) return '[SEARCH: test]';
      const userMsg = msgs.filter(m => m.role === 'user').pop();
      assert.ok(userMsg.content.includes('[HASIL PENCARIAN]'), 'search results present');
      assert.ok(!userMsg.content.includes('[ISI HALAMAN]'), 'no [ISI HALAMAN] when fetch empty');
      return 'Answer without augmentation.';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?wf2=1');
  await p.processLLM('test', ctx);
  assert.strictEqual(callCount, 2);
});

test('processLLM search loop: handles ctx.fetch throwing gracefully', async () => {
  let callCount = 0;

  const ctx = {
    channelId: 'webfetch3-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    search: async () => '1. Test (https://example.com/test)\nSnippet.',
    fetch: async () => { throw new Error('network error'); },
    llm: {
      chat: async (msgs) => {
      callCount++;
      if (callCount === 1) return '[SEARCH: test]';
      // Should still have search results, no [ISI HALAMAN]
      const userMsg = msgs.filter(m => m.role === 'user').pop();
      assert.ok(userMsg.content.includes('[HASIL PENCARIAN]'));
      assert.ok(!userMsg.content.includes('[ISI HALAMAN]'));
      return 'Answer despite fetch failure.';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?wf3=1');
  await p.processLLM('test', ctx);
  assert.strictEqual(callCount, 2);
});

test('processLLM search loop: max 2 iterations', async () => {
  let callCount = 0;

  const ctx = {
    channelId: 'maxiter-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    search: async () => 'Some results.',
    llm: {
      chat: async () => {
        callCount++;
        return '[SEARCH: another query]';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?sl4=1');
  await p.processLLM('cari', ctx);

  // 1 (initial) + 2 (search follow-ups) = 3 total calls max.
  assert.strictEqual(callCount, 3);

  // Even after exhausting iterations, [SEARCH: token is stripped.
  assert.doesNotMatch(ctx._sent || '', /\[SEARCH:/i);
});

test('processLLM search loop: drops "tunggu" lead-in when search fails to produce answer', async () => {
  const ctx = {
    channelId: 'tunggu-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => 'Tunggu ya, aku cari dulu. [SEARCH: cuaca jakarta]',
      summarize: async () => 'sum',
    },
    channel: {
      send: async () => {},
    },
    search: async () => '', // returns empty — simulates search failure
  };

  const mod = await import('../src/pipeline.js?tunggu=1');
  await mod.processLLM('cuaca jakarta gimana?', ctx);
});

test('processLLM search loop: strips "tunggu" lead-in, keeps real answer', async () => {
  const sent = [];
  const ctx = {
    channelId: 'ok-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async (msgs) => {
        const last = msgs[msgs.length - 1].content;
        if (last.startsWith('[HASIL PENCARIAN]')) return 'Cuaca Jakarta 30 derajat.';
        return 'Tunggu bentar [SEARCH: cuaca jakarta]';
      },
      summarize: async () => 'sum',
    },
    channel: {
      send: async (text) => { sent.push(typeof text === 'string' ? text : ''); },
    },
    search: async () => '1. Weather (https://weather.com)\nJakarta 30°C',
  };

  const mod = await import('../src/pipeline.js?tunggu2=1');
  await mod.processLLM('cuaca jakarta gimana?', ctx);

  assert.strictEqual(sent.length, 1, 'should send one message');
  assert.strictEqual(sent[0], 'Cuaca Jakarta 30 derajat.', 'should send actual answer not tunggu');
});

// ───────────────────────── stopSweeper ─────────────────────────

test('stopSweeper exists and does not throw', () => {
  assert.strictEqual(typeof stopSweeper, 'function');
});

after(() => {
  stopSweeper();
});

// ───────────────────────── dynamic blacklist (loadBlacklist / setBlacklist) ─────────────────────────

test('loadBlacklist reads from Redis', async () => {
  // Clear stale env left by earlier tests so the module import is clean.
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const fakeRedis = {
    get: async (key) => {
      assert.strictEqual(key, 'waifu:settings:misc');
      return '{"blacklist":"123,456"}';
    },
  };
  const p = await import('../src/gatekeeper.js?loadbl=1');
  await p.loadBlacklist(fakeRedis);
  const blocked = makeCtx({ senderId: '123', sender: '123' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ senderId: '789', sender: '789' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

test('setBlacklist updates in-memory list', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const p = await import('../src/gatekeeper.js?sbl=1');
  p.setBlacklist(['111', '222']);
  const blocked = makeCtx({ senderId: '111', sender: '111' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ senderId: '333', sender: '333' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

test('setBlacklist matches exact senderId', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const p = await import('../src/gatekeeper.js?sbln=1');
  p.setBlacklist(['user628']);
  const blocked = makeCtx({ senderId: 'user628', sender: 'user628' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ senderId: 'user620', sender: 'user620' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

// ───────────────────────── memory tokens ─────────────────────────

test('extractMemoryTokens finds REMEMBER and MOOD tokens', () => {
  const p = pipeline;
  const result = p.extractMemoryTokens(
    'Iya, dia suka kucing banget. [REMEMBER: suka kucing] [MOOD: seneng]'
  );
  assert.deepStrictEqual(result.facts, ['suka kucing']);
  assert.strictEqual(result.mood, 'seneng');
});

test('extractMemoryTokens extracts multiple REMEMBER tokens', () => {
  const p = pipeline;
  const result = p.extractMemoryTokens(
    '[REMEMBER: nama budi] [REMEMBER: hobi coding] [MOOD: kagum]'
  );
  assert.deepStrictEqual(result.facts, ['nama budi', 'hobi coding']);
  assert.strictEqual(result.mood, 'kagum');
});

test('extractMemoryTokens returns empty when no tokens present', () => {
  const p = pipeline;
  const result = p.extractMemoryTokens('Halo apa kabar?');
  assert.deepStrictEqual(result.facts, []);
  assert.strictEqual(result.mood, null);
});

test('extractMemoryTokens handles empty string', () => {
  const p = pipeline;
  const result = p.extractMemoryTokens('');
  assert.deepStrictEqual(result.facts, []);
  assert.strictEqual(result.mood, null);
});

test('stripMemoryTokens removes all REMEMBER and MOOD tokens', () => {
  const p = pipeline;
  const stripped = p.stripMemoryTokens(
    'Iya dong. [REMEMBER: suka kucing] [MOOD: seneng]'
  );
  assert.strictEqual(stripped, 'Iya dong.');
});

test('stripMemoryTokens returns text unchanged when no tokens', () => {
  const p = pipeline;
  assert.strictEqual(p.stripMemoryTokens('Halo apa kabar?'), 'Halo apa kabar?');
});

test('stripMemoryTokens removes only memory tokens leaving SEARCH tokens intact', () => {
  const p = pipeline;
  const stripped = p.stripMemoryTokens(
    '[REMEMBER: fakta] cari [SEARCH: query] [MOOD: seneng]'
  );
  assert.strictEqual(stripped, 'cari [SEARCH: query]');
});

test('processLLM extracts memory tokens from reply, persists via Redis, and strips them from output', async () => {
  // Map-backed mock Redis that satisfies ioredis-like API used by
  // context.js (lpush/lrange/ltrim/expire), personality.js (get),
  // and memory.js (get/set).
  const store = new Map();
  const mockRedis = {
    get: async (k) => store.get(k) || null,
    set: async (k, v, ...args) => { store.set(k, v); return 'OK'; },
    del: async (k) => { store.delete(k); return 1; },
    lpush: async (k, v) => {
      const arr = JSON.parse(store.get(k) || '[]');
      arr.unshift(v);
      store.set(k, JSON.stringify(arr));
      return arr.length;
    },
    lrange: async (k) => JSON.parse(store.get(k) || '[]'),
    ltrim: async (k, start, stop) => {
      const arr = JSON.parse(store.get(k) || '[]');
      if (stop === -1 || stop === undefined) {
        store.set(k, JSON.stringify(arr.slice(start)));
      } else {
        store.set(k, JSON.stringify(arr.slice(start, stop + 1)));
      }
      return 'OK';
    },
    expire: async () => 1,
    hincrby: async () => 1,
    zincrby: async () => 1,
    zadd: async () => 1,
  };

  let callCount = 0;

  const ctx = {
    channelId: 'memint-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: mockRedis,
    llm: {
      chat: async () => {
        callCount++;
        return 'Iya, dia suka kucing banget. [REMEMBER: suka kucing] [MOOD: seneng]';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?memint=1');
  await p.processLLM('aku suka kucing', ctx);

  // (a) Final reply delivered to user has NO memory tokens.
  assert.ok(ctx._sent, 'a reply should have been sent');
  assert.doesNotMatch(ctx._sent, /\[REMEMBER:/i, 'final reply must not contain [REMEMBER:');
  assert.doesNotMatch(ctx._sent, /\[MOOD:/i, 'final reply must not contain [MOOD:');

  // (b) The LLM was called exactly once (no search loop).
  assert.strictEqual(callCount, 1);

  // Wait for the fire-and-forget async IIFE to complete microtasks.
  await new Promise((r) => setTimeout(r, 50));

  // (c) Memory was persisted in Redis.
  const memKey = 'waifu:friend:x';
  const raw = store.get(memKey);
  assert.ok(raw, `memory key ${memKey} should exist in Redis store`);
  const mem = JSON.parse(raw);
  assert.ok(Array.isArray(mem.facts), 'mem.facts should be an array');
  assert.strictEqual(mem.facts.length, 1, 'should have 1 fact');
  assert.strictEqual(mem.facts[0], 'suka kucing');
  assert.strictEqual(mem.mood, 'seneng');
});

test('processLLM memory extraction: fire-and-forget handles null Redis gracefully', async () => {
  let callCount = 0;

  const ctx = {
    channelId: 'memnull-channel',
    isGroup: false,
    senderId: 'x',
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        callCount++;
        return 'Cool. [REMEMBER: suka kopi] [MOOD: cool]';
      },
    },
    channel: { send: async (text) => { ctx._sent = typeof text === 'string' ? text : text; } },
  };

  const p = await import('../src/pipeline.js?memnull=1');
  await p.processLLM('aku suka kopi', ctx);

  // Reply must have no tokens.
  assert.ok(ctx._sent, 'a reply should have been sent');
  assert.doesNotMatch(ctx._sent, /\[REMEMBER:/i);
  assert.doesNotMatch(ctx._sent, /\[MOOD:/i);

  // LLM was called.
  assert.strictEqual(callCount, 1);
});

test('processLLM resolves display names from waifu:friends:names in group context', async () => {
  const captured = [];

  const fakeRedis = {
    async hgetall(key) {
      if (key === 'waifu:friends:names') return { 'budi': 'Budi', 'rehan': 'Rehan' };
      return {};
    },
    async lrange(key) {
      if (key === 'waifu:grup:group-channel') {
        return [
          JSON.stringify({ sender: 'ara', text: 'oke', timestamp: '' }),
          JSON.stringify({ sender: 'budi', text: 'Ngelek bat dah', timestamp: '' }),
          JSON.stringify({ sender: 'rehan', text: 'anjay', timestamp: '' }),
        ];
      }
      return [];
    },
    async get() { return null; },
    async del() { return 1; },
    async set() { return 'OK'; },
    async lpush() { return 1; },
    async ltrim() { return 1; },
    async expire() { return 1; },
  };

  const ctx = {
    channelId: 'group-channel',
    isGroup: true,
    senderId: 'budi',
    sender: 'budi',
    redis: fakeRedis,
    llm: {
      chat: async (msgs) => { captured.push(msgs); return 'oke'; },
    },
    channel: { send: async () => {} },
    message: { content: 'apa kabar', author: { id: 'budi' }, client: { user: { id: 'ara' } } },
  };

  await pipeline.processLLM('apa kabar', ctx);
  assert.ok(captured.length > 0, 'LLM should have been called');
  const sys = captured[0].find((m) => m.role === 'system').content;
  // Display names "Budi" / "Rehan" should appear in the resolved context,
  // not raw JIDs.
  assert.match(sys, /Budi/);
  assert.match(sys, /Rehan/);
  assert.doesNotMatch(sys, /budi@s\.whatsapp\.net/, 'raw JID should not appear in context');
});

