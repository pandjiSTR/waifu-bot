// Tests for src/pipeline.js — pure logic (extractText, shouldProcess,
// extractMemoryTokens, stripMemoryTokens) plus offline-processLLM integration
// via injected ctx.llm.chat and mock Redis. No real WhatsApp / Redis / Ollama.
import { test, after } from 'node:test';
import assert from 'node:assert';

// Default module: no BLACKLIST / WHITELIST env set.
const pipeline = await import('../src/pipeline.js');
const { stopSweeper } = pipeline;
const media = await import('../src/media.js');

function makeCtx(overrides = {}) {
  return {
    jid: '6281234567890@s.whatsapp.net',
    isGroup: false,
    sender: '6281234567890@s.whatsapp.net',
    message: { key: { remoteJid: '6281234567890@s.whatsapp.net' } },
    sock: { user: { id: '6285000000000@s.whatsapp.net' } },
    redis: null,
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

// ───────────────────────── extractText ─────────────────────────

test('extractText reads conversation text', () => {
  const m = { message: { conversation: 'halo ara' } };
  assert.strictEqual(pipeline.extractText(m), 'halo ara');
});

test('extractText reads extendedTextMessage text', () => {
  const m = { message: { extendedTextMessage: { text: 'tes' } } };
  assert.strictEqual(pipeline.extractText(m), 'tes');
});

test('extractText reads image caption', () => {
  const m = { message: { imageMessage: { caption: 'ini foto' } } };
  assert.strictEqual(pipeline.extractText(m), 'ini foto');
});

test('extractText strips null bytes and trims', () => {
  const m = { message: { conversation: '  hai \u0000  ' } };
  assert.strictEqual(pipeline.extractText(m), 'hai');
});

test('extractText returns null for non-text messages', () => {
  const m = { message: { imageMessage: {} } };
  assert.strictEqual(pipeline.extractText(m), null);
});

// T2: 2000-char input cap
test('extractText truncates input to 2000 characters', () => {
  const long = 'x'.repeat(3000);
  const m = { message: { conversation: long } };
  const result = pipeline.extractText(m);
  assert.strictEqual(result.length, 2000);
  assert.strictEqual(result, 'x'.repeat(2000));
});

// ───────────────────────── shouldProcess ─────────────────────────

test('shouldProcess rejects self/echo messages', async () => {
  const ctx = makeCtx({ message: { key: { fromMe: true, remoteJid: 'x' } } });
  assert.strictEqual(await pipeline.shouldProcess('halo', ctx), false);
});

test('shouldProcess rejects duplicate message ids', async () => {
  const ctx = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await pipeline.shouldProcess('halo', ctx), true);
  const ctx2 = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await pipeline.shouldProcess('halo', ctx2), false);
});

test('shouldProcess always replies in private chat', async () => {
  const ctx = makeCtx();
  assert.strictEqual(await pipeline.shouldProcess('apa kabar?', ctx), true);
});

test('shouldProcess rejects group messages without mention/command', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: { extendedTextMessage: { text: 'hai semua' } },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('hai semua', ctx), false);
});

test('shouldProcess allows group message that mentions the bot', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: '@6285000000000 ara',
          contextInfo: { mentionedJid: ['6285000000000@s.whatsapp.net'] },
        },
      },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('@6285000000000 ara', ctx), true);
});

test('shouldProcess allows group message containing the command prefix', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: { extendedTextMessage: { text: 'ara ceritakan jokes' } },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('ara ceritakan jokes', ctx), true);
});

test('shouldProcess responds to a group reply quoting the bot (no "ara" text)', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    botJid: '6285000000000@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'siap',
          contextInfo: {
            participant: '6285000000000@s.whatsapp.net',
            quotedMessage: { conversation: 'hai' },
          },
        },
      },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('siap', ctx), true);
});

test('shouldProcess ignores a group reply quoting another user', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    botJid: '6285000000000@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'iya dong',
          contextInfo: {
            participant: '6289999999999@s.whatsapp.net',
            quotedMessage: { conversation: 'ayo' },
          },
        },
      },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('iya dong', ctx), false);
});

test('shouldProcess responds to a group reply quoting a tracked bot message (stanzaId)', async () => {
  pipeline.trackBotMessage('bot-msg-xyz');
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'wah bener',
          contextInfo: {
            stanzaId: 'bot-msg-xyz',
            quotedMessage: { conversation: 'halo' },
          },
        },
      },
    },
  });
  // No "ara" text, no @mention, no participant match — but the quoted stanzaId
  // is a message the bot actually sent, so it must respond.
  assert.strictEqual(await pipeline.shouldProcess('wah bener', ctx), true);
});

test('shouldProcess ignores a group reply whose stanzaId is not a bot message', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'oke',
          contextInfo: {
            stanzaId: 'someone-else-msg',
            quotedMessage: { conversation: 'halo' },
          },
        },
      },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('oke', ctx), false);
});

test('shouldProcess matches bot JID across LID/device-suffix formats', async () => {
  const ctx = makeCtx({
    isGroup: true,
    jid: '120363012345678@g.us',
    sender: '6281234567890@s.whatsapp.net',
    botJid: '6285000000000:0@s.whatsapp.net',
    message: {
      key: { remoteJid: '120363012345678@g.us', participant: '6281234567890@s.whatsapp.net' },
      message: {
        extendedTextMessage: {
          text: 'oke',
          contextInfo: {
            participant: '6285000000000@s.whatsapp.net',
            quotedMessage: { conversation: 'halo' },
          },
        },
      },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('oke', ctx), true);
});


test('shouldProcess ignores sticker media (no media handling yet)', async () => {
  const ctx = makeCtx({
    message: {
      key: { remoteJid: '6281234567890@s.whatsapp.net' },
      message: { stickerMessage: {} },
    },
  });
  assert.strictEqual(await pipeline.shouldProcess('caption', ctx), false);
});

test('shouldProcess rejects owner-only commands (ara fresh / ara status)', async () => {
  const ctx = makeCtx({
    sender: '6285000000000@s.whatsapp.net',
    message: {
      key: { remoteJid: '6285000000000@s.whatsapp.net' },
      message: { extendedTextMessage: { text: 'ara fresh' } },
    },
  });
  process.env.OWNER_NUMBER = '6285000000000';
  const ownerPipe = await import('../src/pipeline.js?owner=1');
  assert.strictEqual(await ownerPipe.shouldProcess('ara fresh', ctx), false);
  assert.strictEqual(await ownerPipe.shouldProcess('ara status', ctx), false);
});

// ───────────────────────── blacklist / whitelist ─────────────────────────

test('shouldProcess rejects blacklisted senders', async () => {
  const p = await import('../src/pipeline.js?bl=1');
  p.setBlacklist(['6281111111111@s.whatsapp.net']);
  const ctx = makeCtx({ sender: '6281111111111@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', ctx), false);
  const ok = makeCtx({ sender: '6282222222222@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', ok), true);
});

test('shouldProcess enforces whitelist (owner + listed only)', async () => {
  process.env.WHITELIST = '6282222222222@s.whatsapp.net';
  process.env.OWNER_NUMBER = '6289999999999@s.whatsapp.net';
  const p = await import('../src/pipeline.js?wl=1');
  const blocked = makeCtx({ sender: '6283333333333@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const listed = makeCtx({ sender: '6282222222222@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', listed), true);
  const owner = makeCtx({ sender: '6289999999999@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', owner), true);
});

// ───────────────────────── processLLM ─────────────────────────
// Fully offline: ctx.llm.chat and ctx.sock.sendMessage are mocked.
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
    jid: 'breaker@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        llmChatCalled = true; // must NOT be called
        return 'should-not-be-sent';
      },
      summarize: async () => 'sum',
    },
    sock: {
      sendMessage: async (jid, { text }) => {
        sentText = text;
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
    jid: 'cbtoggle@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        llmChatCalled = true;
        return 'should-not-be-sent';
      },
    },
    sock: {
      sendMessage: async (jid, { text }) => {
        sentText = text;
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
    jid: 'cbtoggle2@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    llm: {
      chat: async (msgs) => {
        llmChatCalled = true;
        calledMsgs = msgs;
        return 'real-llm-reply';
      },
    },
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'jabber@s.whatsapp.net',
    from: 'x',
    isGroup: false,
    sender: 'x',
    pushName: 'T',
    redis: null, // exercise in-memory context fallback
    llm: {
      chat: async (msgs) => {
        chatCalled = true;
        lastMsgs = msgs;
        return 'reply-text';
      },
      summarize: async () => 'sum',
    },
    sock: {
      sendMessage: async (jid, { text }) => {
        ctx._sent = text;
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

// ───────────────────────── badword (Fase 8 leftover, §5.7) ─────────────────────────

test('shouldProcess flags badword but does NOT block the message', async () => {
  const ctx = makeCtx();
  const ok = await pipeline.shouldProcess('kau anjing!', ctx);
  assert.strictEqual(ok, true, 'badword must not block (PRD §5.7)');
  assert.strictEqual(ctx.badword, true, 'ctx.badword should be flagged');
});

test('shouldProcess leaves ctx.badword unset for clean text', async () => {
  const ctx = makeCtx();
  await pipeline.shouldProcess('halo ara, apa kabar?', ctx);
  assert.strictEqual(ctx.badword, undefined);
});

test('processLLM appends sarcastic-tone instruction when ctx.badword is set', async () => {
  let lastMsgs = null;
  const ctx = {
    jid: 'badword@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    badword: true, // injected flag (normally set by shouldProcess)
    llm: {
      chat: async (msgs) => {
        lastMsgs = msgs;
        return 'reply-text';
      },
    },
    sock: { sendMessage: async () => {} },
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
    jid: 'media@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    mediaContext: '[GAMBAR] seekor kucing oranye', // injected (no real socket)
    llm: {
      chat: async (msgs) => {
        lastMsgs = msgs;
        return 'reply-text';
      },
    },
    sock: { sendMessage: async () => {} },
  };

  await pipeline.processLLM('ini foto apa?', ctx);

  const lastUser = [...lastMsgs].reverse().find((m) => m.role === 'user');
  assert.ok(lastUser, 'a user message must exist');
  assert.ok(lastUser.content.startsWith('[GAMBAR] seekor kucing oranye'));
  assert.match(lastUser.content, /ini foto apa\?/);
});

// ───────────────────────── sticker maker (Fase 6, §5.3) ─────────────────────────

test('processLLM intercepts sticker requests and does NOT call the LLM', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  let llmChatCalled = false;
  let sentSticker = null;

  media.__setDownloadForTest(async () => png);

  const ctx = {
    jid: 'stick@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    sock: {
      user: { id: '6285000000000@s.whatsapp.net' },
      sendMessage: async (jid, { sticker }) => {
        sentSticker = sticker;
      },
    },
    llm: {
      chat: async () => {
        llmChatCalled = true; // must NOT be called for a sticker request
        return 'should-not-be-sent';
      },
    },
    message: {
      key: { remoteJid: 'stick@s.whatsapp.net' },
      message: { imageMessage: { caption: 'buat stiker dong' } },
    },
  };

  await pipeline.processLLM('buat stiker dong', ctx);

  assert.strictEqual(llmChatCalled, false, 'LLM must be skipped for sticker requests');
  assert.ok(sentSticker, 'a sticker buffer should be sent');
  assert.strictEqual(sentSticker.slice(0, 4).toString('latin1'), 'RIFF');
  assert.strictEqual(sentSticker.slice(8, 12).toString('latin1'), 'WEBP');
});

// ───────────────────────── search loop (Fase 6, §5.6 / §6.2) ─────────────────────────

test('processLLM search loop: injects results and strips [SEARCH] token from final reply', async () => {
  let callCount = 0;
  let searchCalledWith = null;

  const ctx = {
    jid: 'search@s.whatsapp.net',
    isGroup: false,
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
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'nosearch@s.whatsapp.net',
    isGroup: false,
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
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'noresults@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    search: async () => '', // empty results
    llm: {
      chat: async () => {
        callCount++;
        return '[SEARCH: something]';
      },
    },
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'webfetch@s.whatsapp.net',
    isGroup: false,
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
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'webfetch2@s.whatsapp.net',
    isGroup: false,
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
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
  };

  const p = await import('../src/pipeline.js?wf2=1');
  await p.processLLM('test', ctx);
  assert.strictEqual(callCount, 2);
});

test('processLLM search loop: handles ctx.fetch throwing gracefully', async () => {
  let callCount = 0;

  const ctx = {
    jid: 'webfetch3@s.whatsapp.net',
    isGroup: false,
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
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
  };

  const p = await import('../src/pipeline.js?wf3=1');
  await p.processLLM('test', ctx);
  assert.strictEqual(callCount, 2);
});

test('processLLM search loop: max 2 iterations', async () => {
  let callCount = 0;

  const ctx = {
    jid: 'maxiter@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    search: async () => 'Some results.',
    llm: {
      chat: async () => {
        callCount++;
        return '[SEARCH: another query]';
      },
    },
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
  };

  const p = await import('../src/pipeline.js?sl4=1');
  await p.processLLM('cari', ctx);

  // 1 (initial) + 2 (search follow-ups) = 3 total calls max.
  assert.strictEqual(callCount, 3);

  // Even after exhausting iterations, [SEARCH: token is stripped.
  assert.doesNotMatch(ctx._sent || '', /\[SEARCH:/i);
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
  const p = await import('../src/pipeline.js?loadbl=1');
  await p.loadBlacklist(fakeRedis);
  const blocked = makeCtx({ sender: '123@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ sender: '789@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

test('setBlacklist updates in-memory list', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const p = await import('../src/pipeline.js?sbl=1');
  p.setBlacklist(['111', '222']);
  const blocked = makeCtx({ sender: '111@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ sender: '333@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

test('setBlacklist normalizes numbers', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const p = await import('../src/pipeline.js?sbln=1');
  p.setBlacklist(['628xxx']);
  const blocked = makeCtx({ sender: '628@s.whatsapp.net' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ sender: '620@s.whatsapp.net' });
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
    jid: 'memint@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: mockRedis,
    llm: {
      chat: async () => {
        callCount++;
        return 'Iya, dia suka kucing banget. [REMEMBER: suka kucing] [MOOD: seneng]';
      },
    },
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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
    jid: 'memnull@s.whatsapp.net',
    isGroup: false,
    sender: 'x',
    redis: null,
    llm: {
      chat: async () => {
        callCount++;
        return 'Cool. [REMEMBER: suka kopi] [MOOD: cool]';
      },
    },
    sock: { sendMessage: async (jid, { text }) => { ctx._sent = text; } },
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

