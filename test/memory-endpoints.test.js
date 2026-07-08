// Tests for src/api-skeleton.js friend memory endpoint handlers.
// Uses mock req/res objects and a Map-backed mock redis.
import { test } from 'node:test';
import assert from 'node:assert';

function createMockRedis() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, val) { store.set(key, val); return 'OK'; },
    async del(key) { return store.delete(key) ? 1 : 0; },
    _store: store,
  };
}

function createMockReq(opts = {}) {
  return {
    params: opts.params || {},
    url: opts.url || '/api/friends/test-user/memory',
    redis: opts.redis || null,
    headers: opts.headers || {},
    method: opts.method || 'GET',
    // For readBody support
    _body: opts.body || null,
    _bodyRead: false,
    [Symbol.asyncIterator]() {
      const self = this;
      let done = false;
      return {
        next() {
          if (!done && self._body !== null) {
            done = true;
            return Promise.resolve({ value: self._body, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function createMockRes() {
  const calls = [];
  return {
    _calls: calls,
    writeHead(statusCode, headers) {
      calls.push({ type: 'writeHead', statusCode, headers });
    },
    end(data) {
      calls.push({ type: 'end', data: typeof data === 'string' ? data : String(data) });
    },
  };
}

// Helper to parse the JSON string from the end() call
function parseResJson(res) {
  const endCall = res._calls.find(c => c.type === 'end');
  if (!endCall) return null;
  try {
    return JSON.parse(endCall.data);
  } catch {
    return null;
  }
}

function getResStatus(res) {
  const wh = res._calls.find(c => c.type === 'writeHead');
  return wh ? wh.statusCode : null;
}

// ─────────────────────────── handleGetFriendMemory ───────────────────────────

test('GET /api/friends/:userId/memory returns defaults for unknown user', async () => {
  const { handleGetFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  const req = createMockReq({ params: { userId: 'unknown-user' }, redis });
  const res = createMockRes();

  await handleGetFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.deepStrictEqual(body, { facts: [], mood: null, moodUpdatedAt: null });
});

test('GET /api/friends/:userId/memory returns stored data', async () => {
  const { handleGetFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  await redis.set(
    'waifu:friend:u1',
    JSON.stringify({ facts: ['likes cats', 'hates spam'], mood: 'happy', moodUpdatedAt: 1000 }),
  );
  const req = createMockReq({ params: { userId: 'u1' }, redis });
  const res = createMockRes();

  await handleGetFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.deepStrictEqual(body, {
    facts: ['likes cats', 'hates spam'],
    mood: 'happy',
    moodUpdatedAt: 1000,
  });
});

test('GET /api/friends/:userId/memory returns 400 when userId missing', async () => {
  const { handleGetFriendMemory } = await import('../src/api-skeleton.js');
  // url with too few segments so split('/')[3] is undefined
  const req = createMockReq({ params: {}, url: '/api/friends' });
  const res = createMockRes();

  await handleGetFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 400);
  const body = parseResJson(res);
  assert.ok(body.error);
  assert.ok(body.error.includes('userId'));
});

test('GET /api/friends/:userId/memory handles null redis', async () => {
  const { handleGetFriendMemory } = await import('../src/api-skeleton.js');
  const req = createMockReq({ params: { userId: 'no-redis-user' }, redis: null });
  const res = createMockRes();

  await handleGetFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.deepStrictEqual(body, { facts: [], mood: null, moodUpdatedAt: null });
});

// ─────────────────────────── handleUpdateFriendMemory ───────────────────────────

test('PUT /api/friends/:userId/memory updates facts', async () => {
  const { handleUpdateFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  const bodyJson = JSON.stringify({ facts: ['likes sushi', 'hates rain'] });
  const req = createMockReq({ params: { userId: 'u-facts' }, redis, body: bodyJson, method: 'PUT' });
  const res = createMockRes();

  await handleUpdateFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.message);
  assert.ok(body.memory);
  assert.deepStrictEqual(body.memory.facts, ['likes sushi', 'hates rain']);
});

test('PUT /api/friends/:userId/memory updates mood', async () => {
  const { handleUpdateFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  const bodyJson = JSON.stringify({ mood: 'excited' });
  const req = createMockReq({ params: { userId: 'u-mood' }, redis, body: bodyJson, method: 'PUT' });
  const res = createMockRes();

  await handleUpdateFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.memory);
  assert.strictEqual(body.memory.mood, 'excited');
  assert.ok(typeof body.memory.moodUpdatedAt === 'number');
});

test('PUT /api/friends/:userId/memory updates both facts and mood', async () => {
  const { handleUpdateFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  const bodyJson = JSON.stringify({ facts: ['fact one'], mood: 'happy' });
  const req = createMockReq({ params: { userId: 'u-both' }, redis, body: bodyJson, method: 'PUT' });
  const res = createMockRes();

  await handleUpdateFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.strictEqual(body.memory.mood, 'happy');
  assert.deepStrictEqual(body.memory.facts, ['fact one']);
});

test('PUT /api/friends/:userId/memory returns 400 when userId missing', async () => {
  const { handleUpdateFriendMemory } = await import('../src/api-skeleton.js');
  const req = createMockReq({ params: {}, url: '/api/friends', body: JSON.stringify({ mood: 'ok' }), method: 'PUT' });
  const res = createMockRes();

  await handleUpdateFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 400);
  const body = parseResJson(res);
  assert.ok(body.error);
});

test('PUT /api/friends/:userId/memory handles empty facts array', async () => {
  const { handleUpdateFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  // First add a fact
  await redis.set('waifu:friend:u-empty', JSON.stringify({ facts: ['existing fact'], mood: null, moodUpdatedAt: null }));
  // Then send empty facts array - should keep original (addFact only adds, doesn't replace)
  const bodyJson = JSON.stringify({ facts: [] });
  const req = createMockReq({ params: { userId: 'u-empty' }, redis, body: bodyJson, method: 'PUT' });
  const res = createMockRes();

  await handleUpdateFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  // addFact with empty array does nothing, so existing facts remain
  assert.deepStrictEqual(body.memory.facts, ['existing fact']);
});

// ─────────────────────────── handleClearFriendMemory ───────────────────────────

test('DELETE /api/friends/:userId/memory clears memory', async () => {
  const { handleClearFriendMemory, handleGetFriendMemory } = await import('../src/api-skeleton.js');
  const redis = createMockRedis();
  // Seed some data
  await redis.set('waifu:friend:u-clear', JSON.stringify({ facts: ['secret'], mood: 'sad', moodUpdatedAt: 100 }));

  const delReq = createMockReq({ params: { userId: 'u-clear' }, redis, method: 'DELETE' });
  const delRes = createMockRes();

  await handleClearFriendMemory(delReq, delRes);

  assert.strictEqual(getResStatus(delRes), 200);
  const body = parseResJson(delRes);
  assert.ok(body.message);

  // Verify memory is cleared
  const getReq = createMockReq({ params: { userId: 'u-clear' }, redis });
  const getRes = createMockRes();
  await handleGetFriendMemory(getReq, getRes);

  const getBody = parseResJson(getRes);
  assert.deepStrictEqual(getBody, { facts: [], mood: null, moodUpdatedAt: null });
});

test('DELETE /api/friends/:userId/memory returns 400 when userId missing', async () => {
  const { handleClearFriendMemory } = await import('../src/api-skeleton.js');
  const req = createMockReq({ params: {}, url: '/api/friends', method: 'DELETE' });
  const res = createMockRes();

  await handleClearFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 400);
  const body = parseResJson(res);
  assert.ok(body.error);
});

test('DELETE /api/friends/:userId/memory handles null redis', async () => {
  const { handleClearFriendMemory } = await import('../src/api-skeleton.js');
  const req = createMockReq({ params: { userId: 'no-redis' }, redis: null, method: 'DELETE' });
  const res = createMockRes();

  // Should not throw
  await handleClearFriendMemory(req, res);

  assert.strictEqual(getResStatus(res), 200);
});
