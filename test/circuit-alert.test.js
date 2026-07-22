// Tests for the owner-alert behavior of the circuit breaker (PRD §6.3 / §6.5).
// Fully offline: ctx.llm.chat throws, ctx.redis is a fake. No real Discord / Redis / Ollama.
import { test } from 'node:test';
import assert from 'node:assert';

// Must be set BEFORE importing pipeline (OWNER_DISCORD_ID is read at module level).
process.env.OWNER_DISCORD_ID = '12345678901234567';

const ALERT_KEY = 'waifu:last_alert';

const pipeline = await import('../src/pipeline.js?alert=1');
const circuit = await import('../src/circuit.js');

/**
 * Build a fake Redis client that records `waifu:last_alert` get/set calls and
 * otherwise no-ops (so processLLM's context ops don't crash). It also persists
 * the alert key so the dedup window actually works across calls.
 */
function makeFakeRedis() {
  const store = new Map();
  const setCalls = [];
  return {
    store,
    setCalls,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, ...rest) {
      store.set(key, value);
      setCalls.push({ key, value, args: [key, value, ...rest] });
    },
    // no-op helpers used by context.js
    async lrange() {
      return [];
    },
    async lpush() {},
    async ltrim() {},
    async expire() {},
    async del() {},
  };
}

function makeThrowingCtx(fakeRedis, discordClient) {
  return {
    channelId: 'channel-123',
    isGroup: false,
    senderId: 'user-456',
    redis: fakeRedis,
    llm: {
      chat: async () => {
        throw new Error('simulated LLM failure');
      },
    },
    _discordClient: discordClient,
    channel: {
      send: async (text) => ({}),
      sendTyping: async () => {},
    },
  };
}

test('owner receives alert + waifu:last_alert set EX 900 when breaker trips', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000);

  const fakeRedis = makeFakeRedis();
  const ownerSent = [];
  const discordClient = {
    users: {
      fetch: async (id) => ({
        send: async (text) => {
          ownerSent.push({ id, text });
        },
      }),
    },
  };

  const ctx = makeThrowingCtx(fakeRedis, discordClient);
  await pipeline.processLLM('hai', ctx);

  // (a) owner Discord ID received the neutral alert
  const ownerMsg = ownerSent.find((s) => s.id === '12345678901234567');
  assert.ok(ownerMsg, 'owner should receive the alert');
  assert.match(ownerMsg.text, /Circuit breaker terbuka/);
  assert.match(ownerMsg.text, /900 detik/);
  assert.doesNotMatch(ownerMsg.text, /sayang|adek|kamu/i);

  // (b) waifu:last_alert was set with EX 900
  const alertSet = fakeRedis.setCalls.find((c) => c.key === ALERT_KEY);
  assert.ok(alertSet, 'waifu:last_alert must be set');
  assert.strictEqual(alertSet.value, '1');
  assert.deepStrictEqual(
    alertSet.args,
    [ALERT_KEY, '1', 'EX', 900],
    'set must use the 15-min (900s) EX form'
  );

  circuit.__reset();
});

test('owner alert is deduped within the 15-min window', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000);

  const fakeRedis = makeFakeRedis();
  const ownerSent = [];
  const discordClient = {
    users: {
      fetch: async (id) => ({
        send: async (text) => {
          ownerSent.push({ id, text });
        },
      }),
    },
  };

  const ctx = makeThrowingCtx(fakeRedis, discordClient);

  await pipeline.processLLM('hai', ctx);
  await pipeline.processLLM('halo', ctx);

  const ownerAlerts = ownerSent.filter((s) => s.id === '12345678901234567');
  assert.strictEqual(
    ownerAlerts.length,
    1,
    'owner alert must fire only once per 15-min window'
  );

  circuit.__reset();
});

test('no owner alert when no OWNER_DISCORD_ID configured', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000);

  delete process.env.OWNER_DISCORD_ID;
  const noOwnerPipe = await import('../src/pipeline.js?alert=noowner=1');

  const fakeRedis = makeFakeRedis();
  const ownerSent = [];
  const discordClient = {
    users: {
      fetch: async (id) => ({
        send: async (text) => {
          ownerSent.push({ id, text });
        },
      }),
    },
  };
  const ctx = makeThrowingCtx(fakeRedis, discordClient);
  await noOwnerPipe.processLLM('hai', ctx);

  assert.strictEqual(
    ownerSent.length,
    0,
    'no owner alert when owner unconfigured'
  );
  const alertSet = fakeRedis.setCalls.find((c) => c.key === ALERT_KEY);
  assert.strictEqual(alertSet, undefined, 'last_alert must not be set');

  // Restore for other tests that may follow
  process.env.OWNER_DISCORD_ID = '12345678901234567';

  circuit.__reset();
});
