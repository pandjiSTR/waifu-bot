// Tests for src/gatekeeper.js — Discord-specific shouldProcess logic.
// No real Redis / Discord connections.
import { test, after } from 'node:test';
import assert from 'node:assert';

const gk = await import('../src/gatekeeper.js');
const { stopSweeper } = gk;

function makeCtx(overrides = {}) {
  return {
    senderId: 'user123456',
    channelId: 'channel-123',
    isGroup: false,
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    message: {
      content: 'halo',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
    redis: null,
    ...overrides,
  };
}

// ───────────────────────── extractText ─────────────────────────

test('extractText reads message content', () => {
  const m = { content: 'halo ara' };
  assert.strictEqual(gk.extractText(m), 'halo ara');
});

test('extractText strips null bytes and trims', () => {
  const m = { content: '  hai \u0000  ' };
  assert.strictEqual(gk.extractText(m), 'hai');
});

test('extractText returns null for empty content', () => {
  const m = {};
  assert.strictEqual(gk.extractText(m), null);
});

test('extractText returns null when content is missing', () => {
  const m = { content: undefined };
  assert.strictEqual(gk.extractText(m), null);
});

// T2: 2000-char input cap
test('extractText truncates input to 2000 characters', () => {
  const long = 'x'.repeat(3000);
  const m = { content: long };
  const result = gk.extractText(m);
  assert.strictEqual(result.length, 2000);
  assert.strictEqual(result, 'x'.repeat(2000));
});

// ───────────────────────── shouldProcess — DM ─────────────────────────

test('shouldProcess always replies in DM', async () => {
  const ctx = makeCtx({ isGroup: false });
  assert.strictEqual(await gk.shouldProcess('apa kabar?', ctx), true);
});

test('shouldProcess replies in DM even without mention', async () => {
  const ctx = makeCtx({ isGroup: false, message: { content: 'hai', author: { id: 'user123' }, client: { user: { id: 'ara-bot-id' } } } });
  assert.strictEqual(await gk.shouldProcess('hai', ctx), true);
});

test('shouldProcess replies in DM with empty content fallback', async () => {
  const ctx = makeCtx({ isGroup: false });
  assert.strictEqual(await gk.shouldProcess('', ctx), true);
});

// ───────────────────────── shouldProcess — duplicate ─────────────────────────

test('shouldProcess rejects duplicate message ids', async () => {
  const ctx = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await gk.shouldProcess('halo', ctx), true);
  const ctx2 = makeCtx({ messageId: 'dup-1' });
  assert.strictEqual(await gk.shouldProcess('halo', ctx2), false);
});

// ───────────────────────── shouldProcess — group/guild ─────────────────────────

test('shouldProcess rejects group messages without mention/prefix/ara', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
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
    message: {
      content: '<@ara-bot-id> halo',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('<@ara-bot-id> halo', ctx), true);
});

test('shouldProcess allows group message containing the "ara" keyword', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    message: {
      content: 'ara ceritakan jokes',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('ara ceritakan jokes', ctx), true);
});

test('shouldProcess allows group message with command prefix', async () => {
  process.env.COMMAND_PREFIX = '!ara';
  const gkP = await import('../src/gatekeeper.js?prefix1=1');
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    message: {
      content: '!ara status',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gkP.shouldProcess('!ara status', ctx), true);
});

test('shouldProcess rejects false prefix "arah/arab/arak/aray" in group', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
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

test('shouldProcess allows bot mention with extra text in group', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    message: {
      content: '<@ara-bot-id> apa kabar?',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('<@ara-bot-id> apa kabar?', ctx), true);
});

test('shouldProcess allows just "ara" in group', async () => {
  const ctx = makeCtx({
    isGroup: true,
    channelId: 'guild-channel-123',
    senderId: 'user123456',
    message: {
      content: 'Ara',
      author: { id: 'user123456' },
      client: { user: { id: 'ara-bot-id' } },
    },
  });
  assert.strictEqual(await gk.shouldProcess('Ara', ctx), true);
});

// ───────────────────────── shouldProcess — badword ─────────────────────────

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

// ───────────────────────── blacklist / whitelist ─────────────────────────

test('shouldProcess rejects blacklisted senders', async () => {
  const gkB = await import('../src/gatekeeper.js?gatebl=1');
  gkB.setBlacklist(['user111111']);
  const ctx = makeCtx({ senderId: 'user111111' });
  assert.strictEqual(await gkB.shouldProcess('halo', ctx), false);
  const ok = makeCtx({ senderId: 'user222222' });
  assert.strictEqual(await gkB.shouldProcess('halo', ok), true);
  gkB.stopSweeper();
});

test('shouldProcess enforces whitelist (listed only)', async () => {
  process.env.WHITELIST = 'user222222';
  const gkW = await import('../src/gatekeeper.js?gatewl=1');
  const blocked = makeCtx({ senderId: 'user333333' });
  assert.strictEqual(await gkW.shouldProcess('halo', blocked), false);
  const listed = makeCtx({ senderId: 'user222222' });
  assert.strictEqual(await gkW.shouldProcess('halo', listed), true);
  gkW.stopSweeper();
});

// ───────────────────────── loadBlacklist / setBlacklist ─────────────────────────

test('loadBlacklist reads from Redis', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const fakeRedis = {
    get: async (key) => {
      assert.strictEqual(key, 'waifu:settings:misc');
      return '{"blacklist":"123,456"}';
    },
  };
  const p = await import('../src/gatekeeper.js?loadblgk=1');
  await p.loadBlacklist(fakeRedis);
  const blocked = makeCtx({ senderId: '123' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ senderId: '789' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

test('setBlacklist updates in-memory list', async () => {
  delete process.env.BLACKLIST;
  delete process.env.WHITELIST;
  delete process.env.OWNER_NUMBER;
  const p = await import('../src/gatekeeper.js?sblgk=1');
  p.setBlacklist(['111', '222']);
  const blocked = makeCtx({ senderId: '111' });
  assert.strictEqual(await p.shouldProcess('halo', blocked), false);
  const allowed = makeCtx({ senderId: '333' });
  assert.strictEqual(await p.shouldProcess('halo', allowed), true);
  p.stopSweeper();
});

// ───────────────────────── stopSweeper ─────────────────────────

test('stopSweeper exists and does not throw', () => {
  assert.strictEqual(typeof stopSweeper, 'function');
});

after(() => {
  stopSweeper();
});
