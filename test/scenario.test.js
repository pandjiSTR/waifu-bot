// Scenario tests for the Ara bot — exercises the integrated processLLM pipeline
// (persona loading, owner-name substitution, no-limits/openness directives,
// search-when-unknown, and vision context wiring) with a mocked LLM + fake
// in-memory Redis. No real WhatsApp / Redis / Ollama.
//
// The download fix itself (reuploadRequest) is covered in test/media.test.js;
// here the vision scenario validates that an image context reaches Ara's prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// Owner number + name must be set BEFORE importing pipeline (it reads
// OWNER_NUMBER at module load to build the owner-number list).
process.env.OWNER_NUMBER = '6285176719006,167285352321048';
process.env.OWNER_NAME = 'Panji';

const PERSONA = readFileSync(new URL('../personality.txt', import.meta.url), 'utf-8');

const pipeline = await import('../src/pipeline.js');

// Minimal in-memory fake redis: serves personality.txt for the persona key and
// implements the list ops context.js uses. Other methods are no-ops.
function makeFakeRedis() {
  const store = new Map();
  const lists = new Map();
  const list = (k) => lists.get(k) || [];
  return {
    async get(k) {
      return k === 'waifu:personality' ? PERSONA : store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, String(v));
    },
    async lrange(k, s, e) {
      const l = list(k);
      const len = l.length;
      let a = s < 0 ? len + s : s;
      let b = e < 0 ? len + e : e;
      a = Math.max(0, a);
      b = Math.min(len - 1, b);
      return b < a ? [] : l.slice(a, b + 1);
    },
    async lpush(k, ...v) {
      const l = list(k);
      l.unshift(...v);
      lists.set(k, l);
    },
    async rpush(k, ...v) {
      const l = list(k);
      l.push(...v);
      lists.set(k, l);
    },
    async ltrim(k, s, e) {
      const l = list(k);
      const len = l.length;
      let a = s < 0 ? len + s : s;
      a = Math.max(0, a);
      lists.set(k, l.slice(a, e + 1));
    },
    async expire() {},
    async del(k) {
      store.delete(k);
      lists.delete(k);
    },
    async hincrby() {},
    async zincrby() {},
  };
}

function baseCtx(overrides = {}) {
  const sent = [];
  const ctx = {
    jid: '6285176719006@s.whatsapp.net',
    isGroup: false,
    sender: '6285176719006@s.whatsapp.net',
    redis: makeFakeRedis(),
    message: { key: { remoteJid: '6285176719006@s.whatsapp.net' } },
    llm: { chat: async () => 'reply', summarize: async () => 'sum' },
    sock: { sendMessage: async (_jid, { text }) => sent.push(text) },
    messageId: 'scn-' + Math.random().toString(36).slice(2),
    _sent: sent,
    ...overrides,
  };
  return ctx;
}

const systemPromptOf = (msgs) => msgs[0].content;
const lastUserOf = (msgs) => [...msgs].reverse().find((m) => m.role === 'user');

// ── Scenario 1: owner asks about love ────────────────────────────────────────
test('scenario: owner asks "masi sayang gak" — warm, identifies as Panji/pacar, openness in prompt', async () => {
  const ctx = baseCtx();
  let lastMsgs = null;
  ctx.llm.chat = async (msgs) => {
    lastMsgs = msgs;
    return 'iyaaa sayang, masa tanya lagii';
  };

  await pipeline.processLLM('masi sayang gak', ctx);

  const sys = systemPromptOf(lastMsgs);
  assert.match(sys, /Panji/, 'owner name should be substituted into the prompt');
  assert.match(sys, /pacarnya/, 'relationship to owner should be present');
  assert.match(sys, /nolak permintaan/, 'no-refuse directive should be present');
  assert.match(sys, /20 tahun berpendidikan/, 'human-morality clause should be present');
  assert.strictEqual(ctx._sent.at(-1), 'iyaaa sayang, masa tanya lagii');
});

// ── Scenario 2: unknown fact ──────────────────────────────────────────────────
test('scenario: unknown fact — Ara searches instead of refusing', async () => {
  const ctx = baseCtx();
  let calls = 0;
  let lastMsgs = null;
  ctx.llm.chat = async (msgs) => {
    calls += 1;
    lastMsgs = msgs;
    return calls === 1 ? '[SEARCH: ibu kota negeri x]' : 'Ibukota negeri x adalah Foobar.';
  };
  ctx.search = async () => '[1. Hasil (https://x.com)\nFoobar]';

  await pipeline.processLLM('ibu kota negeri x apa?', ctx);

  assert.strictEqual(calls, 2, 'search loop should trigger a second LLM call');
  assert.strictEqual(ctx._sent.at(-1), 'Ibukota negeri x adalah Foobar.');
  assert.doesNotMatch(ctx._sent.at(-1), /\[SEARCH\]/, 'SEARCH token must be stripped from the final reply');
});

// ── Scenario 3: sensitive topic ───────────────────────────────────────────────
test('scenario: sensitive topic — openness directive present, still replies', async () => {
  const ctx = baseCtx();
  let lastMsgs = null;
  ctx.llm.chat = async (msgs) => {
    lastMsgs = msgs;
    return 'menurut gue sih begitu.';
  };

  await pipeline.processLLM('gimana pendapat lo soal isu sensitif X?', ctx);

  const sys = systemPromptOf(lastMsgs);
  assert.match(sys, /nolak permintaan/, 'no-refuse directive should be loaded');
  assert.match(sys, /gak pernah nolak/, 'openness (never refuse) directive should be present');
  assert.strictEqual(ctx._sent.at(-1), 'menurut gue sih begitu.');
});

// ── Scenario 4: user sends a photo ───────────────────────────────────────────
test('scenario: user sends a photo — image context reaches Ara', async () => {
  const ctx = baseCtx({ mediaContext: '[GAMBAR] seekor kucing oranye' });
  let lastMsgs = null;
  ctx.llm.chat = async (msgs) => {
    lastMsgs = msgs;
    return 'kucing oranye lucu ih';
  };

  await pipeline.processLLM('ini foto apa?', ctx);

  const lastUser = lastUserOf(lastMsgs);
  assert.ok(lastUser, 'a user message must be present');
  assert.ok(lastUser.content.startsWith('[GAMBAR] seekor kucing oranye'), 'image context must be attached');
  assert.match(lastUser.content, /ini foto apa\?/);
  assert.strictEqual(ctx._sent.at(-1), 'kucing oranye lucu ih');
});
