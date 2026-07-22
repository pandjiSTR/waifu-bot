// Tests for src/chunks.js — chunk splitting + reliable delivery.
// Fully offline: sendMessage is a fake that records calls (and can fail).
import { test } from 'node:test';
import assert from 'node:assert';
import { splitChunks, sendChunks } from '../src/chunks.js';

// ───────────────────────── splitChunks (pure) ─────────────────────────

test('splitChunks returns the whole text when under the limit', () => {
  assert.deepStrictEqual(splitChunks('short reply'), ['short reply']);
});

test('splitChunks returns at least one chunk for empty input', () => {
  assert.deepStrictEqual(splitChunks(''), ['']);
});

test('splitChunks respects maxChars', () => {
  const chunks = splitChunks('abcdefghij', 5);
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(c.length <= 5);
});

test('splitChunks breaks on spaces (never mid-word for normal text)', () => {
  assert.deepStrictEqual(splitChunks('hello world foo', 5), ['hello', 'world', 'foo']);
});

test('splitChunks breaks on newlines', () => {
  assert.deepStrictEqual(splitChunks('aaa\nbbbbb', 5), ['aaa', 'bbbbb']);
});

test('splitChunks keeps words intact (no mid-word split on normal text)', () => {
  const chunks = splitChunks('the quick brown fox', 9);
  // Reassembling all words must reproduce the original word list.
  assert.deepStrictEqual(chunks.join(' ').split(/\s+/), [
    'the', 'quick', 'brown', 'fox',
  ]);
});

test('splitChunks hard-truncates a single word longer than maxChars', () => {
  const word = 'supercalifragilistic';
  const chunks = splitChunks(word, 5);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.strictEqual(c.length, 5);
  assert.strictEqual(chunks.join(''), word); // content preserved exactly
});

// ───────────────────────── sendChunks (delivery) ─────────────────────────

test('sendChunks sends each chunk in order via the channel', async () => {
  const sent = [];
  const channel = {
    send: async (text) => {
      sent.push(text);
    },
  };
  const res = await sendChunks(channel, 'hello world foo', {
    maxChars: 5,
    delayMs: 0,
  });
  assert.deepStrictEqual(sent, ['hello', 'world', 'foo']);
  assert.deepStrictEqual(res, { sent: 3, total: 3, failed: false, ids: [] });
});

test('sendChunks retries a failing chunk then succeeds', async () => {
  const calls = [];
  const channel = {
    send: async (text) => {
      calls.push(text);
      if (calls.filter((c) => c === text).length === 1 && text === 'world') {
        throw new Error('transient');
      }
    },
  };
  const res = await sendChunks(channel, 'hello world foo', {
    maxChars: 5,
    delayMs: 0,
    backoffBaseMs: 1,
  });
  assert.strictEqual(calls.filter((c) => c === 'hello').length, 1);
  assert.strictEqual(calls.filter((c) => c === 'world').length, 2);
  assert.strictEqual(calls.filter((c) => c === 'foo').length, 1);
  assert.strictEqual(res.sent, 3);
  assert.strictEqual(res.failed, false);
});

test('sendChunks stops after a chunk exhausts retries and reports failure', async () => {
  const sent = [];
  const channel = {
    send: async (text) => {
      sent.push(text);
      throw new Error('always fails');
    },
  };
  const res = await sendChunks(channel, 'hello world foo', {
    maxChars: 5,
    delayMs: 0,
    backoffBaseMs: 1,
    maxAttempts: 2,
  });
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.failed, true);
});

test('sendChunks no-ops gracefully when channel is null', async () => {
  const res = await sendChunks(null, 'hello world', { maxChars: 5 });
  assert.deepStrictEqual(res, { sent: 0, total: 2, failed: false, ids: [] });
});

// T8: CHUNK_SEND_RETRY env var
test('DEFAULT_MAX_ATTEMPTS respects CHUNK_SEND_RETRY env var', async () => {
  const orig = process.env.CHUNK_SEND_RETRY;
  process.env.CHUNK_SEND_RETRY = '5';
  const mod = await import('../src/chunks.js?csr1=1');
  assert.strictEqual(mod.DEFAULT_MAX_ATTEMPTS, 5);
  process.env.CHUNK_SEND_RETRY = orig;
});

test('DEFAULT_MAX_ATTEMPTS defaults to 3 when env not set', async () => {
  delete process.env.CHUNK_SEND_RETRY;
  const mod = await import('../src/chunks.js?csr2=1');
  assert.strictEqual(mod.DEFAULT_MAX_ATTEMPTS, 3);
});

test('DEFAULT_MAX_ATTEMPTS handles invalid env value gracefully', async () => {
  const orig = process.env.CHUNK_SEND_RETRY;
  process.env.CHUNK_SEND_RETRY = 'not-a-number';
  const mod = await import('../src/chunks.js?csr3=1');
  assert.strictEqual(mod.DEFAULT_MAX_ATTEMPTS, 3);
  process.env.CHUNK_SEND_RETRY = orig;
});
