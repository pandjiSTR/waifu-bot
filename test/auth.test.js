// Tests for src/auth.js — JWT issuance + bcrypt password verification.
// Runs fully offline: JWT_SECRET and DASHBOARD_PASSWORD_HASH are set before
// the module is dynamically imported (auth.js reads them at module load time).
import { test, before } from 'node:test';
import assert from 'node:assert';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-key-not-for-production';
const PASSWORD = 'correct-horse-battery-staple';

let auth;

before(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  process.env.JWT_SECRET = SECRET;
  process.env.DASHBOARD_PASSWORD_HASH = hash;
  auth = await import('../src/auth.js');
});

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    end(chunk) {
      this.body += chunk ?? '';
      return this;
    },
  };
}

function makeJsonReq(obj, headers = {}) {
  const body = JSON.stringify(obj);
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
}

test('validateAuthConfig throws when JWT_SECRET is missing', async () => {
  const original = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  // Re-import a fresh copy so it reads the now-missing env var.
  const fresh = await import('../src/auth.js?no-jwt-secret');
  assert.throws(() => fresh.validateAuthConfig(), /JWT_SECRET/);
  process.env.JWT_SECRET = original;
});

test('validateAuthConfig throws when DASHBOARD_PASSWORD_HASH is missing', async () => {
  const original = process.env.DASHBOARD_PASSWORD_HASH;
  delete process.env.DASHBOARD_PASSWORD_HASH;
  const fresh = await import('../src/auth.js?no-pw-hash');
  assert.throws(() => fresh.validateAuthConfig(), /DASHBOARD_PASSWORD_HASH/);
  process.env.DASHBOARD_PASSWORD_HASH = original;
});

test('handleLogin returns 200 + JWT cookie on correct password', async () => {
  const res = makeRes();
  await auth.handleLogin(makeJsonReq({ password: PASSWORD }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.headers['Set-Cookie'][0].includes('ara_session='));
  assert.ok(res.headers['Set-Cookie'][0].includes('HttpOnly'));
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.message, 'Login successful');
  assert.ok(parsed.token && typeof parsed.token === 'string');

  // The issued token must be verifiable with the same secret.
  const decoded = jwt.verify(parsed.token, SECRET);
  assert.strictEqual(decoded.role, 'owner');
});

test('handleLogin returns 401 on wrong password', async () => {
  const res = makeRes();
  await auth.handleLogin(makeJsonReq({ password: 'wrong-password' }), res);
  assert.strictEqual(res.statusCode, 401);
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.error, 'Invalid password');
});

test('handleLogin returns 400 when password field is missing', async () => {
  const res = makeRes();
  await auth.handleLogin(makeJsonReq({}), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Password is required/);
});

test('handleLogin returns 400 on invalid JSON body', async () => {
  const res = makeRes();
  const req = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{not valid json');
    },
  };
  await auth.handleLogin(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Invalid JSON body/);
});

test('requireAuth accepts a valid Bearer token and sets req.user', async () => {
  const token = jwt.sign({ role: 'owner', iat: Math.floor(Date.now() / 1000) }, SECRET, {
    expiresIn: '7d',
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.user.role, 'owner');
});

test('requireAuth accepts a valid cookie token', async () => {
  const token = jwt.sign({ role: 'owner', iat: Math.floor(Date.now() / 1000) }, SECRET, {
    expiresIn: '7d',
  });
  const req = { headers: { cookie: `ara_session=${token}` } };
  const res = makeRes();
  let nextCalled = false;
  auth.requireAuth(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
});

test('requireAuth returns 401 when no token is present', async () => {
  const req = { headers: {} };
  const res = makeRes();
  auth.requireAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /Authentication required/);
});

test('requireAuth returns 401 on expired token', async () => {
  const token = jwt.sign({ role: 'owner' }, SECRET, { expiresIn: '-1s' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  auth.requireAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /Session expired/);
});

test('requireAuth returns 401 on tampered/invalid token', async () => {
  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  const res = makeRes();
  auth.requireAuth(req, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /Invalid token/);
});

// ───────────────────────── rate limiting (TASK 6) ─────────────────────────

function makeFakeRedisForAuth() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async incr(k) {
      const v = (parseInt(store.get(k) || '0', 10)) + 1;
      store.set(k, String(v));
      return v;
    },
    async expire() { /* no-op, TTL not asserted */ },
    async del(k) { store.delete(k); },
    _store: store,
  };
}

test('handleLogin blocks after 15 failed attempts (rate limiting)', async () => {
  const fakeRedis = makeFakeRedisForAuth();
  let statusCodes = [];

  // 15 failed attempts should return 401 (not blocked yet)
  for (let i = 0; i < 15; i++) {
    const res = makeRes();
    const req = makeJsonReq({ password: 'wrong' });
    req.redis = fakeRedis;
    await auth.handleLogin(req, res);
    statusCodes.push(res.statusCode);
  }

  // All 15 should still be 401.
  statusCodes.forEach((code, i) => {
    assert.strictEqual(code, 401, `attempt ${i + 1} should be 401, got ${code}`);
  });

  // The 16th attempt should be blocked with 429.
  const blockedRes = makeRes();
  const blockedReq = makeJsonReq({ password: 'wrong' });
  blockedReq.redis = fakeRedis;
  await auth.handleLogin(blockedReq, blockedRes);
  assert.strictEqual(blockedRes.statusCode, 429);
  assert.match(JSON.parse(blockedRes.body).error, /Too many attempts/);
});

test('handleLogin resets rate limit counter on successful login', async () => {
  const fakeRedis = makeFakeRedisForAuth();

  // A few failed attempts
  for (let i = 0; i < 5; i++) {
    const res = makeRes();
    const req = makeJsonReq({ password: 'wrong' });
    req.redis = fakeRedis;
    await auth.handleLogin(req, res);
  }

  // A successful login should clear the counter.
  const okRes = makeRes();
  const okReq = makeJsonReq({ password: PASSWORD });
  okReq.redis = fakeRedis;
  await auth.handleLogin(okReq, okRes);
  assert.strictEqual(okRes.statusCode, 200);

  // After reset, a failed attempt should NOT be blocked.
  const afterRes = makeRes();
  const afterReq = makeJsonReq({ password: 'wrong' });
  afterReq.redis = fakeRedis;
  await auth.handleLogin(afterReq, afterRes);
  assert.strictEqual(afterRes.statusCode, 401, 'should still allow after successful login');
});
