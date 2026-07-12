// Tests for src/context.js — sliding-window context + summarization.
// Exercises both the Redis path (with a fake redis client) and the in-memory
// fallback (redis = null). The LLM summarize call is stubbed via llm's test
// seam so no network is used.
import { test, before } from 'node:test';
import assert from 'node:assert';

// Same absolute module as the one context.js imports, so the test seam applies.
const llm = await import('../src/llm.js');
llm.__setClientForTest({
  async chat() {
    return { message: { content: 'SUMMARY_OUTPUT' } };
  },
});

function createFakeRedis() {
  const lists = new Map(); // key -> Array<json string> (newest-first)
  const strs = new Map();
  return {
    async lpush(key, val) {
      const a = lists.get(key) || [];
      a.unshift(val);
      lists.set(key, a);
    },
    async ltrim(key, s, e) {
      const a = lists.get(key) || [];
      lists.set(key, a.slice(s, e + 1));
    },
    async lrange(key, s, e) {
      const a = lists.get(key) || [];
      const start = s < 0 ? a.length + s : s;
      const end = e < 0 ? a.length + e : e;
      return a.slice(start, end + 1);
    },
    async expire() {
      // no-op for the fake; TTL behaviour is not asserted here
    },
    async exists(key) {
      return lists.has(key);
    },
    async get(key) {
      return strs.has(key) ? strs.get(key) : null;
    },
    async set(key, val, ...args) {
      // Record every call so tests can inspect exact call signatures.
      this._sets.push([key, val, ...args]);
      // Support ioredis-style: set(key, val, 'EX', ttl, 'NX')
      const nx = args.includes('NX');
      if (nx && strs.has(key)) return null; // not acquired
      strs.set(key, val);
      return 'OK';
    },
    async del(key) {
      return strs.delete(key) ? 1 : 0;
    },
    _lists: lists,
    _strs: strs,
    _sets: [],
  };
}

test('addMessage + getWindow are chronological (Redis path)', async () => {
  const ctx = await import('../src/context.js');
  const redis = createFakeRedis();
  await ctx.addMessage(redis, 'u1', { sender: 'a', text: 'pertama' });
  await ctx.addMessage(redis, 'u1', { sender: 'b', text: 'kedua' });
  await ctx.addMessage(redis, 'u1', { sender: 'a', text: 'ketiga' });

  const win = await ctx.getWindow(redis, 'u1', false);
  assert.strictEqual(win.length, 3);
  assert.strictEqual(win[0].text, 'pertama');
  assert.strictEqual(win[2].text, 'ketiga');
});

test('addMessage respects the max window size (Redis path)', async () => {
  const ctx = await import('../src/context.js');
  const redis = createFakeRedis();
  for (let i = 1; i <= 35; i++) {
    await ctx.addMessage(redis, 'u2', { sender: 'a', text: `m${i}` });
  }
  const win = await ctx.getWindow(redis, 'u2', false);
  assert.strictEqual(win.length, 30); // MAX_CONTEXT_MESSAGES default
  assert.strictEqual(win[0].text, 'm6'); // oldest kept is m6
});

test('getSummary returns empty string when none stored', async () => {
  const ctx = await import('../src/context.js');
  const redis = createFakeRedis();
  assert.strictEqual(await ctx.getSummary(redis, 'nope'), '');
});

test('in-memory fallback works when redis is null', async () => {
  const ctx = await import('../src/context.js');
  await ctx.addMessage(null, 'mem1', { sender: 'a', text: 'satu' });
  await ctx.addMessage(null, 'mem1', { sender: 'b', text: 'dua' });
  const win = await ctx.getWindow(null, 'mem1', false);
  assert.strictEqual(win.length, 2);
  assert.strictEqual(win[0].text, 'satu');
  assert.strictEqual(win[1].text, 'dua');
});

test('summarizeContext trims window and stores summary (in-memory)', async () => {
  // Low MAX so we can trigger summarization without 30+ inserts.
  process.env.MAX_CONTEXT_MESSAGES = '4';
  // Summarization is OFF by default; opt in for this test (CHANGE 4 gate).
  process.env.ENABLE_CONTEXT_SUMMARY = 'true';
  const ctx = await import('../src/context.js?max4');
  for (let i = 1; i <= 4; i++) {
    await ctx.addMessage(null, 'u3', { sender: 'a', text: `m${i}` });
  }
  await ctx.summarizeContext(null, 'u3', false);

  const summary = await ctx.getSummary(null, 'u3', false);
  assert.match(summary, /SUMMARY_OUTPUT/);

  const win = await ctx.getWindow(null, 'u3', false);
  // getWindow prepends the summary as a synthetic leading entry.
  assert.strictEqual(win[0].sender, '__summary__');
  // Older half (m1,m2) dropped; newer half (m3,m4) kept.
  const kept = win.filter((m) => m.sender !== '__summary__').map((m) => m.text);
  assert.deepStrictEqual(kept, ['m3', 'm4']);
});

test('summarizeContext is a no-op below threshold (in-memory)', async () => {
  const ctx = await import('../src/context.js');
  for (let i = 1; i <= 2; i++) {
    await ctx.addMessage(null, 'u4', { sender: 'a', text: `m${i}` });
  }
  await ctx.summarizeContext(null, 'u4', false);
  assert.strictEqual(await ctx.getSummary(null, 'u4', false), '');
});

// ───────────────────────── summarization lock (Fase 8) ─────────────────────────

test('summarizeContext acquires lock, runs, then releases lock (Redis path)', async () => {
  process.env.MAX_CONTEXT_MESSAGES = '4';
  process.env.ENABLE_CONTEXT_SUMMARY = 'true';
  const ctx = await import('../src/context.js?lock1');
  const redis = createFakeRedis();

  for (let i = 1; i <= 4; i++) {
    await ctx.addMessage(redis, 'lock-u1', { sender: 'a', text: `m${i}` });
  }

  await ctx.summarizeContext(redis, 'lock-u1', false);

  // Lock should be released (key deleted) after summarization completes.
  const lockVal = await redis.get('waifu:sum_lock:lock-u1');
  assert.strictEqual(lockVal, null, 'lock key must be deleted after summarization');

  // Summary should have been stored.
  const summary = await ctx.getSummary(redis, 'lock-u1', false);
  assert.match(summary, /SUMMARY_OUTPUT/);
});

test('summarizeContext skips when lock is already held (Redis path)', async () => {
  process.env.MAX_CONTEXT_MESSAGES = '4';
  process.env.ENABLE_CONTEXT_SUMMARY = 'true';
  const ctx = await import('../src/context.js?lock2');
  const redis = createFakeRedis();

  // Pre-set the lock key so the acquire attempt returns null.
  await redis.set('waifu:sum_lock:lock-u2', '1', 'EX', 30, 'NX');

  for (let i = 1; i <= 4; i++) {
    await ctx.addMessage(redis, 'lock-u2', { sender: 'a', text: `m${i}` });
  }

  await ctx.summarizeContext(redis, 'lock-u2', false);

  // Summary should NOT have been stored (skipped).
  const summary = await ctx.getSummary(redis, 'lock-u2', false);
  assert.strictEqual(summary, '', 'summary must be empty when lock is held');
});

test('summarizeContext skips locking when redis is null (in-memory)', async () => {
  // In-memory mode should not require a lock (sequential within one process).
  process.env.MAX_CONTEXT_MESSAGES = '4';
  process.env.ENABLE_CONTEXT_SUMMARY = 'true';
  const ctx = await import('../src/context.js?lock3');
  // redis = null — no lock acquisition attempted, summarization proceeds.
  for (let i = 1; i <= 4; i++) {
    await ctx.addMessage(null, 'u5', { sender: 'a', text: `m${i}` });
  }
  await ctx.summarizeContext(null, 'u5', false);
  const summary = await ctx.getSummary(null, 'u5', false);
  assert.match(summary, /SUMMARY_OUTPUT/);
});

test('summarizeContext uses EX keyword for summary TTL (Redis path)', async () => {
  process.env.MAX_CONTEXT_MESSAGES = '30';
  process.env.ENABLE_CONTEXT_SUMMARY = 'true';
  const ctx = await import('../src/context.js?sumfix');
  const redis = createFakeRedis();

  for (let i = 0; i < 30; i++) {
    await ctx.addMessage(redis, 'u-sumfix', { sender: 'a', text: 'm' + i }, false);
  }

  await ctx.summarizeContext(redis, 'u-sumfix', false);

  const recorded = redis._sets.find(
    (s) => s[0] === 'waifu:ctx_summary:u-sumfix'
  );
  assert.ok(recorded, 'expected a redis.set call for the summary key');
  assert.strictEqual(recorded[2], 'EX', '3rd positional arg must be the EX keyword');
  assert.strictEqual(typeof recorded[3], 'number', '4th positional arg must be a numeric TTL');
});
