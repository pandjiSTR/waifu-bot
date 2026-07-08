// Tests for src/api-skeleton.js — empty data fallback (T10) and handler structure.
// Uses mock req/res objects with Redis returning empty data.
import { test } from 'node:test';
import assert from 'node:assert';

function createMockRedis() {
  const store = new Map();
  return {
    async get(key) { return null; },
    async set() { return 'OK'; },
    async del() { return 0; },
    async hgetall() { return {}; },
    async hincrby() { return 1; },
    async lrange() { return []; },
    async lpush() { return 1; },
    async ltrim() { return 'OK'; },
    async keys() { return []; },
    async zscore() { return null; },
    async zincrby() { return 1; },
    async zadd() { return 1; },
    async expire() { return 1; },
    _store: store,
  };
}

function createMockReq(opts = {}) {
  return {
    params: opts.params || {},
    url: opts.url || '/',
    redis: opts.redis || null,
    headers: opts.headers || { host: 'localhost' },
    method: opts.method || 'GET',
    _body: opts.body || null,
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

function parseResJson(res) {
  const endCall = res._calls.find(c => c.type === 'end');
  if (!endCall) return null;
  try { return JSON.parse(endCall.data); } catch { return null; }
}

function getResStatus(res) {
  const wh = res._calls.find(c => c.type === 'writeHead');
  return wh ? wh.statusCode : null;
}

// ─────────────────────────── handleGetTrend (T10) ───────────────────────────

test('handleGetTrend returns full day range when Redis has no data', async () => {
  const { handleGetTrend } = await import('../src/api-skeleton.js?t10_trend=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/analytics/trend?range=7d', redis });
  const res = createMockRes();

  await handleGetTrend(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.trend, 'trend array should exist');
  assert.strictEqual(body.trend.length, 7, 'should have 7 days for 7d range');
  body.trend.forEach((day) => {
    assert.ok(day.date, 'each day should have a date');
    assert.strictEqual(day.sent, 0, 'sent should be 0');
    assert.strictEqual(day.received, 0, 'received should be 0');
    assert.strictEqual(day.tokens, 0, 'tokens should be 0');
  });
});

test('handleGetTrend returns 30 days for 30d range', async () => {
  const { handleGetTrend } = await import('../src/api-skeleton.js?t10_trend30=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/analytics/trend?range=30d', redis });
  const res = createMockRes();

  await handleGetTrend(req, res);

  const body = parseResJson(res);
  assert.strictEqual(body.trend.length, 30);
});

// ─────────────────────────── handleGetHourly (T10) ───────────────────────────

test('handleGetHourly returns 24 slots with zeros when Redis has no data', async () => {
  const { handleGetHourly } = await import('../src/api-skeleton.js?t10_hourly=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/analytics/hourly', redis });
  const res = createMockRes();

  await handleGetHourly(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.hours, 'hours array should exist');
  assert.strictEqual(body.hours.length, 24, 'should have 24 slots');
  body.hours.forEach((slot, i) => {
    assert.strictEqual(slot.hour, i, `hour ${i} should be ${i}`);
    assert.strictEqual(slot.count, 0, `hour ${i} count should be 0`);
  });
});

// ─────────────────────────── handleGetMessages (T10) ───────────────────────────

test('handleGetMessages returns 7 days with zeros when Redis has no data', async () => {
  const { handleGetMessages } = await import('../src/api-skeleton.js?t10_msgs=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/messages', redis });
  const res = createMockRes();

  await handleGetMessages(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.days, 'days array should exist');
  assert.strictEqual(body.days.length, 7, 'should have 7 days');
  body.days.forEach((day) => {
    assert.ok(day.date, 'each day should have a date');
    assert.strictEqual(day.sent, 0, 'sent should be 0');
    assert.strictEqual(day.received, 0, 'received should be 0');
  });
});

// ─────────────────────────── handleGetTodayOverview (T10) ───────────────────────────

test('handleGetTodayOverview returns default stats when Redis has no data', async () => {
  const { handleGetTodayOverview } = await import('../src/api-skeleton.js?t10_today=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/overview/today', redis });
  const res = createMockRes();

  await handleGetTodayOverview(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.today, 'today object should exist');
  assert.strictEqual(body.today.messages, 0);
  assert.strictEqual(body.today.activeUsers, 0);
  assert.strictEqual(body.today.llmCalls, 0);
  assert.strictEqual(body.today.tokens, 0);
  assert.strictEqual(body.today.autoChat, 0);
});

// ─────────────────────────── handleGetTopFriends (T10) ───────────────────────────

test('handleGetTopFriends returns empty array when Redis has no data', async () => {
  const { handleGetTopFriends } = await import('../src/api-skeleton.js?t10_topf=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/analytics/top-friends', redis });
  const res = createMockRes();

  await handleGetTopFriends(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(Array.isArray(body.topFriends), 'topFriends should be an array');
  assert.strictEqual(body.topFriends.length, 0, 'should be empty');
});

// ─────────────────────────── handleGetLogs (T10) ───────────────────────────

test('handleGetLogs returns empty array when Redis has no data', async () => {
  const { handleGetLogs } = await import('../src/api-skeleton.js?t10_logs=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/logs', redis });
  const res = createMockRes();

  await handleGetLogs(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(Array.isArray(body.logs), 'logs should be an array');
  assert.strictEqual(body.logs.length, 0, 'logs should be empty');
});

test('handleGetLogs returns logs array (not null) even without Redis', async () => {
  const { handleGetLogs } = await import('../src/api-skeleton.js?t10_logs2=1');
  const req = createMockReq({ url: '/api/logs', redis: null });
  const res = createMockRes();

  await handleGetLogs(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(Array.isArray(body.logs), 'logs should be an array');
});

// ─────────────────────────── handleGetContacts (T10) ───────────────────────────

test('handleGetContacts returns empty array when Redis has no keys', async () => {
  const { handleGetContacts } = await import('../src/api-skeleton.js?t10_contacts=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/chat/contacts', redis });
  const res = createMockRes();

  await handleGetContacts(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(Array.isArray(body.contacts), 'contacts should be an array');
  assert.strictEqual(body.contacts.length, 0, 'contacts should be empty');
});

// ─────────────────────────── handleGetContext (T10) ───────────────────────────

test('handleGetContext returns empty context array when Redis has no data', async () => {
  const { handleGetContext } = await import('../src/api-skeleton.js?t10_ctx=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/chat/context?number=628xxx', redis });
  const res = createMockRes();

  await handleGetContext(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  assert.ok(body.number, 'should include number');
  assert.ok(Array.isArray(body.context), 'context should be an array');
  assert.strictEqual(body.context.length, 0, 'context should be empty');
});

// ─────────────────────────── handleGetSettings (T10) ───────────────────────────

test('handleGetSettings returns defaults when Redis has no data', async () => {
  const { handleGetSettings } = await import('../src/api-skeleton.js?t10_settings=1');
  const redis = createMockRedis();
  const req = createMockReq({ url: '/api/settings', redis });
  const res = createMockRes();

  await handleGetSettings(req, res);

  assert.strictEqual(getResStatus(res), 200);
  const body = parseResJson(res);
  // Should have autoChat and circuitBreakerEnabled defaults
  assert.strictEqual(typeof body.autoChat, 'boolean');
  assert.strictEqual(typeof body.circuitBreakerEnabled, 'boolean');
});
