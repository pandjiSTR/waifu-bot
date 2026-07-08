// Tests for the owner-alert behavior of the circuit breaker (PRD §6.3 / §6.5).
// Fully offline: ctx.llm.chat throws, ctx.redis is a fake, ctx.sock.sendMessage
// is a mock. No real WhatsApp / Redis / Ollama.
import { test } from 'node:test';
import assert from 'node:assert';

// Must be set BEFORE importing pipeline (OWNER_NUMBERS is computed at load).
process.env.OWNER_NUMBER = '6285000000000';

const OWNER_JID = '6285000000000@s.whatsapp.net';
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

function makeThrowingCtx(fakeRedis, sock) {
  return {
    jid: 'user@s.whatsapp.net',
    isGroup: false,
    sender: 'user@s.whatsapp.net',
    redis: fakeRedis,
    llm: {
      chat: async () => {
        throw new Error('simulated LLM failure');
      },
    },
    sock,
  };
}

test('owner receives alert + waifu:last_alert set EX 900 when breaker trips', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000); // ~900s window

  const fakeRedis = makeFakeRedis();
  const sent = [];
  const sock = {
    sendMessage: async (jid, { text }) => {
      sent.push({ jid, text });
    },
  };

  const ctx = makeThrowingCtx(fakeRedis, sock);
  await pipeline.processLLM('hai', ctx);

  // (a) owner JID received the neutral alert
  const ownerMsg = sent.find((s) => s.jid === OWNER_JID);
  assert.ok(ownerMsg, 'owner should receive the alert');
  assert.match(ownerMsg.text, /Circuit breaker terbuka/);
  assert.match(ownerMsg.text, /900 detik/);
  // neutral system notice, not Ara persona voice
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

  // the user still receives the neutral fallback (early-return path)
  const userMsg = sent.find((s) => s.jid === 'user@s.whatsapp.net');
  assert.ok(userMsg, 'user should still receive the neutral fallback');
  assert.strictEqual(userMsg.text, 'lagi sibuk sebentar, coba lagi nanti');

  circuit.__reset();
});

test('owner alert is deduped within the 15-min window', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000);

  const fakeRedis = makeFakeRedis();
  const sent = [];
  const sock = {
    sendMessage: async (jid, { text }) => {
      sent.push({ jid, text });
    },
  };

  const ctx = makeThrowingCtx(fakeRedis, sock);

  // First failing turn — should alert the owner.
  await pipeline.processLLM('hai', ctx);
  // Second failing turn within the window — must NOT alert again.
  await pipeline.processLLM('halo', ctx);

  const ownerAlerts = sent.filter((s) => s.jid === OWNER_JID);
  assert.strictEqual(
    ownerAlerts.length,
    1,
    'owner alert must fire only once per 15-min window'
  );

  circuit.__reset();
});

test('no owner alert when no OWNER_NUMBER configured', async () => {
  circuit.__reset();
  circuit.__forceOpen(900000);

  // Import a pipeline variant with OWNER_NUMBER unset.
  delete process.env.OWNER_NUMBER;
  const noOwnerPipe = await import('../src/pipeline.js?alert=noowner=1');

  const fakeRedis = makeFakeRedis();
  const sent = [];
  const sock = {
    sendMessage: async (jid, { text }) => {
      sent.push({ jid, text });
    },
  };
  const ctx = makeThrowingCtx(fakeRedis, sock);
  await noOwnerPipe.processLLM('hai', ctx);

  assert.strictEqual(
    sent.some((s) => s.jid === OWNER_JID),
    false,
    'no owner alert when owner unconfigured'
  );
  const alertSet = fakeRedis.setCalls.find((c) => c.key === ALERT_KEY);
  assert.strictEqual(alertSet, undefined, 'last_alert must not be set');

  circuit.__reset();
});
