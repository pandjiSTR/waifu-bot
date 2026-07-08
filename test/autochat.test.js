// Tests for src/autochat.js — pure logic only.
// No real WhatsApp / Ollama / Redis connections.
// Uses fake redis, injected chat/sendChunks, and circuit breaker helpers.
import { test } from 'node:test';
import assert from 'node:assert';

// Fake redis for tests.
function makeFakeRedis(seed = {}) {
  const store = { ...seed };
  return {
    store,
    get: async (key) => store[key] ?? null,
    set: async (key, val) => { store[key] = String(val); },
    lrange: async () => [],
    ltrim: async () => {},
  };
}

// Helper to suppress pino output during tests.
process.env.LOG_LEVEL = 'silent';
process.env.OWNER_NUMBER = '6285000000000';

// ───────────────────────── isAutoChatEnabled / setAutoChat ─────────────────────────

test('isAutoChatEnabled returns false when redis is null', async () => {
  const mod = await import('../src/autochat.js?ac01=1');
  assert.strictEqual(await mod.isAutoChatEnabled(null), false);
});

test('isAutoChatEnabled returns true when key is "1"', async () => {
  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '1' });
  const mod = await import('../src/autochat.js?ac02=1');
  assert.strictEqual(await mod.isAutoChatEnabled(redis), true);
});

test('isAutoChatEnabled returns false when key is "0"', async () => {
  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '0' });
  const mod = await import('../src/autochat.js?ac03=1');
  assert.strictEqual(await mod.isAutoChatEnabled(redis), false);
});

test('isAutoChatEnabled returns false when key is missing', async () => {
  const redis = makeFakeRedis();
  const mod = await import('../src/autochat.js?ac04=1');
  assert.strictEqual(await mod.isAutoChatEnabled(redis), false);
});

test('setAutoChat sets key to "1" when enabled', async () => {
  const redis = makeFakeRedis();
  const mod = await import('../src/autochat.js?ac05=1');
  await mod.setAutoChat(redis, true);
  assert.strictEqual(redis.store['waifu:autochat:enabled'], '1');
});

test('setAutoChat sets key to "0" when disabled', async () => {
  const redis = makeFakeRedis();
  const mod = await import('../src/autochat.js?ac06=1');
  await mod.setAutoChat(redis, false);
  assert.strictEqual(redis.store['waifu:autochat:enabled'], '0');
});

test('setAutoChat is a no-op when redis is null', async () => {
  const mod = await import('../src/autochat.js?ac07=1');
  // Should not throw
  await mod.setAutoChat(null, true);
});

test('isAutoChatEnabled / setAutoChat roundtrip', async () => {
  const redis = makeFakeRedis();
  const mod = await import('../src/autochat.js?ac08=1');

  assert.strictEqual(await mod.isAutoChatEnabled(redis), false);
  await mod.setAutoChat(redis, true);
  assert.strictEqual(await mod.isAutoChatEnabled(redis), true);
  await mod.setAutoChat(redis, false);
  assert.strictEqual(await mod.isAutoChatEnabled(redis), false);
});

// ───────────────────────── maybeProactive ─────────────────────────

test('maybeProactive sends a message when auto-chat is enabled', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();

  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '1' });
  const origRandom = Math.random;
  Math.random = () => 0; // always pass probability gate

  let sentText = null;
  const fakeSock = {};

  const mod = await import('../src/autochat.js?mp1=1');

  await mod.maybeProactive({
    redis,
    sock: fakeSock,
    _testNow: new Date('2026-07-08T05:00:00Z'), // 12:00 WIB — within 08-22 window
    chat: async () => 'Halo beb',
    sendChunks: async (sock, jid, text) => {
      sentText = text;
    },
  });

  Math.random = origRandom;

  assert.ok(sentText, 'a proactive message should have been sent');
  assert.strictEqual(sentText, 'Halo beb');

  // The last-sent timestamp should be stored.
  assert.ok(redis.store['waifu:autochat:last'], 'last timestamp should be set');
});

test('maybeProactive sends nothing when auto-chat is disabled', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();

  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '0' });
  const origRandom = Math.random;
  Math.random = () => 0;

  let sentText = null;

  const mod = await import('../src/autochat.js?mp2=1');

  await mod.maybeProactive({
    redis,
    sock: {},
    chat: async () => 'should-not-be-called',
    sendChunks: async (sock, jid, text) => {
      sentText = text;
    },
  });

  Math.random = origRandom;

  assert.strictEqual(sentText, null, 'no message should be sent when disabled');
});

test('maybeProactive sends nothing when circuit breaker is open', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();
  circuit.__forceOpen(60000); // open for 60 seconds

  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '1' });
  const origRandom = Math.random;
  Math.random = () => 0;

  let sentText = null;

  const mod = await import('../src/autochat.js?mp3=1');

  await mod.maybeProactive({
    redis,
    sock: {},
    chat: async () => 'should-not-be-called',
    sendChunks: async (sock, jid, text) => {
      sentText = text;
    },
  });

  Math.random = origRandom;

  assert.strictEqual(sentText, null, 'no message should be sent when circuit is open');

  circuit.__reset(); // clean up for other tests
});

test('maybeProactive sends nothing when no owner is configured', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();

  // Temporarily clear OWNER_NUMBER
  const origOwner = process.env.OWNER_NUMBER;
  delete process.env.OWNER_NUMBER;

  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '1' });
  const origRandom = Math.random;
  Math.random = () => 0;

  let sentText = null;

  const mod = await import('../src/autochat.js?mp4=1');

  await mod.maybeProactive({
    redis,
    sock: {},
    chat: async () => 'should-not-be-called',
    sendChunks: async (sock, jid, text) => {
      sentText = text;
    },
  });

  Math.random = origRandom;
  process.env.OWNER_NUMBER = origOwner;

  assert.strictEqual(sentText, null, 'no message without owner number');
});

// ───────────────────────── startAutoChat ─────────────────────────

test('startAutoChat returns a stop function', async () => {
  const circuit = await import('../src/circuit.js');
  circuit.__reset();

  const redis = makeFakeRedis({ 'waifu:autochat:enabled': '1' });

  const mod = await import('../src/autochat.js?sa1=1');

  const controller = mod.startAutoChat({ redis, sock: {} });
  assert.ok(controller, 'should return a controller object');
  assert.strictEqual(typeof controller.stop, 'function');

  // Stop immediately to clean up the interval.
  controller.stop();
});

test('startAutoChat returns noop when sock is null', async () => {
  const mod = await import('../src/autochat.js?sa2=1');

  const controller = mod.startAutoChat({ redis: null, sock: null });
  assert.ok(controller, 'should return a controller object');
  assert.strictEqual(typeof controller.stop, 'function');

  // Calling stop should not throw.
  controller.stop();
});
